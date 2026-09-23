/**
 * 管理后端共享类型（S1-C）。
 *
 * 独立成模块以避免 config ↔ services 之间的循环依赖：
 * config 只依赖本文件的类型，services/ 引入 config 与本文件。
 */
import type {
  RegistryActionEntry as ActionEntry,
  RegistryArchetypeSpec as ArchetypeSpec,
  RegistrySystemSpec as SystemSpec,
} from './sidecar/protocol.js'

/** 实例角色：正式服 / 预览服。 */
export type InstanceRole = 'official' | 'preview'

/**
 * 实例状态机：stopped → starting → running →（crashed | stopped）。
 * - starting：spawn 已发起，等待子进程成功拉起（'spawn' 事件）
 * - running：子进程存活
 * - crashed：非管理端发起的退出（外部杀死 / 自身崩溃 / spawn 失败）
 * - stopped：管理端主动停止后的正常退出
 */
export type InstanceStatus = 'stopped' | 'starting' | 'running' | 'crashed'

/** 实例状态快照（REST 与 WS 广播共用结构）。 */
export interface InstanceSnapshot {
  /** 所属游戏（T2.4 per-game 实例化：snapshot 增 gameId 字段，REST/WS 消费方可区分来源游戏）。 */
  gameId: string
  role: InstanceRole
  status: InstanceStatus
  /** 游戏进程树根 pid（pnpm dev 的直接子进程）；未运行时为 null */
  pid: number | null
  /** 最近一次 start 成功发起的时间（epoch ms）；未运行时保留上次值 */
  startedAt: number | null
  /** 展示端口：official 由本体 .env/OFFICIAL_PORT 解析；preview 固定 3200 */
  port: number
  lastExitCode: number | null
  lastSignal: NodeJS.Signals | null
  /**
   * S3-A：本次启动注入的 GAME_CONFIG_PATH（工作区 game.json 绝对路径）。
   * preview 保留上次启动的值（crash 后不清空）；回退本体配置或 official → null。
   */
  configPath: string | null
  /** S3-A：本次启动注入的 SAVE_DIR（工作区 .preview-saves）；回退/official → null */
  saveDir: string | null
}

/** 进程流来源（stdout / stderr）。 */
export type ProcessSource = 'stdout' | 'stderr'

/** 日志来源：日志文件 tail / 进程 stdout / 进程 stderr。 */
export type LogSource = ProcessSource | 'file'

/** 单条日志消息（环形缓冲 / REST 回填 / WS 广播共用结构）。 */
export interface LogMessage {
  role: InstanceRole
  source: LogSource
  /** 启发式提取的级别（info/warn/error/debug），提取不到为 undefined（JSON 序列化时省略） */
  level?: string
  text: string
  /** 时间戳（epoch ms） */
  ts: number
}

// ---------------------------------------------------------------------------
// S2-A：工作区 / 配置读写
// ---------------------------------------------------------------------------

/** 工作区元信息（REST WorkspaceMeta）。 */
export interface WorkspaceMeta {
  id: string
  name: string
  /** 创建时间（epoch ms） */
  createdAt: number
  /** 基线指纹（镜像生成时对全部文件哈希的聚合，sha256 前 16 位） */
  baseFingerprint: string
  /** 相对基线的变更文件数（added+modified+deleted） */
  changedFiles: number
}

/** 单个文件的变更状态（当前镜像 vs .base-manifest.json）。 */
export interface WorkspaceChange {
  path: string
  status: 'added' | 'modified' | 'deleted'
}

/** 配置文件树节点（目录在前、同级字典序）。 */
export interface ConfigTreeNode {
  name: string
  /** 相对工作区 game 目录的路径（'/' 分隔） */
  path: string
  type: 'dir' | 'file'
  children?: ConfigTreeNode[]
}

/** 配置校验错误（jsonPath 如 "components[0].kind"；line 为启发式定位，尽力而为）。 */
export interface ConfigValidationError {
  jsonPath: string
  message: string
  line?: number
}

// ---------------------------------------------------------------------------
// S5-A：地图工具（geometry 预览 / 导出 / 双源）
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

/** GET /api/maps 响应 detail（保留 registry 声明顺序）。 */
export interface MapsPayload {
  source: MapSource
  maps: MapSummary[]
}

/** GET /api/maps/entity-rules 响应 detail（rules 为 entity-rules.json 原样 JSON）。 */
export interface EntityRulesPayload {
  source: MapSource
  rules: unknown
}

// ---------------------------------------------------------------------------
// S6-A：存档管理
// ---------------------------------------------------------------------------

/** 存档目录范围：本体 data/saves 或活动工作区 .preview-saves。 */
export type SaveScope = 'official' | 'preview'

/** WorldRecord 摘要（解析失败/非 WorldRecord → null）。 */
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
  /** 文件名去 .json（即该存档的 saveId） */
  saveId: string
  sizeBytes: number
  mtime: number
  summary: SaveSummary | null
}

/** GET /api/saves 响应 detail。 */
export interface SavesPayload {
  scope: SaveScope
  dir: string
  saves: SaveEntry[]
}

/** GET /api/saves/:file/detail 响应 detail。 */
export interface SaveDetailPayload {
  file: string
  summary: SaveSummary | null
  maps: { mapKey: string }[]
  topKinds: { kind: string; count: number }[]
}

/** POST /api/saves/:file/restore 响应 detail。 */
export interface SaveRestorePayload {
  restoredTo: string
  /** official scope 下提示需重启实例（存档在启动时加载） */
  warnRestart: boolean
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

/** GET /api/registries 响应 detail。components 只取键（值置 null，避免巨大输出）。 */
export interface RegistriesPayload {
  systems: SystemSpec[]
  archetypes: ArchetypeSpec[]
  actions: ActionEntry[]
  components: Record<string, null>
  mapGenerators: { id: string }[]
}

// ---------------------------------------------------------------------------
// S7-A：liveState 观察（运行指标采样）
// ---------------------------------------------------------------------------

/** 单个运行指标样本（每 1000ms 一次；WS live:{role} 推送与回填同结构）。 */
export interface LiveSample {
  role: InstanceRole
  /** 采样时间戳（epoch ms） */
  ts: number
  /** 房间状态 tick（uint32） */
  tick: number
  /** tick 增量速率（tick/s，3 次滑动平均平滑；首样本 0） */
  tickRate: number
  /** 观察者 PlayerState.visibleEntities.size（兴趣裁剪后的可见实体数） */
  entityCount: number
}

/** GET /api/live/samples 响应 detail（samples 旧→新）。 */
export interface LiveSamplesPayload {
  role: InstanceRole
  samples: LiveSample[]
}

// ---------------------------------------------------------------------------
// S3-A：配置上下文（本体 vs 工作区 同步状态）
// ---------------------------------------------------------------------------

/** 一侧配置目录的清单级摘要（fingerprint 与工作区基线同算法）。 */
export interface ConfigContextSummary {
  fingerprint: string
  fileCount: number
}

/** 活动工作区的清单级摘要。 */
export interface WorkspaceConfigSummary extends ConfigContextSummary {
  id: string
  name: string
}

/** GET /api/config-context 响应 detail。 */
export interface ConfigContextPayload {
  /** 本体 game/ 当前清单 */
  official: ConfigContextSummary
  /** 活动工作区当前清单；无活动工作区 → null */
  workspace: WorkspaceConfigSummary | null
  /** workspace 与本体 fingerprint 是否一致；workspace 为 null → true */
  inSync: boolean
  /** 活动工作区 vs 本体 game/ 逐文件对比；无活动工作区 → [] */
  changes: WorkspaceChange[]
}

// ---------------------------------------------------------------------------
// S4-A：落盘（Apply）/ 备份 / 回滚
// ---------------------------------------------------------------------------

/** 落盘计划中的单文件条目。 */
export interface ApplyFilePlan {
  path: string
  status: 'added' | 'modified' | 'deleted'
  /** unified diff 统计：新增行数 */
  additions: number
  /** unified diff 统计：删除行数 */
  deletions: number
  /** unified diff 文本（本体旧文 vs 工作区新文；added 本体侧为空，deleted 工作区侧为空） */
  diff: string
  /** 本体当前文件内容：added → null，modified/deleted → 本体旧文 */
  sourceContent: string | null
  /** 工作区内容的文件级校验（deleted → true；schemaKind null → true） */
  valid: boolean
  schemaKind: string | null
  validationErrors: ConfigValidationError[]
}

/** POST /api/apply/plan 响应 detail。 */
export interface ApplyPlanPayload {
  files: ApplyFilePlan[]
}

/** 落盘执行后的单文件结果（action 语义同备份条目）。 */
export interface AppliedFile {
  path: string
  status: 'added' | 'modified' | 'deleted'
}

/** POST /api/apply/execute 响应 detail。 */
export interface ApplyExecutePayload {
  backupId: string
  applied: AppliedFile[]
  durationMs: number
}

/** 备份内单文件条目：action 描述落盘时对本体做的动作。 */
export type BackupFileAction = 'overwritten' | 'deleted' | 'added'
export interface BackupFileEntry {
  path: string
  action: BackupFileAction
}

/** 单个备份的 manifest 摘要。 */
export interface BackupInfo {
  backupId: string
  createdAt: number
  files: BackupFileEntry[]
}

/** GET /api/backups 响应 detail（createdAt 倒序）。 */
export interface BackupListPayload {
  items: BackupInfo[]
}

/** POST /api/backups/:backupId/rollback 响应 detail（restored 为逆操作明细，action 沿用备份原值）。 */
export interface RollbackPayload {
  restored: BackupFileEntry[]
}
