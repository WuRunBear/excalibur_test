/**
 * 管理后端 API / WS 客户端（S1-D2）。
 *
 * - REST：统一解包 { code, message, detail }，code ≠ 0 抛 AdminApiError（携带后端 message）。
 *   基址默认 http://localhost:3100，可用 VITE_ADMIN_SERVER_URL 覆盖（参数化先例见 modules/net/config.ts）。
 *   寻址统一走 games/:gameId/<域>（adminGameUrl 构造；本期 gameId 固定 'gst'，T2.10 接游戏切换器）。
 * - WS：/ws?channel=<name> 频道订阅封装，断线按指数退避自动重连（1s 起，封顶 15s）。
 *   频道名统一带 gameId（channelInstanceState / channelInstanceLog / channelLive 构造）。
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

/**
 * 当前管理目标 gameId（T2.10：由游戏切换器 store 提供）。
 *
 * api 层不直接依赖 Pinia：main.ts 在 pinia 安装后经 setAdminGameIdReader 注入
 * games store 的读取器；未注入（单测 / 极早期调用）时回退默认游戏 'gst'。
 */
const FALLBACK_GAME_ID = 'gst'

let gameIdReader: () => string = () => FALLBACK_GAME_ID

/** 注入 gameId 读取器（main.ts 装配一次；测试可注入任意取值）。 */
export function setAdminGameIdReader(reader: () => string): void {
  gameIdReader = reader
}

/** 当前管理目标 gameId（游戏切换器选中项；初始 = 默认游戏）。 */
export function currentGameId(): string {
  return gameIdReader()
}

/**
 * REST url builder：统一构造 games/:gameId/<域>... 寻址（域内子路径可带查询串）。
 * 所有 REST 调用必须经此构造，禁止再硬编码旧 /api/<域> 路径（旧路径仅为兼容保留）。
 */
export function adminGameUrl(domainPath: string): string {
  return `/api/games/${currentGameId()}/${domainPath.replace(/^\/+/, '')}`
}

/** WS 频道白名单（镜像 server/src/ws/hub.ts 的模式校验；频道名统一带 gameId）。 */
export type AdminChannel =
  | `instance:state:${string}`
  | `instance:log:${string}:${InstanceRole}`
  | `live:${string}:${InstanceRole}`

/** WS 频道名：实例状态流 instance:state:{gameId}（双角色共用一条）。 */
export function channelInstanceState(): AdminChannel {
  return `instance:state:${currentGameId()}`
}

/** WS 频道名：实例日志流 instance:log:{gameId}:{role}。 */
export function channelInstanceLog(role: InstanceRole): AdminChannel {
  return `instance:log:${currentGameId()}:${role}`
}

/** WS 频道名：游戏观察采样流 live:{gameId}:{role}。 */
export function channelLive(role: InstanceRole): AdminChannel {
  return `live:${currentGameId()}:${role}`
}

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
  // 空 = 同源模式：REST 走相对路径（配合 vite dev proxy 的 /api、/ws 转发），
  // 页面经域名/反代部署时天然同源、无跨域问题；显式配置绝对地址则直连。
  return trimmed.replace(/\/+$/, '')
}

/** 管理后端 REST 基址（空串 = 同源相对路径）。 */
export const ADMIN_API_BASE = normalizeBaseUrl(
  import.meta.env.VITE_ADMIN_SERVER_URL as string | undefined,
)

/** WS 基址：显式基址推导（http→ws / https→wss）；同源模式下由页面 location 推导（https 页面自动 wss）。 */
export const ADMIN_WS_BASE = (() => {
  if (ADMIN_API_BASE) return ADMIN_API_BASE.replace(/^http/, 'ws')
  if (typeof window === 'undefined') return 'ws://localhost:3100'
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}`
})()

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

/** GET games/:gameId/instances → 双角色状态快照。 */
export async function fetchInstances(): Promise<{
  official: InstanceSnapshot
  preview: InstanceSnapshot
}> {
  return request(adminGameUrl('instances'))
}

/** POST games/:gameId/instances/:role/start → 启动实例（detail 为最新快照）。 */
export function startInstance(role: InstanceRole): Promise<InstanceSnapshot> {
  return request<InstanceSnapshot>(adminGameUrl(`instances/${role}/start`), { method: 'POST' })
}

/** POST games/:gameId/instances/:role/stop → 停止实例（树杀，等待退出归因）。 */
export function stopInstance(role: InstanceRole): Promise<InstanceSnapshot> {
  return request<InstanceSnapshot>(adminGameUrl(`instances/${role}/stop`), { method: 'POST' })
}

/** POST games/:gameId/instances/:role/restart → 重启实例（stop 完成后 start）。 */
export function restartInstance(role: InstanceRole): Promise<InstanceSnapshot> {
  return request<InstanceSnapshot>(adminGameUrl(`instances/${role}/restart`), { method: 'POST' })
}

/** 最近日志回填响应。 */
export interface RecentLogs {
  role: InstanceRole
  lines: LogMessage[]
}

/** GET games/:gameId/instances/:role/logs?lines=N → 环形缓冲最近 N 行（按时间正序）。 */
export function fetchRecentLogs(role: InstanceRole, lines = 200): Promise<RecentLogs> {
  return request<RecentLogs>(adminGameUrl(`instances/${role}/logs?lines=${lines}`))
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

/** GET games/:gameId/workspaces → 列表与当前活动工作区。 */
export interface WorkspaceList {
  activeId: string | null
  items: WorkspaceMeta[]
}

export function fetchWorkspaces(): Promise<WorkspaceList> {
  return request(adminGameUrl('workspaces'))
}

/** POST games/:gameId/workspaces {name} → 新建并自动激活。 */
export function createWorkspace(name: string): Promise<WorkspaceMeta> {
  return request(adminGameUrl('workspaces'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

/** POST games/:gameId/workspaces/:id/activate → 激活（切换）工作区。 */
export function activateWorkspace(id: string): Promise<WorkspaceMeta> {
  return request(adminGameUrl(`workspaces/${encodeURIComponent(id)}/activate`), { method: 'POST' })
}

/** PATCH games/:gameId/workspaces/:id {name} → 重命名。 */
export function renameWorkspace(id: string, name: string): Promise<WorkspaceMeta> {
  return request(adminGameUrl(`workspaces/${encodeURIComponent(id)}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

/** DELETE games/:gameId/workspaces/:id → 删除（仅隔离副本，本体无痕）。 */
export function deleteWorkspace(id: string): Promise<{ id: string }> {
  return request(adminGameUrl(`workspaces/${encodeURIComponent(id)}`), { method: 'DELETE' })
}

/** 改动文件状态。 */
export type WorkspaceChangeStatus = 'added' | 'modified' | 'deleted'

export interface WorkspaceChange {
  path: string
  status: WorkspaceChangeStatus
}

/** GET games/:gameId/workspaces/:id/changes → 改动文件清单。 */
export function fetchWorkspaceChanges(id: string): Promise<{ files: WorkspaceChange[] }> {
  return request(adminGameUrl(`workspaces/${encodeURIComponent(id)}/changes`))
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

/** GET games/:gameId/configs/tree → 活动工作区 game/ 目录树。 */
export function fetchConfigTree(): Promise<{ tree: ConfigTreeNode }> {
  return request(adminGameUrl('configs/tree'))
}

/** GET games/:gameId/configs/file?path=rel → 文件内容与 schema 类型。 */
export interface ConfigFile {
  path: string
  content: string
  /** 'GameDefinition' | 'Archetype' | 'MapRegistry' | 规则名 | null（无 schema，不校验） */
  schemaKind: string | null
}

export function fetchConfigFile(path: string): Promise<ConfigFile> {
  return request(adminGameUrl(`configs/file?path=${encodeURIComponent(path)}`))
}

/** 校验错误（jsonPath 定位字段；line 为 1-based 行号，可缺省）。 */
export interface ValidationError {
  jsonPath: string
  message: string
  line?: number
}

/** PUT games/:gameId/configs/file {path, content} → 成功 { path, valid: true }；校验失败 code 1 + detail.errors。 */
export interface ConfigSaveResult {
  path: string
  valid: true
}

export function saveConfigFile(path: string, content: string): Promise<ConfigSaveResult> {
  return request(adminGameUrl('configs/file'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  })
}

/** POST games/:gameId/configs/validate {path, content} → 不落盘的当前文件校验。 */
export interface ConfigValidateResult {
  schemaKind: string | null
  valid: boolean
  errors: ValidationError[]
}

export function validateConfigFile(path: string, content: string): Promise<ConfigValidateResult> {
  return request(adminGameUrl('configs/validate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  })
}

/** POST games/:gameId/configs/validate-all → 整体校验活动工作区全部配置。 */
export interface ConfigValidateAllResult {
  valid: boolean
  message: string
}

export function validateAllConfigs(): Promise<ConfigValidateAllResult> {
  return request(adminGameUrl('configs/validate-all'), { method: 'POST' })
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

/** GET games/:gameId/config-context → 预览闭环的配置上下文。 */
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
  return request(adminGameUrl('config-context'))
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

/** POST games/:gameId/apply/plan → 工作区 vs 本体的落盘计划（只读，不落盘）。 */
export interface ApplyPlan {
  files: ApplyPlanFile[]
}

export function fetchApplyPlan(): Promise<ApplyPlan> {
  return request(adminGameUrl('apply/plan'), { method: 'POST' })
}

/** 落盘成功回执。 */
export interface ApplyReceipt {
  backupId: string
  applied: { path: string; status: WorkspaceChangeStatus }[]
  durationMs: number
}

/** POST games/:gameId/apply/execute {paths} → 写回本体（被覆盖/删除文件自动备份；成功后工作区 changes 归零）。 */
export function executeApply(paths: string[]): Promise<ApplyReceipt> {
  return request(adminGameUrl('apply/execute'), {
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

/** GET games/:gameId/backups → 备份列表。 */
export function fetchBackups(): Promise<{ items: BackupMeta[] }> {
  return request(adminGameUrl('backups'))
}

/** POST games/:gameId/backups/:backupId/rollback → 回滚（备份内容写回本体）。 */
export function rollbackBackup(
  backupId: string,
): Promise<{ restored: { path: string; action: BackupFileAction }[] }> {
  return request(adminGameUrl(`backups/${encodeURIComponent(backupId)}/rollback`), {
    method: 'POST',
  })
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

// ---------------------------------------------------------------------------
// 地图工具（S5-B）
// ---------------------------------------------------------------------------

/** 地图配置来源：活动工作区 registry（默认）或本体。 */
export type MapSource = 'workspace' | 'official'

export interface MapPipelineStep {
  generator: string
  params?: Record<string, unknown>
}

/** registry.json 单图条目（tiled 图无 pipeline）。 */
export interface MapSummary {
  key: string
  kind: 'pipeline' | 'tiled'
  seed?: number
  initialAgeTicks?: number
  pipeline?: MapPipelineStep[]
}

/** GET games/:gameId/maps?source= → 地图清单（保留 registry 声明顺序）。 */
export interface MapsPayload {
  source: MapSource
  maps: MapSummary[]
}

export function fetchMaps(source: MapSource): Promise<MapsPayload> {
  return request(adminGameUrl(`maps?source=${source}`))
}

/**
 * POST games/:gameId/maps/:key/geometry → 序列化几何快照。
 * tiles / walkable / regionOfTile 为行主序扁平数组（长度 = width × height）；
 * regions 键为区域名，regionOfTile 值为 regions 键序的索引（无区域为负值）。
 */
export interface MapGeometryPayload {
  key: string
  grid: { width: number; height: number; tileWidth?: number; tileHeight?: number }
  tiles: number[]
  walkable: number[]
  regions: Record<string, { name: string; meta?: Record<string, unknown> }>
  regionOfTile: number[]
  version: string
}

export function fetchMapGeometry(key: string, source: MapSource): Promise<MapGeometryPayload> {
  return request(adminGameUrl(`maps/${encodeURIComponent(key)}/geometry`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  })
}

/** 导出 URL（直接 a[download] / window.open 下载；palette 暂未接 UI，预留）。 */
export function mapExportUrl(key: string, source: MapSource, format: 'png' | 'json'): string {
  return `${ADMIN_API_BASE}${adminGameUrl(`maps/${encodeURIComponent(key)}/export?source=${source}&format=${format}`)}`
}

/** GET games/:gameId/maps/entity-rules?source= → 演化规则（原样 JSON，entries 引用 map/region）。 */
export interface EntityRulesPayload {
  source: MapSource
  rules: unknown
}

export function fetchEntityRules(source: MapSource): Promise<EntityRulesPayload> {
  return request(adminGameUrl(`maps/entity-rules?source=${source}`))
}

// ---------------------------------------------------------------------------
// 存档管理（S6-B）
// ---------------------------------------------------------------------------

/** 存档范围：本体 data/saves 或活动工作区 .preview-saves。 */
export type SaveScope = 'official' | 'preview'

/** WorldRecord 摘要（解析失败 / 非 WorldRecord → null）。 */
export interface SaveSummary {
  tick: number
  savedAt: number
  mapCount: number
  entityCount: number
  timeOfDay: { hour: number; phase: number } | null
  kindStats: Record<string, number>
}

export interface SaveEntry {
  file: string
  /** 文件名去 .json */
  saveId: string
  sizeBytes: number
  mtime: number
  summary: SaveSummary | null
}

/** GET games/:gameId/saves?scope= → 存档清单。 */
export interface SavesPayload {
  scope: SaveScope
  dir: string
  saves: SaveEntry[]
}

export function fetchSaves(scope: SaveScope): Promise<SavesPayload> {
  return request(adminGameUrl(`saves?scope=${scope}`))
}

/** GET games/:gameId/saves/:file/detail?scope= → 存档详情。 */
export interface SaveDetailPayload {
  file: string
  summary: SaveSummary | null
  maps: { mapKey: string }[]
  topKinds: { kind: string; count: number }[]
}

export function fetchSaveDetail(file: string, scope: SaveScope): Promise<SaveDetailPayload> {
  return request(adminGameUrl(`saves/${encodeURIComponent(file)}/detail?scope=${scope}`))
}

/** DELETE games/:gameId/saves/:file?scope= → 删除存档。 */
export function deleteSave(file: string, scope: SaveScope): Promise<{ file: string }> {
  return request(adminGameUrl(`saves/${encodeURIComponent(file)}?scope=${scope}`), {
    method: 'DELETE',
  })
}

/** 存档下载 URL（浏览器直接下载）。 */
export function saveDownloadUrl(file: string, scope: SaveScope): string {
  return `${ADMIN_API_BASE}${adminGameUrl(`saves/${encodeURIComponent(file)}/download?scope=${scope}`)}`
}

/** POST games/:gameId/saves/:file/restore?scope= → 恢复为活跃存档。 */
export interface SaveRestorePayload {
  restoredTo: string
  /** official scope 下提示需重启实例（存档在启动时加载） */
  warnRestart: boolean
}

export function restoreSave(file: string, scope: SaveScope): Promise<SaveRestorePayload> {
  return request(adminGameUrl(`saves/${encodeURIComponent(file)}/restore?scope=${scope}`), {
    method: 'POST',
  })
}

// ---------------------------------------------------------------------------
// 注册表（S6-B）
// ---------------------------------------------------------------------------

/**
 * GET games/:gameId/registries → 五类注册表。
 * 条目形状宽容：systems/archetypes 为对象数组（id 类字段），actions 含 name，
 * components 只取键（值为 null），mapGenerators 为 {id} 数组。
 */
export interface RegistriesPayload {
  systems: unknown
  archetypes: unknown
  actions: unknown
  components: unknown
  mapGenerators: unknown
}

export function fetchRegistries(): Promise<RegistriesPayload> {
  return request(adminGameUrl('registries'))
}

// ---------------------------------------------------------------------------
// 游戏管理（T2.10：列表 / 详情 / 导入 / sync / PATCH / 移除）
// 注意：games 管理面自身不按"当前 gameId"寻址——列表与导入是全表操作，
// 详情/sync/PATCH/DELETE 显式带目标 gameId（可查看未选中的游戏）。
// ---------------------------------------------------------------------------

/** 游戏来源：git 仓库（平台 clone 到 server/games/<id>/checkout）或本地路径。 */
export interface GameSourceGit {
  type: 'git'
  url: string
  ref: string
}

export interface GameSourceLocal {
  type: 'local'
  path: string
}

export type GameSource = GameSourceGit | GameSourceLocal

/** 同步状态指纹（空串 = 尚未同步/未知，由导入/同步流程回填）。 */
export interface GameResolved {
  /** git 源 = 平台 clone 的 HEAD；local 源 = 源目录 git HEAD（非 git 为 mtime hash 标注值）。 */
  commit: string
  /** ISO 8601。 */
  syncedAt: string
  /** pnpm-lock.yaml 的 sha256（前端不解读）。 */
  lockfileHash: string
}

/** sidecar 状态摘要（GET /api/games 列表项内联；describe 不触发 driver spawn）。 */
export interface GameSidecarSummary {
  fingerprint: string
  fingerprintSource: string
  alive: boolean
  pid: number | null
  spawnFailures: number
  /** 连续 spawn 失败原因；null = 未进入不可用态。 */
  unavailable: string | null
}

/** GET /api/games 列表项。 */
export interface GameListItem {
  id: string
  name: string
  isDefault: boolean
  source: GameSource
  resolved: GameResolved
  ports: { official: number; preview: number }
  /** ISO 8601。 */
  createdAt: string
  /** 导入/同步进行中（期间该游戏的领域调用返回 409）。 */
  isImporting: boolean
  sidecar: GameSidecarSummary
}

export interface GameListPayload {
  defaultGameId: string
  games: GameListItem[]
}

/** GET /api/games → 注册游戏列表 + 默认游戏 id。 */
export function fetchGames(): Promise<GameListPayload> {
  return request('/api/games')
}

/** 接入清单（镜像 server/games/<id>/game.json 的 schema；T2.2 探测生成）。 */
export interface GameManifest {
  id: string
  configDir: string
  configEntry: string
  savesDir: string
  logsDir: string
  envFile: string
  start: { command: string; args: string[] }
  /** preview 实例注入的环境变量名（值由服务端 spawn 前解析）。 */
  envInjection: { port: string; configPath: string; saveDir: string }
  schemaRoutes: { pattern: string; kind: string }[]
  capabilities: { wholeConfigValidation: boolean; mapGeometry: boolean; registries: string[] }
  observer: {
    plugin: string
    roomName: string
    clientSchema?: { source: string; stateDir: string }
  }
  trustScripts?: boolean
}

/** sidecar 状态（GET 详情；client 为 driver 进程快照）。 */
export interface GameSidecarStatus {
  gameId: string
  fingerprint: string
  fingerprintSource: string
  client: {
    alive: boolean
    pid: number | null
    spawnFailures: number
    unavailable: string | null
    pendingRequests?: number
  }
}

/**
 * GET /api/games/:gameId → registry entry + manifest + sidecar 状态。
 * manifest 为 null = 未探测（GET 零副作用，不现场生成；见游戏详情页劣化态）。
 */
export interface GameDetail {
  id: string
  name: string
  isDefault: boolean
  source: GameSource
  resolved: GameResolved
  ports: { official: number; preview: number }
  createdAt: string
  manifest: GameManifest | null
  sidecar: GameSidecarStatus
}

export function fetchGameDetail(gameId: string): Promise<GameDetail> {
  return request(`/api/games/${encodeURIComponent(gameId)}`)
}

/** POST /api/games/import 入参（source 二选一；id/name 省略时服务端从来源推导）。 */
export interface ImportGameParams {
  source: GameSource
  id?: string
  name?: string
}

/** 冒烟结果（五类注册表计数）。 */
export interface SmokeCounts {
  systems: number
  archetypes: number
  actions: number
  components: number
  mapGenerators: number
}

/** 导入/同步结果。 */
export interface GameSyncResult {
  gameId: string
  action: 'imported' | 'updated' | 'noop'
  commit: string
  lockfileHash: string
  fingerprintSource: 'git' | 'git-head' | 'dir-mtime'
  ports?: { official: number; preview: number }
  /** 本次是否实际执行了 pnpm install（git 源）。 */
  installRan: boolean
  smoke?: SmokeCounts
  notes: string[]
}

/**
 * POST /api/games/import → 导入新游戏。请求挂起至全流程完成（git clone/install
 * 可达分钟级）；失败时 detail 可能携带 stderrTail（command_failed 场景）。
 */
export function importGame(params: ImportGameParams): Promise<GameSyncResult> {
  return request('/api/games/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
}

/** POST /api/games/:gameId/sync → 幂等更新（git 源 fetch+checkout；local 源重探测）。 */
export function syncGame(gameId: string): Promise<GameSyncResult> {
  return request(`/api/games/${encodeURIComponent(gameId)}/sync`, { method: 'POST' })
}

/**
 * PATCH /api/games/:gameId → registry 字段（name/isDefault/source.path|ref）与
 * manifest 高级字段（start/envInjection/schemaRoutes/roomName/trustScripts）；
 * 只传需要变更的键；改后 sidecar 上下文重建（lazy）。
 */
export function patchGame(gameId: string, body: Record<string, unknown>): Promise<GameDetail> {
  return request(`/api/games/${encodeURIComponent(gameId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** DELETE /api/games/:gameId → 移除注册项与平台侧数据（workspaces/backups 保留）。 */
export function deleteGame(
  gameId: string,
): Promise<{ gameId: string; action: 'removed'; notes: string[] }> {
  return request(`/api/games/${encodeURIComponent(gameId)}`, { method: 'DELETE' })
}

/** 从 AdminApiError.detail 提取 command_failed 场景的 stderr 尾部（导入失败回显用）。 */
export function extractStderrTail(detail: unknown): string | null {
  if (typeof detail !== 'object' || detail === null) return null
  const tail = (detail as { stderrTail?: unknown }).stderrTail
  return typeof tail === 'string' && tail.trim() ? tail : null
}

// ---------------------------------------------------------------------------
// 游戏观察（S7-B：liveState 观察服务契约）
// ---------------------------------------------------------------------------

/** 单条运行采样（WS live:{gameId}:{role} 每秒一条；REST 回填同构）。 */
export interface LiveSample {
  /** 采样时间（epoch ms） */
  ts: number
  /** 服务端 tick 序号 */
  tick: number
  /** 每秒采样数（≈服务端 tick 速率，正常在 20 附近） */
  tickRate: number
  /** 实体总数 */
  entityCount: number
}

/** GET games/:gameId/live/samples 响应：samples 旧→新，环形缓冲最多 300 条。 */
export interface LiveSamplesPayload {
  role: InstanceRole
  samples: LiveSample[]
}

/** GET games/:gameId/live/samples?role=&limit= → 指定角色的最近采样回填。 */
export function fetchLiveSamples(role: InstanceRole, limit = 120): Promise<LiveSamplesPayload> {
  return request<LiveSamplesPayload>(adminGameUrl(`live/samples?role=${role}&limit=${limit}`))
}

/** WS live:{gameId}:{role} 单条消息负载（每秒一条）。 */
export type LiveSampleMessage = LiveSample & { role: InstanceRole }

/** 校验 WS live 消息形状（字段缺失 / 类型不符时丢弃，不进缓冲）。 */
export function isLiveSampleMessage(value: unknown): value is LiveSampleMessage {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    (v.role === 'official' || v.role === 'preview') &&
    typeof v.ts === 'number' &&
    typeof v.tick === 'number' &&
    typeof v.tickRate === 'number' &&
    typeof v.entityCount === 'number'
  )
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
