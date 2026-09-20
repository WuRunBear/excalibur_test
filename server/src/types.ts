/**
 * 管理后端共享类型（S1-C）。
 *
 * 独立成模块以避免 config ↔ services 之间的循环依赖：
 * config 只依赖本文件的类型，services/ 引入 config 与本文件。
 */

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
  role: InstanceRole
  status: InstanceStatus
  /** 游戏进程树根 pid（pnpm dev 的直接子进程）；未运行时为 null */
  pid: number | null
  /** 最近一次 start 成功发起的时间（epoch ms）；未运行时保留上次值 */
  startedAt: number | null
  /** 展示端口：official 由本体 .env/OFFICIAL_PORT 解析；preview 固定 3200 */
  port: number
  /** 最近一次退出的退出码（被信号杀死时为 null） */
  lastExitCode: number | null
  /** 最近一次退出的信号（正常退出时为 null） */
  lastSignal: NodeJS.Signals | null
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
