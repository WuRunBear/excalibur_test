/**
 * 日志流服务（S1-C）。
 *
 * 两路日志汇聚到每角色 500 行环形缓冲：
 * 1. 日志文件 tail：本体 winston 写 <GAME_ROOT>/logs/game.log（cwd 相对）。
 *    自实现增量读取：fs.watch 监听日志目录 + 1s 轮询兜底，按字节 offset 追读；
 *    文件被截断 / 轮转（size < offset）时重置 offset；文件不存在时容错等待，
 *    由后续 watch/poll 事件恢复。S1 双实例 cwd 均为 GAME_ROOT，无法按行归属实例，
 *    同一行推给两个 role 频道，source 标记 'file'。
 * 2. 进程 stdout/stderr：instanceManager 按行拆分后回调进来，
 *    source 标记 'stdout' | 'stderr'，路由到对应 role 频道。
 *
 * 日志消息结构：{ role, source, level?, text, ts }；level 由行文本启发式提取
 * （info/warn/error/debug 关键字），提取不到为 undefined。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'

import { defaultGameContext, type GameContext } from '../gameContext.js'
import { toHolder } from './workspaceService.js'
import type { ContextHolder } from './index.js'
import type { InstanceRole, LogMessage, LogSource, ProcessSource } from '../types.js'

/** 环形缓冲容量。 */
const RING_CAPACITY = 500
/** 文件增量读取的轮询兜底间隔（fs.watch 在某些场景会丢事件）。 */
const POLL_INTERVAL_MS = 1_000

/** 剥离 ANSI 转义序列（winston console 着色、tsx 输出等）。 */
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

/** 从行文本启发式提取日志级别；提取不到返回 undefined。 */
function detectLevel(line: string): string | undefined {
  const m = /\b(info|warn(?:ing)?|error|err|debug)\b/i.exec(line)
  if (!m) return undefined
  const level = m[1].toLowerCase()
  if (level === 'warning') return 'warn'
  if (level === 'err') return 'error'
  return level
}

/** 定容 FIFO 环形缓冲。 */
class RingBuffer {
  private readonly buf: LogMessage[] = []

  push(msg: LogMessage): void {
    this.buf.push(msg)
    if (this.buf.length > RING_CAPACITY) {
      this.buf.splice(0, this.buf.length - RING_CAPACITY)
    }
  }

  /** 最近 n 条（n 超过容量时返回全部）。 */
  recent(n: number): LogMessage[] {
    return this.buf.slice(-n)
  }
}

type LogListener = (msg: LogMessage) => void

const ROLES: readonly InstanceRole[] = ['official', 'preview']

/** 构造参数（T2.4 per-game 实例化）。 */
export interface LogStreamServiceOptions {
  /** 游戏上下文（或容器 contextHolder）：gameLogsDir/gameLogFile 的出处。 */
  context: GameContext | ContextHolder
}

/**
 * 日志流服务：文件 tail + 进程行 → 环形缓冲 → 订阅者（index.ts 接 wsHub 广播）。
 * T2.4：每游戏一个实例，文件路径取自各自 context（每次 stat/open 时点读取，
 * 容器 context 热更新自动生效）。
 */
export class LogStreamService {
  private readonly holder: ContextHolder

  constructor(options: LogStreamServiceOptions) {
    this.holder = toHolder(options.context)
  }

  /** 当前上下文（容器热更新后自动生效）。 */
  private get ctx(): GameContext {
    return this.holder.current
  }

  private readonly rings: Record<InstanceRole, RingBuffer> = {
    official: new RingBuffer(),
    preview: new RingBuffer(),
  }
  private readonly listeners = new Set<LogListener>()

  private watcher: fs.FSWatcher | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private running = false

  /** 文件已消费的字节偏移。 */
  private fileOffset = 0
  /** 文件尾部的半行缓冲。 */
  private filePartial = ''
  /** pump 重入保护。 */
  private pumping = false

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  /** 启动文件 tail（幂等）。初始 offset 定位到当前文件末尾，只流式转发新行。 */
  start(): void {
    if (this.running) return
    this.running = true
    void this.bootstrapOffset()
    this.ensureWatcher()
    this.pollTimer = setInterval(() => {
      this.ensureWatcher()
      void this.pump()
    }, POLL_INTERVAL_MS)
  }

  /** 停止 tail（测试 / 优雅退出用）。 */
  stop(): void {
    this.running = false
    this.watcher?.close()
    this.watcher = null
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  /** 初始 offset：文件已存在则定位到末尾（只转发新行），不存在则从头等待。 */
  private async bootstrapOffset(): Promise<void> {
    try {
      const st = await fsp.stat(this.ctx.gameLogFile)
      this.fileOffset = st.isFile() ? st.size : 0
    } catch {
      this.fileOffset = 0
    }
  }

  // ---------------------------------------------------------------------------
  // 订阅 / 查询
  // ---------------------------------------------------------------------------

  /** 注册日志回调（每条消息一次），返回取消订阅函数。 */
  onLog(cb: LogListener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** 取某角色最近 N 行（N 夹取到 [1, 500]，供 REST 回填）。 */
  getRecent(role: InstanceRole, lines: number): LogMessage[] {
    const n = Number.isFinite(lines) ? Math.floor(lines) : 200
    const clamped = Math.min(RING_CAPACITY, Math.max(1, n))
    return this.rings[role].recent(clamped)
  }

  // ---------------------------------------------------------------------------
  // 入口
  // ---------------------------------------------------------------------------

  /** instanceManager 行回调入口：进程 stdout/stderr 行 → 对应角色频道。 */
  ingestProcessLine(role: InstanceRole, source: ProcessSource, rawLine: string): void {
    const text = stripAnsi(rawLine)
    if (!text.trim()) return
    this.emit({ role, source, level: detectLevel(text), text, ts: Date.now() })
  }

  /** 文件行入口：同一行推给两个角色频道，source = 'file'。 */
  private ingestFileLine(rawLine: string): void {
    const text = stripAnsi(rawLine).replace(/\r$/, '')
    if (!text.trim()) return
    const ts = Date.now()
    const level = detectLevel(text)
    for (const role of ROLES) {
      this.emit({ role, source: 'file' satisfies LogSource, level, text, ts })
    }
  }

  private emit(msg: LogMessage): void {
    this.rings[msg.role].push(msg)
    for (const cb of this.listeners) {
      try {
        cb(msg)
      } catch (err) {
        console.error('[logStream] listener failed:', err)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 文件 tail 实现
  // ---------------------------------------------------------------------------

  /** 监听日志目录（目录不存在时静默失败，交给轮询兜底重试）。 */
  private ensureWatcher(): void {
    if (this.watcher) return
    try {
      this.watcher = fs.watch(this.ctx.gameLogsDir, { persistent: false }, (_event, filename) => {
        // filename 在部分平台为 null，无法区分时一律尝试 pump（幂等）。
        if (!filename || filename === 'game.log') void this.pump()
      })
      this.watcher.on('error', () => {
        this.watcher?.close()
        this.watcher = null
      })
    } catch {
      // 目录尚不存在：轮询会在其创建后再次尝试。
    }
  }

  /**
   * 增量读取日志文件：从 fileOffset 追加读到当前 size。
   * - 文件不存在 → 重置 offset（等待重建）；
   * - size < offset → 判定截断/轮转 → 重置 offset 全量重读；
   * - 无新字节 → 直接返回。
   */
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      const st = await fsp.stat(this.ctx.gameLogFile).catch(() => null)
      if (!st || !st.isFile()) {
        // 文件被移走 / 尚未创建：重置状态，等待下次事件（winston 重建文件）。
        this.fileOffset = 0
        this.filePartial = ''
        return
      }
      if (st.size < this.fileOffset) {
        // 截断 / 轮转：从头重读。
        this.fileOffset = 0
        this.filePartial = ''
      }
      if (st.size === this.fileOffset) return

      const length = st.size - this.fileOffset
      const fh = await fsp.open(this.ctx.gameLogFile, 'r')
      try {
        const buffer = Buffer.allocUnsafe(length)
        const { bytesRead } = await fh.read(buffer, 0, length, this.fileOffset)
        this.fileOffset += bytesRead
        const merged = this.filePartial + buffer.subarray(0, bytesRead).toString('utf8')
        const parts = merged.split('\n')
        // 最后一段是尚未写完的半行，留待下次拼接；其余为完整行。
        this.filePartial = parts.pop() ?? ''
        for (const line of parts) this.ingestFileLine(line)
      } finally {
        await fh.close()
      }
    } catch (err) {
      console.error('[logStream] pump failed:', err)
    } finally {
      this.pumping = false
    }
  }
}

/**
 * 日志流单例（compat 壳，T2.4）：绑定 defaultGameContext（≡ forGame('gst') 语义，
 * tail <GAME_ROOT>/logs/game.log）。per-game 实例经 servicesFor(gameId).log 获取
 * （T2.7 接线），本单例保证过渡期行为连续。
 */
export const logStream = new LogStreamService({ context: defaultGameContext })
