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
  /** 预览实例使用的配置路径（指向工作区文件）；回退本体配置时为 null；official 恒 null */
  configPath: string | null
  /** 预览实例的存档目录；回退本体配置时为 null；official 恒 null */
  saveDir: string | null
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

/** 后端业务错误：携带统一响应中的 code、message、detail 与 HTTP 状态码（区分 422/409 等失败场景）。 */
export class AdminApiError extends Error {
  readonly code: number
  readonly detail: unknown
  readonly status: number

  constructor(message: string, code: number, detail?: unknown, status = 0) {
    super(message)
    this.name = 'AdminApiError'
    this.code = code
    this.detail = detail
    this.status = status
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
    throw new AdminApiError('无法连接管理后端，请确认服务已启动', -1, undefined, 0)
  }

  let payload: AdminEnvelope<T> | null = null
  try {
    payload = (await res.json()) as AdminEnvelope<T>
  } catch {
    payload = null
  }

  if (!payload) {
    throw new AdminApiError(`管理后端响应异常（HTTP ${res.status}）`, -1, undefined, res.status)
  }
  if (payload.code !== 0) {
    throw new AdminApiError(payload.message || '请求失败', payload.code, payload.detail, res.status)
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

// ---------------------------------------------------------------------------
// 工作区（S2-B）
// ---------------------------------------------------------------------------

/** 工作区元信息（本体游戏的隔离副本；createdAt 为 epoch ms，沿用快照时间约定）。 */
export interface WorkspaceMeta {
  id: string
  name: string
  createdAt: number
  /** 创建时基于本体文件的指纹（展示 / 诊断用，前端不解读） */
  baseFingerprint: string
  /** 相对本体的改动文件数 */
  changedFiles: number
}

/** GET /api/workspaces → 列表与当前活动工作区。 */
export interface WorkspaceList {
  activeId: string | null
  items: WorkspaceMeta[]
}

export function fetchWorkspaces(): Promise<WorkspaceList> {
  return request('/api/workspaces')
}

/** POST /api/workspaces {name} → 新建并自动激活。 */
export function createWorkspace(name: string): Promise<WorkspaceMeta> {
  return request('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

/** POST /api/workspaces/:id/activate → 激活（切换）工作区。 */
export function activateWorkspace(id: string): Promise<WorkspaceMeta> {
  return request(`/api/workspaces/${encodeURIComponent(id)}/activate`, { method: 'POST' })
}

/** PATCH /api/workspaces/:id {name} → 重命名。 */
export function renameWorkspace(id: string, name: string): Promise<WorkspaceMeta> {
  return request(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

/** DELETE /api/workspaces/:id → 删除（仅隔离副本，本体无痕）。 */
export function deleteWorkspace(id: string): Promise<{ id: string }> {
  return request(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** 改动文件状态。 */
export type WorkspaceChangeStatus = 'added' | 'modified' | 'deleted'

export interface WorkspaceChange {
  path: string
  status: WorkspaceChangeStatus
}

/** GET /api/workspaces/:id/changes → 改动文件清单。 */
export function fetchWorkspaceChanges(id: string): Promise<{ files: WorkspaceChange[] }> {
  return request(`/api/workspaces/${encodeURIComponent(id)}/changes`)
}

// ---------------------------------------------------------------------------
// 配置编辑（S2-B，作用于活动工作区；无活动工作区时后端返回 code≠0）
// ---------------------------------------------------------------------------

/** 配置文件树节点。 */
export interface ConfigTreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: ConfigTreeNode[]
}

/** GET /api/configs/tree → 活动工作区 game/ 目录树。 */
export function fetchConfigTree(): Promise<{ tree: ConfigTreeNode }> {
  return request('/api/configs/tree')
}

/** GET /api/configs/file?path=rel → 文件内容与 schema 类型。 */
export interface ConfigFile {
  path: string
  content: string
  /** 'GameDefinition' | 'Archetype' | 'MapRegistry' | 规则名 | null（无 schema，不校验） */
  schemaKind: string | null
}

export function fetchConfigFile(path: string): Promise<ConfigFile> {
  return request(`/api/configs/file?path=${encodeURIComponent(path)}`)
}

/** 校验错误（jsonPath 定位字段；line 为 1-based 行号，可缺省）。 */
export interface ValidationError {
  jsonPath: string
  message: string
  line?: number
}

/** PUT /api/configs/file {path, content} → 成功 { path, valid: true }；校验失败 code 1 + detail.errors。 */
export interface ConfigSaveResult {
  path: string
  valid: true
}

export function saveConfigFile(path: string, content: string): Promise<ConfigSaveResult> {
  return request('/api/configs/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  })
}

/** POST /api/configs/validate {path, content} → 不落盘的当前文件校验。 */
export interface ConfigValidateResult {
  schemaKind: string | null
  valid: boolean
  errors: ValidationError[]
}

export function validateConfigFile(path: string, content: string): Promise<ConfigValidateResult> {
  return request('/api/configs/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  })
}

/** POST /api/configs/validate-all → 整体校验活动工作区全部配置。 */
export interface ConfigValidateAllResult {
  valid: boolean
  message: string
}

export function validateAllConfigs(): Promise<ConfigValidateAllResult> {
  return request('/api/configs/validate-all', { method: 'POST' })
}

/** 从 AdminApiError.detail 提取校验错误列表（PUT 校验失败：code 1 + detail.errors）。 */
export function extractValidationErrors(detail: unknown): ValidationError[] | null {
  if (typeof detail !== 'object' || detail === null) return null
  const errors = (detail as { errors?: unknown }).errors
  if (!Array.isArray(errors)) return null
  return errors.filter(
    (item): item is ValidationError =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { jsonPath?: unknown }).jsonPath === 'string' &&
      typeof (item as { message?: unknown }).message === 'string',
  )
}

// ---------------------------------------------------------------------------
// 配置上下文（S3-B）
// ---------------------------------------------------------------------------

/** 一侧（本体 / 工作区）的配置清单指纹摘要。 */
export interface ConfigContextSide {
  /** game/ 清单指纹（前端只做前 8 位摘要展示） */
  fingerprint: string
  fileCount: number
}

/** 活动工作区侧信息。 */
export interface ConfigContextWorkspace extends ConfigContextSide {
  id: string
  name: string
}

/** 工作区 vs 本体的逐文件对比（status 语义与工作区改动一致）。 */
export interface ConfigContextChange {
  path: string
  status: WorkspaceChangeStatus
}

/** GET /api/config-context → 预览闭环的配置上下文。 */
export interface ConfigContext {
  /** 本体 game/ 当前清单 */
  official: ConfigContextSide
  /** 活动工作区当前清单；无活动工作区 → null */
  workspace: ConfigContextWorkspace | null
  /** 活动工作区与本体一致；无工作区 → true */
  inSync: boolean
  /** 工作区 vs 本体逐文件对比 */
  changes: ConfigContextChange[]
}

export function fetchConfigContext(): Promise<ConfigContext> {
  return request('/api/config-context')
}

// ---------------------------------------------------------------------------
// 落盘与备份（S4-B）
// ---------------------------------------------------------------------------

/** 落盘计划中的单个文件（diff 为 unified 文本）。 */
export interface ApplyPlanFile {
  path: string
  status: WorkspaceChangeStatus
  additions: number
  deletions: number
  diff: string
  /** 本体当前内容；added → null */
  sourceContent: string | null
  /** 文件级校验（schemaKind null → true） */
  valid: boolean
  schemaKind: string | null
  validationErrors: ValidationError[]
}

/** POST /api/apply/plan → 工作区 vs 本体的落盘计划（只读，不落盘）。 */
export interface ApplyPlan {
  files: ApplyPlanFile[]
}

export function fetchApplyPlan(): Promise<ApplyPlan> {
  return request('/api/apply/plan', { method: 'POST' })
}

/** 落盘成功回执。 */
export interface ApplyReceipt {
  backupId: string
  applied: { path: string; status: WorkspaceChangeStatus }[]
  durationMs: number
}

/** POST /api/apply/execute {paths} → 写回本体（被覆盖/删除文件自动备份；成功后工作区 changes 归零）。 */
export function executeApply(paths: string[]): Promise<ApplyReceipt> {
  return request('/api/apply/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  })
}

/** 备份文件动作：覆盖 / 删除 / 新增。 */
export type BackupFileAction = 'overwritten' | 'deleted' | 'added'

export interface BackupFile {
  path: string
  action: BackupFileAction
}

export interface BackupMeta {
  backupId: string
  /** epoch ms（沿用时间约定；展示侧对 ISO 字符串兜底） */
  createdAt: number
  files: BackupFile[]
}

/** GET /api/backups → 备份列表。 */
export function fetchBackups(): Promise<{ items: BackupMeta[] }> {
  return request('/api/backups')
}

/** POST /api/backups/:backupId/rollback → 回滚（备份内容写回本体）。 */
export function rollbackBackup(
  backupId: string,
): Promise<{ restored: { path: string; action: BackupFileAction }[] }> {
  return request(`/api/backups/${encodeURIComponent(backupId)}/rollback`, { method: 'POST' })
}

/** execute 422 场景一：部分文件校验未通过（detail.invalid）。 */
export interface ApplyInvalidFile {
  path: string
  validationErrors: ValidationError[]
}

/** 从 AdminApiError.detail 提取 422 invalid 文件列表。 */
export function extractApplyInvalidFiles(detail: unknown): ApplyInvalidFile[] | null {
  if (typeof detail !== 'object' || detail === null) return null
  const invalid = (detail as { invalid?: unknown }).invalid
  if (!Array.isArray(invalid)) return null
  return invalid.filter(
    (item): item is ApplyInvalidFile =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { path?: unknown }).path === 'string' &&
      Array.isArray((item as { validationErrors?: unknown }).validationErrors),
  )
}

/** 从 AdminApiError.detail 提取 message（422 整体校验未通过：detail.message）。 */
export function extractDetailMessage(detail: unknown): string | null {
  if (typeof detail !== 'object' || detail === null) return null
  const message = (detail as { message?: unknown }).message
  return typeof message === 'string' && message.trim() ? message : null
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
