/**
 * 双实例进程管理器（S1-C）。
 *
 * 职责：
 * - 以 GAME_ROOT 为 cwd 拉起 `pnpm dev`（本体游戏，tsx watch src/index.ts），
 *   official / preview 各一个独立状态机：stopped → starting → running →（crashed | stopped）。
 * - 跨平台：
 *   - win32：spawn('pnpm.cmd', ['dev'], { shell: true })；停止用 taskkill /PID <pid> /T /F 树杀。
 *   - posix：spawn('pnpm', ['dev'], { detached: true })（子进程成为进程组组长）；
 *     停止用 process.kill(-pid, 'SIGTERM') 杀整组，5s 未退出升级 SIGKILL。
 * - 退出归因：管理端发起的停止（stopping 标志置位）→ stopped；其余退出（外部杀死、
 *   自身崩溃、starting 阶段 spawn 失败）→ crashed，并记录 lastExitCode / lastSignal。
 * - 状态变更与子进程行输出通过回调通知订阅者（index.ts 接 wsHub / logStream）。
 */
import { spawn } from 'node:child_process'
import type { ChildProcessByStdio, SpawnOptionsWithStdioTuple } from 'node:child_process'
import type { Readable } from 'node:stream'

import { GAME_ROOT, PREVIEW_PORT, rolePort } from '../config.js'
import type {
  InstanceRole,
  InstanceSnapshot,
  InstanceStatus,
  ProcessSource,
} from '../types.js'

/** POSIX 下 SIGTERM 后等待退出再升级 SIGKILL 的宽限时间。 */
const KILL_GRACE_MS = 5_000
/** waitForExit 的轮询间隔。 */
const EXIT_POLL_MS = 100

/** 状态冲突错误（REST 层映射 409）。 */
export class ConflictError extends Error {
  readonly status = 409
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

export type StateListener = (snapshot: InstanceSnapshot) => void
export type LineListener = (role: InstanceRole, source: ProcessSource, line: string) => void

const IS_WIN = process.platform === 'win32'

/**
 * 单个角色实例的管理器（official / preview 各一份）。
 *
 * 状态字段只在本类内部流转；对外仅暴露 snapshot 只读视图与回调注册。
 */
export class InstanceManager {
  readonly role: InstanceRole

  /** 游戏进程树根（stdin=ignore，stdout/stderr=pipe）。 */
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null
  /** 停止流程进行中标志：exit 事件据此归因 stopped（true）或 crashed（false）。 */
  private stopping = false
  /** 本次 spawn 生命周期是否已收敛（防 error/exit 双触发导致状态二次流转）。 */
  private settled = true

  private status: InstanceStatus = 'stopped'
  private pid: number | null = null
  private startedAt: number | null = null
  private lastExitCode: number | null = null
  private lastSignal: NodeJS.Signals | null = null

  private readonly stateListeners = new Set<StateListener>()
  private readonly lineListeners = new Set<LineListener>()

  /** stdout/stderr 的半行缓冲（按行拆分用）。 */
  private stdoutBuf = ''
  private stderrBuf = ''

  constructor(role: InstanceRole) {
    this.role = role
  }

  // ---------------------------------------------------------------------------
  // 订阅
  // ---------------------------------------------------------------------------

  /** 注册状态变更回调，返回取消订阅函数。 */
  onStateChange(cb: StateListener): () => void {
    this.stateListeners.add(cb)
    return () => this.stateListeners.delete(cb)
  }

  /** 注册子进程行输出回调（已按行拆分），返回取消订阅函数。 */
  onLine(cb: LineListener): () => void {
    this.lineListeners.add(cb)
    return () => this.lineListeners.delete(cb)
  }

  /** 当前状态快照（只读视图）。 */
  get snapshot(): InstanceSnapshot {
    return {
      role: this.role,
      status: this.status,
      pid: this.pid,
      startedAt: this.startedAt,
      port: rolePort(this.role),
      lastExitCode: this.lastExitCode,
      lastSignal: this.lastSignal,
    }
  }

  // ---------------------------------------------------------------------------
  // 启动 / 停止 / 重启
  // ---------------------------------------------------------------------------

  /**
   * 启动实例。starting/running 状态下重复调用抛 ConflictError（REST → 409）。
   * resolve 时 spawn 已发起；starting → running 由子进程 'spawn' 事件异步完成。
   */
  async start(): Promise<InstanceSnapshot> {
    if (this.status === 'starting' || this.status === 'running') {
      throw new ConflictError(`instance "${this.role}" is ${this.status}; stop it first`)
    }

    // 环境注入：official 继承管理后端环境（S1 不注入）；preview 注入 PORT=3200
    // （游戏进程 dotenv 不覆盖已存在的变量，因此注入值优先于本体 .env）。
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (this.role === 'preview') env.PORT = String(PREVIEW_PORT)

    const spawnOptions: SpawnOptionsWithStdioTuple<'ignore', 'pipe', 'pipe'> = {
      cwd: GAME_ROOT,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
    if (IS_WIN) {
      // win32：pnpm 是 pnpm.cmd，需经 shell 解析；树杀交给 taskkill /T，无需 detached。
      spawnOptions.shell = true
    } else {
      // posix：detached 让直接子进程成为组长，可用 kill(-pid) 杀整组（pnpm → tsx → 游戏）。
      spawnOptions.detached = true
    }

    const command = IS_WIN ? 'pnpm.cmd' : 'pnpm'
    const child = IS_WIN
      ? spawn(command, ['dev'], spawnOptions)
      : spawn(command, ['dev'], spawnOptions)

    this.child = child
    this.stopping = false
    this.settled = false
    this.stdoutBuf = ''
    this.stderrBuf = ''
    // child.pid 在 spawn() 返回时即已分配（失败则 undefined），立即记录供 stop() 使用。
    this.pid = child.pid ?? null
    this.startedAt = Date.now()
    this.setStatus('starting')

    child.on('spawn', () => {
      // 进程成功拉起 → running（pid 此刻确定可用）。
      if (this.settled) return
      this.pid = child.pid ?? this.pid
      this.setStatus('running')
    })

    child.on('error', (err) => {
      // spawn 失败（如 ENOENT）：starting 阶段归因 crashed；其余阶段仅记录。
      if (this.status === 'starting' && !this.settled) {
        this.lastExitCode = null
        this.lastSignal = null
        this.finish('crashed')
        console.error(`[instance:${this.role}] spawn failed: ${err.message}`)
      } else {
        console.error(`[instance:${this.role}] child error (status=${this.status}):`, err.message)
      }
    })

    child.on('exit', (code, signal) => {
      if (this.settled) return
      // 归因：管理端发起的停止 → stopped；否则（外部杀死/自身崩溃）→ crashed。
      const wasStopping = this.stopping
      this.lastExitCode = code
      this.lastSignal = signal ?? null
      this.finish(wasStopping ? 'stopped' : 'crashed')
    })

    // 按行拆分 stdout/stderr（半行缓冲），交给订阅者（logStream）。
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.feedLines('stdout', chunk))
    child.stderr.on('data', (chunk: string) => this.feedLines('stderr', chunk))
    child.on('close', () => {
      // 进程退出后冲刷残余半行，避免吞掉最后一行。
      this.flushLineBuffers()
    })

    return this.snapshot
  }

  /**
   * 停止实例（树杀）。stopped/crashed 状态下调用抛 ConflictError（REST → 409）。
   * resolve 时退出事件已处理完毕（或超过双倍宽限时间的兜底时刻）。
   */
  async stop(): Promise<InstanceSnapshot> {
    if (this.status === 'stopped' || this.status === 'crashed') {
      throw new ConflictError(`instance "${this.role}" is ${this.status}; nothing to stop`)
    }

    const child = this.child
    this.stopping = true

    if (child?.pid) {
      if (IS_WIN) {
        // taskkill /T（含子进程树）/F（强制）。
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } else {
        try {
          // 负 pid 杀整个进程组（依赖 detached）。
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          // ESRCH：进程组已退出，等待 exit 事件收敛即可。
        }
      }
    }

    await this.waitForExit()
    return this.snapshot
  }

  /** 重启 = 停止完成后重新启动。未运行时抛 ConflictError（提示改用 start）。 */
  async restart(): Promise<InstanceSnapshot> {
    if (this.status === 'stopped' || this.status === 'crashed') {
      throw new ConflictError(`instance "${this.role}" is ${this.status}; use /start instead`)
    }
    await this.stop()
    return this.start()
  }

  // ---------------------------------------------------------------------------
  // 内部实现
  // ---------------------------------------------------------------------------

  private setStatus(next: InstanceStatus): void {
    if (this.status === next) return
    this.status = next
    for (const cb of this.stateListeners) {
      try {
        cb(this.snapshot)
      } catch (err) {
        // 订阅者（WS 广播等）异常不能影响进程管理本身。
        console.error(`[instance:${this.role}] state listener failed:`, err)
      }
    }
  }

  /** 收敛本次 spawn 生命周期：清理句柄与标志并流转状态（幂等）。 */
  private finish(next: InstanceStatus): void {
    if (this.settled) return
    this.settled = true
    this.stopping = false
    this.child = null
    this.pid = null
    this.setStatus(next)
  }

  /** 轮询等待状态收敛出 stopped/crashed；宽限超时升级 SIGKILL，双倍超时兜底放行。 */
  private waitForExit(): Promise<void> {
    return new Promise((resolve) => {
      const begunAt = Date.now()
      let escalated = false
      const timer = setInterval(() => {
        if (this.status === 'stopped' || this.status === 'crashed') {
          clearInterval(timer)
          resolve()
          return
        }
        const elapsed = Date.now() - begunAt
        if (!escalated && elapsed >= KILL_GRACE_MS) {
          escalated = true
          const pid = this.child?.pid
          if (pid) {
            if (IS_WIN) {
              spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
            } else {
              try {
                process.kill(-pid, 'SIGKILL')
              } catch {
                // 进程组已消失。
              }
            }
          }
        }
        if (elapsed >= KILL_GRACE_MS * 2) {
          // 兜底：不再阻塞 REST 响应；真实退出由 exit 事件继续驱动状态归因。
          clearInterval(timer)
          resolve()
        }
      }, EXIT_POLL_MS)
    })
  }

  /** stdout/stderr 分块 → 按行拆分（处理半行缓冲）→ 通知订阅者。 */
  private feedLines(source: ProcessSource, chunk: string): void {
    const buf = source === 'stdout' ? this.stdoutBuf : this.stderrBuf
    const merged = buf + chunk
    const parts = merged.split(/\r?\n/)
    const rest = parts.pop() ?? ''
    if (source === 'stdout') this.stdoutBuf = rest
    else this.stderrBuf = rest
    for (const line of parts) this.emitLine(source, line)
  }

  /** 进程退出后冲刷半行缓冲。 */
  private flushLineBuffers(): void {
    for (const source of ['stdout', 'stderr'] as const) {
      const buf = source === 'stdout' ? this.stdoutBuf : this.stderrBuf
      if (buf) {
        if (source === 'stdout') this.stdoutBuf = ''
        else this.stderrBuf = ''
        this.emitLine(source, buf)
      }
    }
  }

  private emitLine(source: ProcessSource, rawLine: string): void {
    if (!rawLine.trim()) return
    for (const cb of this.lineListeners) {
      try {
        cb(this.role, source, rawLine)
      } catch (err) {
        console.error(`[instance:${this.role}] line listener failed:`, err)
      }
    }
  }
}

/** 双角色管理器单例。 */
export const instanceManagers: Record<InstanceRole, InstanceManager> = {
  official: new InstanceManager('official'),
  preview: new InstanceManager('preview'),
}

/** 按角色取管理器。 */
export function getInstanceManager(role: InstanceRole): InstanceManager {
  return instanceManagers[role]
}

/** 角色参数收窄。 */
export function isInstanceRole(value: string): value is InstanceRole {
  return value === 'official' || value === 'preview'
}
