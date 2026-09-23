/**
 * SidecarClient —— 平台侧 driver 进程管理者与 RPC 客户端（T1.3）。
 *
 * 生命周期（防 crash loop 设计）：
 * - **lazy start**：首个 RPC 才 spawn driver；构造/导入本模块零副作用。
 * - exit → 下次 RPC 自动重启一次（每个请求至多触发一次 spawn 尝试）。
 * - **连续 2 次 spawn 失败 → sticky `unavailable`**，不再自动重试；显式
 *   `restart()` 清除状态后恢复 lazy 语义。
 * - 管理后端退出（process 'exit'）时对仍存活的 driver SIGTERM——driver 是计算
 *   附属物，不留孤儿（与游戏实例"独立存活"语义相反，勿抄 instanceManager 的
 *   退出行为）。兜底：driver 自身 stdin EOF 即退出（即使 admin 被 SIGKILL，
 *   管道关闭也会让 driver 自行退出，双保险）。
 *
 * spawn 机制（Phase 0 T0.3 定型候选 1）：
 *   spawn(process.execPath, ['--import', 'tsx', driverPath],
 *         { cwd: GAME_ROOT, env: { …, TSX_TSCONFIG_PATH: <GAME_ROOT>/tsconfig.json } })
 * 本 Phase cwd 用 config.ts 现有 GAME_ROOT 解析（不新建机制）。
 * T2.3：构造参数可注入 gameRoot（SidecarManager 按 gameId 传各游戏 gameRoot）；
 * 缺省仍为 config.GAME_ROOT——单例 sidecar 与存量消费方行为零变化。
 *
 * NDJSON（§0.2）：id 自增 + pending map；stdout 半行缓冲按行拆
 * （instanceManager.ts feedLines 同款思路）；stderr 行转发 console
 * （本 Phase 不接 logStream，Phase 2 再说）。
 * 超时（§0.2）：默认 15s，buildMapGeometry / exportMapArtifacts 60s；
 * 超时只 reject `timeout`，**不杀进程**。
 * 请求串行化：client 内 promise 链（与 driver 逐行串行处理对齐，
 * 避免 pending 乱序复杂度）。
 *
 * 已知限制（Q7 已拍板）：本期只保 linux；win32 spawn 差异不覆盖。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { GAME_ROOT } from '../config.js'
import type {
  BuildMapGeometryParams,
  ExportMapArtifactsParams,
  ExportMapArtifactsResult,
  ListRegistriesResult,
  PingResult,
  SerializedMapGeometry,
  SidecarErrorCode,
  SidecarMethod,
  SidecarMethodMap,
  SidecarResponseFrame,
  ValidateFileParams,
  ValidateFileResult,
  ValidateWholeParams,
  ValidateWholeResult,
} from './protocol.js'

/** 默认 RPC 超时（§0.2）。 */
export const SIDECAR_TIMEOUT_MS = 15_000
/** buildMapGeometry / exportMapArtifacts 超时（§0.2）。 */
export const SIDECAR_LONG_TIMEOUT_MS = 60_000

/** 连续 spawn 失败上限：达到即进入 sticky unavailable（防 crash loop）。 */
const MAX_CONSECUTIVE_SPAWN_FAILURES = 2

/** driver 入口（server/src/sidecar → server/sidecar/driver.ts），与 cwd 无关。 */
const DRIVER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../sidecar/driver.ts',
)

/** 平台侧 sidecar 错误（code → REST 语义映射见 §0.2 / T1.5）。 */
export class SidecarError extends Error {
  constructor(readonly code: SidecarErrorCode, message: string) {
    super(message)
    this.name = 'SidecarError'
  }
}

interface Pending {
  method: string
  timer: NodeJS.Timeout
  resolve: (value: unknown) => void
  reject: (err: SidecarError) => void
}

/** 客户端运行状态快照（观测/测试用）。 */
export interface SidecarSnapshot {
  /** 当前有存活的 driver 子进程。 */
  alive: boolean
  /** driver pid（存活时）。 */
  pid: number | null
  /** 连续 spawn 失败计数（成功产出首帧后清零）。 */
  spawnFailures: number
  /** sticky unavailable 原因（未进入该状态为 null）。 */
  unavailable: string | null
  /** 在途请求数。 */
  pendingRequests: number
}

/** 构造参数（T2.3）：注入 gameRoot 供 per-game driver 使用；缺省维持现状行为。 */
export interface SidecarClientOptions {
  /** 游戏根目录（driver 的 cwd 与 TSX_TSCONFIG_PATH 锚点）；缺省 config.GAME_ROOT。 */
  gameRoot?: string
}

export class SidecarClient {
  private static exitHookInstalled = false
  private static readonly live = new Set<SidecarClient>()

  /**
   * exit 钩子（全类单次注册；覆盖多个实例）：
   * 管理后端退出（process 'exit'）时对仍存活的 driver SIGTERM——driver 是计算
   * 附属物，不留孤儿（与游戏实例"独立存活"语义相反，勿抄 instanceManager 的
   * 退出行为）。兜底：driver 自身 stdin EOF 即退出（即使 admin 被 SIGKILL，
   * 管道关闭也会让 driver 自行退出，双保险）。
   */
  private static installExitHook(): void {
    if (SidecarClient.exitHookInstalled) return
    SidecarClient.exitHookInstalled = true
    process.on('exit', () => {
      for (const client of SidecarClient.live) client.terminateForExit()
    })
  }

  private child: ChildProcess | null = null
  /** 当前 child 是否已产出过合法协议帧（区分"启动失败"与"启动后崩溃"）。 */
  private booted = false
  /** 当前 spawn 尝试是否已计过失败（error / exit / 写失败多路径只计一次）。 */
  private attemptCounted = true
  private readonly pending = new Map<number, Pending>()
  private nextIdVal = 0
  private stdoutBuf = ''
  private stderrBuf = ''
  private spawnFailures = 0
  /** 非 null 时为 sticky unavailable：一切 RPC 直接拒绝，不再 spawn。 */
  private unavailableMsg: string | null = null
  /** 请求串行化 promise 链。 */
  private queue: Promise<unknown> = Promise.resolve()
  /** driver 的 cwd / tsconfig 锚点（T2.3 per-game 注入；缺省 config.GAME_ROOT）。 */
  private readonly gameRoot: string

  constructor(options: SidecarClientOptions = {}) {
    this.gameRoot = options.gameRoot ? path.resolve(options.gameRoot) : GAME_ROOT
    SidecarClient.installExitHook()
    SidecarClient.live.add(this)
  }

  // -----------------------------------------------------------------------
  // RPC 方法（超时按 §0.2：默认 15s；几何两方法 60s）
  // -----------------------------------------------------------------------

  ping(timeoutMs: number = SIDECAR_TIMEOUT_MS): Promise<PingResult> {
    return this.request('ping', {}, timeoutMs)
  }

  listRegistries(timeoutMs: number = SIDECAR_TIMEOUT_MS): Promise<ListRegistriesResult> {
    return this.request('listRegistries', {}, timeoutMs)
  }

  validateFile(params: ValidateFileParams, timeoutMs: number = SIDECAR_TIMEOUT_MS): Promise<ValidateFileResult> {
    return this.request('validateFile', params, timeoutMs)
  }

  validateWhole(params: ValidateWholeParams, timeoutMs: number = SIDECAR_TIMEOUT_MS): Promise<ValidateWholeResult> {
    return this.request('validateWhole', params, timeoutMs)
  }

  buildMapGeometry(
    params: BuildMapGeometryParams,
    timeoutMs: number = SIDECAR_LONG_TIMEOUT_MS,
  ): Promise<SerializedMapGeometry> {
    return this.request('buildMapGeometry', params, timeoutMs)
  }

  exportMapArtifacts(
    params: ExportMapArtifactsParams,
    timeoutMs: number = SIDECAR_LONG_TIMEOUT_MS,
  ): Promise<ExportMapArtifactsResult> {
    return this.request('exportMapArtifacts', params, timeoutMs)
  }

  // -----------------------------------------------------------------------
  // 显式生命周期控制
  // -----------------------------------------------------------------------

  /**
   * 显式恢复（sticky unavailable 的唯一出口）：清除 unavailable 状态与失败计数，
   * SIGTERM 当前 driver；下次 RPC 按 lazy 语义重新拉起。
   */
  restart(): void {
    this.unavailableMsg = null
    this.spawnFailures = 0
    this.killCurrentChild('restart() 显式重启')
  }

  /** 停掉当前 driver 并复位状态（下次 RPC 仍会按 lazy 语义按需拉起）。 */
  stop(): void {
    this.killCurrentChild('stop() 显式停止')
    this.unavailableMsg = null
    this.spawnFailures = 0
  }

  snapshot(): SidecarSnapshot {
    const child = this.child
    const alive = child !== null && child.exitCode === null && child.signalCode === null
    return {
      alive,
      pid: alive && child?.pid !== undefined ? child.pid : null,
      spawnFailures: this.spawnFailures,
      unavailable: this.unavailableMsg,
      pendingRequests: this.pending.size,
    }
  }

  /** process 'exit' 钩子专用：同步 SIGTERM（exit 钩子内只能同步操作）。 */
  private terminateForExit(): void {
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    try {
      child.kill('SIGTERM')
    } catch {
      // 进程已消失
    }
  }

  // -----------------------------------------------------------------------
  // 请求路径（串行化 → ensureDriver → 写帧 → pending map）
  // -----------------------------------------------------------------------

  private request<M extends SidecarMethod>(
    method: M,
    params: SidecarMethodMap[M]['params'],
    timeoutMs: number,
  ): Promise<SidecarMethodMap[M]['result']> {
    // 串行：所有请求过同一条 promise 链；失败不阻断后续请求
    const run = this.queue.then(() => this.doRequest(method, params as Record<string, unknown>, timeoutMs))
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run as Promise<SidecarMethodMap[M]['result']>
  }

  private doRequest(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = this.ensureDriver()
      } catch (err) {
        reject(err instanceof SidecarError ? err : new SidecarError('unavailable', String(err)))
        return
      }
      const id = ++this.nextIdVal
      const pending: Pending = {
        method,
        timer: setTimeout(() => {
          // 超时只放弃本请求，不杀 driver（§0.2）；迟到的帧由 handleFrameLine
          // 记"无法归属"日志
          this.pending.delete(id)
          reject(new SidecarError('timeout', `sidecar RPC 超时 (${timeoutMs}ms): ${method}`))
        }, timeoutMs),
        resolve,
        reject,
      }
      this.pending.set(id, pending)
      const stdin = child.stdin
      if (!stdin) {
        // spawn 未成功（如 cwd 无效）：stdin 流不存在，按进程 down 归因
        clearTimeout(pending.timer)
        this.pending.delete(id)
        this.noteChildDown(child, 'stdin 不可用（spawn 未成功）')
        pending.reject(new SidecarError('unavailable', 'sidecar stdin 不可用（spawn 未成功）'))
        return
      }
      const onWriteError = (err: Error): void => {
        if (!this.pending.has(id)) return // exit 路径已归因/拒绝
        // 写失败=管道已断（driver 已死或正在死）。按进程 down 处理；
        // 迟到的 'exit' 事件会因 this.child 已清理而幂等跳过。
        clearTimeout(pending.timer)
        this.pending.delete(id)
        this.noteChildDown(child, `stdin 写入失败: ${err.message}`)
        pending.reject(new SidecarError('unavailable', `sidecar stdin 写入失败（进程可能已退出）: ${err.message}`))
      }
      try {
        stdin.write(`${JSON.stringify({ id, method, params })}\n`, (err) => {
          if (err) onWriteError(err)
        })
      } catch (err) {
        // 流已销毁时 write 可能同步抛错（spike 实测观察过该路径）
        onWriteError(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /**
   * 取一个可用 driver：存活复用；否则 spawn 一次（每个请求至多一次尝试）。
   * sticky unavailable 直接抛 `unavailable`，不再 spawn。
   */
  private ensureDriver(): ChildProcess {
    if (this.unavailableMsg) throw new SidecarError('unavailable', this.unavailableMsg)
    const cur = this.child
    if (cur && cur.exitCode === null && cur.signalCode === null) return cur
    try {
      return this.spawnDriver()
    } catch (err) {
      // spawn 同步抛错（参数/资源问题，罕见）：按一次启动失败计
      const reason = err instanceof Error ? err.message : String(err)
      this.noteSpawnFailure(`spawn 同步失败: ${reason}`)
      throw new SidecarError('unavailable', `sidecar spawn 失败: ${reason}`)
    }
  }

  /** spawn（T0.3 定型候选 1）：node --import tsx，cwd=gameRoot，TSX_TSCONFIG_PATH 指向本体 tsconfig。 */
  private spawnDriver(): ChildProcess {
    const child = spawn(process.execPath, ['--import', 'tsx', DRIVER_PATH], {
      cwd: this.gameRoot,
      env: { ...process.env, TSX_TSCONFIG_PATH: path.join(this.gameRoot, 'tsconfig.json') },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.booted = false
    this.attemptCounted = false

    child.on('error', (err) => {
      this.noteChildDown(child, `spawn 失败: ${err.message}`)
    })
    child.on('exit', (code, signal) => {
      this.noteChildDown(child, `driver 进程退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
    })

    // stdout 半行缓冲按行拆（instanceManager feedLines 同款思路）；
    // setEncoding 保证跨 chunk 的多字节 UTF-8 正确解码
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => this.feedStdout(chunk))
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (chunk: string) => this.feedStderr(chunk))
    // stdin 流自身的 'error'（管道断裂）必须有监听，否则会成为未捕获异常；
    // 真实归因由 write 回调 / 'exit' 事件完成
    child.stdin?.on('error', () => {})
    return child
  }

  // -----------------------------------------------------------------------
  // 行处理与状态归因
  // -----------------------------------------------------------------------

  private feedStdout(chunk: string): void {
    const merged = this.stdoutBuf + chunk
    const parts = merged.split(/\r?\n/)
    this.stdoutBuf = parts.pop() ?? ''
    for (const line of parts) this.handleFrameLine(line)
  }

  private handleFrameLine(line: string): void {
    let frame: SidecarResponseFrame
    try {
      frame = JSON.parse(line) as SidecarResponseFrame
    } catch {
      console.error(`[sidecar] stdout 非协议帧（非 JSON）: ${line.slice(0, 300)}`)
      return
    }
    if (
      frame === null ||
      typeof frame !== 'object' ||
      typeof frame.id !== 'number' ||
      typeof frame.ok !== 'boolean'
    ) {
      console.error(`[sidecar] stdout 非协议帧（形状）: ${line.slice(0, 300)}`)
      return
    }
    if (!this.booted) {
      // 首帧 = 本轮 spawn 成功的确证：失败计数清零
      this.booted = true
      this.spawnFailures = 0
    }
    const pending = this.pending.get(frame.id)
    if (!pending) {
      console.error(`[sidecar] 无法归属的响应帧 id=${frame.id}（已超时或已被拒绝）`)
      return
    }
    this.pending.delete(frame.id)
    clearTimeout(pending.timer)
    if (frame.ok) {
      pending.resolve(frame.result)
    } else {
      const errShape = frame.error
      const code = typeof errShape?.code === 'string' ? (errShape.code as SidecarErrorCode) : 'driver_error'
      const message = typeof errShape?.message === 'string' ? errShape.message : '(driver 未提供 message)'
      pending.reject(new SidecarError(code, message))
    }
  }

  private feedStderr(chunk: string): void {
    const merged = this.stderrBuf + chunk
    const parts = merged.split(/\r?\n/)
    this.stderrBuf = parts.pop() ?? ''
    for (const line of parts) {
      if (line.trim()) console.error(`[sidecar] ${line}`)
    }
  }

  /** 统一的"进程 down"归因：清理引用 → 启动失败计数（若尚无首帧）→ 拒绝在途请求。 */
  private noteChildDown(child: ChildProcess, reason: string): void {
    if (this.child !== child) return // 已被更新/清理（restart/stop/新 spawn），幂等跳过
    this.child = null
    if (!this.booted && !this.attemptCounted) {
      this.noteSpawnFailure(reason)
    } else {
      console.error(`[sidecar] driver 进程退出: ${reason}`)
    }
    this.flushAndRejectPending(`sidecar 进程不可用（${reason}）`)
  }

  private noteSpawnFailure(reason: string): void {
    this.attemptCounted = true
    this.spawnFailures += 1
    console.error(`[sidecar] 启动失败（${this.spawnFailures}/${MAX_CONSECUTIVE_SPAWN_FAILURES}）: ${reason}`)
    if (this.spawnFailures >= MAX_CONSECUTIVE_SPAWN_FAILURES) {
      this.unavailableMsg =
        `连续 ${this.spawnFailures} 次 sidecar 启动失败 → unavailable` +
        `（防 crash loop，不再自动重试；可用 restart() 显式恢复）`
      console.error(`[sidecar] ${this.unavailableMsg}`)
    }
  }

  /** 进程 down 后冲刷半行缓冲并拒绝全部在途请求（'unavailable'）。 */
  private flushAndRejectPending(reason: string): void {
    if (this.stdoutBuf) {
      console.error(`[sidecar] stdout 残留半行（未完成帧）: ${this.stdoutBuf.slice(0, 300)}`)
      this.stdoutBuf = ''
    }
    if (this.stderrBuf) {
      console.error(`[sidecar] ${this.stderrBuf}`)
      this.stderrBuf = ''
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new SidecarError('unavailable', reason))
    }
    this.pending.clear()
  }

  /** SIGTERM 当前 driver 并解除引用（迟到的 exit 事件幂等跳过）。 */
  private killCurrentChild(why: string): void {
    const child = this.child
    this.child = null
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM')
      } catch {
        // 进程已消失
      }
    }
    this.flushAndRejectPending(`sidecar 已被 ${why}`)
  }
}

/**
 * 平台侧 sidecar 客户端单例（T1.5/T1.6 的服务层从此引用）。
 *
 * T2.3 语义：本单例未注入 gameRoot → 绑定 config.GAME_ROOT（=
 * defaultGameContext.gameRoot，与 forGame('gst') 解析出的 gameRoot 同一绝对路径），
 * 即"forGame('gst') 的语义等价物"，存量消费方零改动；T2.4 起服务层改接
 * SidecarManager.forGame(gameId)，本单例退役。
 */
export const sidecar = new SidecarClient()
