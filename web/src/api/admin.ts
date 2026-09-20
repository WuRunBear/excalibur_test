/**
 * 管理后端 API / WS 客户端（S1-D2）。
 *
 * - REST：统一解包 { code, message, detail }，code ≠ 0 抛 AdminApiError（携带后端 message）。
 *   基址默认 http://localhost:3100，可用 VITE_ADMIN_SERVER_URL 覆盖（参数化先例见 modules/net/config.ts）。
 * - WS：/ws?channel=<name> 频道订阅封装，断线按指数退避自动重连（1s 起，封顶 15s）。
 *
 * 类型镜像 server/src/types.ts（web 不跨包引入后端源码；契约同步以该文件为准）。
 */

/** 实例角色：正式服 / 预览服。 */
export type InstanceRole = 'official' | 'preview'

/** 实例状态机：stopped → starting → running →（crashed | stopped）。 */
export type InstanceStatus = 'stopped' | 'starting' | 'running' | 'crashed'

/** 实例状态快照（REST 与 WS 广播共用结构，镜像 InstanceSnapshot）。 */
export interface InstanceSnapshot {
  role: InstanceRole
  status: InstanceStatus
  /** 游戏进程树根 pid；未运行时为 null */
  pid: number | null
  /** 最近一次 start 成功发起的时间（epoch ms）；未运行时保留上次值 */
  startedAt: number | null
  /** 展示端口 */
  port: number
  /** 最近一次退出的退出码（被信号杀死时为 null） */
  lastExitCode: number | null
  /** 最近一次退出的信号（正常退出时为 null） */
  lastSignal: string | null
}

/** 日志来源：日志文件 tail / 进程 stdout / 进程 stderr。 */
export type LogSource = 'file' | 'stdout' | 'stderr'

/** 单条日志消息（镜像 LogMessage）。 */
export interface LogMessage {
  role: InstanceRole
  source: LogSource
  /** 启发式提取的级别；提取不到为 undefined */
  level?: string
  text: string
  /** 时间戳（epoch ms） */
  ts: number
}

/** WS 频道白名单（镜像 server/src/ws/hub.ts 的 WS_CHANNELS）。 */
export type AdminChannel = 'instance:state' | 'instance:log:official' | 'instance:log:preview'

/** 统一响应结构。 */
interface AdminEnvelope<T> {
  code: number
  message: string
  detail?: T
}

/** 角色中文名。 */
export const INSTANCE_ROLE_LABELS: Record<InstanceRole, string> = {
  official: '正式实例',
  preview: '预览实例',
}

/** 状态中文名（运行中 / 启动中 / 已停止 / 已崩溃）。 */
export const INSTANCE_STATUS_TEXT: Record<InstanceStatus, string> = {
  running: '运行中',
  starting: '启动中',
  stopped: '已停止',
  crashed: '已崩溃',
}

/** 后端业务错误：携带统一响应中的 code 与 message。 */
export class AdminApiError extends Error {
  readonly code: number

  constructor(message: string, code: number) {
    super(message)
    this.name = 'AdminApiError'
    this.code = code
  }
}

function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = (value ?? '').trim()
  const base = trimmed || 'http://localhost:3100'
  return base.replace(/\/+$/, '')
}

/** 管理后端 REST 基址。 */
export const ADMIN_API_BASE = normalizeBaseUrl(
  import.meta.env.VITE_ADMIN_SERVER_URL as string | undefined,
)

/** WS 基址（由 REST 基址推导：http→ws / https→wss）。 */
export const ADMIN_WS_BASE = ADMIN_API_BASE.replace(/^http/, 'ws')

/** 统一请求封装：解包统一响应，code ≠ 0 / 网络异常 / 非 JSON 响应均抛 AdminApiError。 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${ADMIN_API_BASE}${path}`, {
      ...init,
      headers: { Accept: 'application/json', ...init?.headers },
    })
  } catch {
    throw new AdminApiError('无法连接管理后端，请确认服务已启动', -1)
  }

  let payload: AdminEnvelope<T> | null = null
  try {
    payload = (await res.json()) as AdminEnvelope<T>
  } catch {
    payload = null
  }

  if (!payload) {
    throw new AdminApiError(`管理后端响应异常（HTTP ${res.status}）`, -1)
  }
  if (payload.code !== 0) {
    throw new AdminApiError(payload.message || '请求失败', payload.code)
  }
  return payload.detail as T
}

/** GET /api/instances → 双角色状态快照。 */
export async function fetchInstances(): Promise<{
  official: InstanceSnapshot
  preview: InstanceSnapshot
}> {
  return request('/api/instances')
}

/** POST /api/instances/:role/start → 启动实例（detail 为最新快照）。 */
export function startInstance(role: InstanceRole): Promise<InstanceSnapshot> {
  return request<InstanceSnapshot>(`/api/instances/${role}/start`, { method: 'POST' })
}

/** POST /api/instances/:role/stop → 停止实例（树杀，等待退出归因）。 */
export function stopInstance(role: InstanceRole): Promise<InstanceSnapshot> {
  return request<InstanceSnapshot>(`/api/instances/${role}/stop`, { method: 'POST' })
}

/** POST /api/instances/:role/restart → 重启实例（stop 完成后 start）。 */
export function restartInstance(role: InstanceRole): Promise<InstanceSnapshot> {
  return request<InstanceSnapshot>(`/api/instances/${role}/restart`, { method: 'POST' })
}

/** 最近日志回填响应。 */
export interface RecentLogs {
  role: InstanceRole
  lines: LogMessage[]
}

/** GET /api/instances/:role/logs?lines=N → 环形缓冲最近 N 行（按时间正序）。 */
export function fetchRecentLogs(role: InstanceRole, lines = 200): Promise<RecentLogs> {
  return request<RecentLogs>(`/api/instances/${role}/logs?lines=${lines}`)
}

export interface AdminChannelHandlers {
  /** 收到频道 JSON 负载（解析失败的消息会被忽略）。 */
  onMessage: (payload: unknown) => void
  /** 连接建立（含断线重连成功）。 */
  onOpen?: () => void
  /** 连接断开（主动 close 不会触发）。 */
  onClose?: () => void
}

export interface AdminSocketHandle {
  /** 取消订阅：停止重连并关闭连接。 */
  close: () => void
}

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 15000

/**
 * 订阅管理后端 WS 频道；断线按指数退避自动重连（1s → 2s → 4s → … 封顶 15s），
 * 连接成功后重置退避。返回句柄供组件卸载 / store 释放时取消订阅。
 */
export function subscribeAdminChannel(
  channel: AdminChannel,
  handlers: AdminChannelHandlers,
): AdminSocketHandle {
  let closed = false
  let attempt = 0
  let socket: WebSocket | null = null
  let reconnectTimer: number | null = null

  const clearTimer = (): void => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer !== null) return
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS)
    attempt += 1
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  const connect = (): void => {
    if (closed) return
    let ws: WebSocket
    try {
      ws = new WebSocket(`${ADMIN_WS_BASE}/ws?channel=${encodeURIComponent(channel)}`)
    } catch {
      scheduleReconnect()
      return
    }
    socket = ws
    ws.onopen = () => {
      if (closed) return
      attempt = 0
      handlers.onOpen?.()
    }
    ws.onmessage = (event: MessageEvent) => {
      if (closed) return
      try {
        handlers.onMessage(JSON.parse(String(event.data)) as unknown)
      } catch {
        // 非 JSON 负载忽略。
      }
    }
    ws.onclose = () => {
      socket = null
      if (closed) return
      handlers.onClose?.()
      scheduleReconnect()
    }
    ws.onerror = () => {
      // 统一由 onclose 驱动重连。
      ws.close()
    }
  }

  connect()

  return {
    close: () => {
      closed = true
      clearTimer()
      socket?.close()
      socket = null
    },
  }
}
