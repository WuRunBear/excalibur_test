/**
 * sidecar 协议与 DTO 类型（T1.1，docs/multi-game-plan.md §3 T1.1 / §0.2 全局技术约定）。
 *
 * 本文件是 driver 侧（server/sidecar/driver.ts）与平台 client 侧
 * （server/src/sidecar/client.ts）共用的**唯一**协议契约：
 * - 只含类型定义，零 import、零运行时代码 → DTO 自包含，杜绝循环依赖
 *   （T1.7 起 server/src/types.ts 的类型来源也统一到本文件）。
 * - 所有跨进程 DTO 按"JSON 线上形状"声明：
 *   - 本体类型（framework 的 SerializedMapGeometry / MapGenerationConfig /
 *     TilePalette、注册表 spec 等）按形状最小重写——以 server/src/types.ts 与
 *     mapService 实际消费字段为准的最小字段集；TypeScript 结构类型保证与
 *     本体类型互相赋值兼容。
 *   - 函数值字段（SystemSpec.factory / ActionEntry.factory 等）经 JSON 序列化
 *     会被剔除，DTO 只保留线上实际存在的字段。
 *
 * 信封（§0.2）：stdio 每行一个 JSON
 *   请求  { id: number, method: string, params?: object }
 *   响应  { id: number, ok: true, result: any }
 *      或  { id: number | null, ok: false, error: { code, message } }
 *   （id=null 仅出现在"行不是合法 JSON / 缺 method"等无法归属请求的错误帧上。）
 *
 * 错误码（§0.2）：bad_request（参数形状错→400）| game_config_error（校验不过/
 * 生成失败→422）| driver_error（driver 内部异常→500）| unavailable（进程 down
 * 且重启失败→503）| timeout（→504）。driver 只产生前三个；unavailable 与
 * timeout 由平台侧 client 产生。
 */

// ---------------------------------------------------------------------------
// 信封
// ---------------------------------------------------------------------------

export type SidecarErrorCode =
  | 'bad_request'
  | 'game_config_error'
  | 'driver_error'
  | 'unavailable'
  | 'timeout'

/** 错误帧的 error 形状。 */
export interface SidecarErrorShape {
  code: SidecarErrorCode
  message: string
}

/** 请求帧（stdin，NDJSON）。 */
export interface SidecarRequest {
  id: number
  method: string
  params?: Record<string, unknown>
}

/** 成功响应帧（stdout，NDJSON）。 */
export interface SidecarSuccessFrame<R = unknown> {
  id: number
  ok: true
  result: R
}

/**
 * 错误响应帧。id 为 null 仅在无法归属请求时出现（行非法 JSON / 缺 method /
 * params 形状错 / 未知 method 且 id 本身不可用）。
 */
export interface SidecarErrorFrame {
  id: number | null
  ok: false
  error: SidecarErrorShape
}

export type SidecarResponseFrame<R = unknown> = SidecarSuccessFrame<R> | SidecarErrorFrame

// ---------------------------------------------------------------------------
// 跨进程共享的基础形状（按本体类型形状最小重写）
// ---------------------------------------------------------------------------

/** zod issue 的线上形状（§0.2）：只取 path/message，path 已过滤 symbol。 */
export interface SidecarZodIssue {
  path: (string | number)[]
  message: string
}

/** 地图网格信息（= 本体 MapGeometryGrid）。 */
export interface SerializedMapGrid {
  /** 地图宽度（tile 数）。 */
  width: number
  /** 地图高度（tile 数）。 */
  height: number
  /** 单个 tile 的宽度（像素）。 */
  tileWidth: number
  /** 单个 tile 的高度（像素）。 */
  tileHeight: number
}

/** 区域元信息（= 本体 RegionMeta）。 */
export interface SerializedRegionMeta {
  /** 区域名称（与 regions 对象的键一致）。 */
  name: string
  /** 自由元信息。 */
  meta: Record<string, unknown>
}

/**
 * MapGeometry 的 JSON 可序列化快照（按本体 framework/map/geometry/snapshot.ts
 * 的 SerializedMapGeometry 形状重写；类型化数组编码为普通 number[]，
 * regions Map 编码为普通对象）。
 */
export interface SerializedMapGeometry {
  /** 地图 key。 */
  key: string
  /** 网格信息。 */
  grid: SerializedMapGrid
  /** 每格地面语义 id（number[] 形态）。 */
  tiles: number[]
  /** 每格通行位图（number[] 形态）。 */
  walkable: number[]
  /** 区域名 → 区域元信息（普通对象形态）。 */
  regions: Record<string, SerializedRegionMeta>
  /** 每格所属区域索引（number[] 形态）。 */
  regionOfTile: number[]
  /** 内容指纹。 */
  version: string
}

/** 管道单步骤声明（= 本体 MapGenerationStep）。 */
export interface MapGenerationStep {
  /** 积木注册名（generatorRegistry 中的 id）。 */
  generator: string
  /** 该步骤的自有参数切片（可选，原样透传给积木）。 */
  params?: Record<string, unknown>
}

/**
 * 单张地图的生成配置（按本体 map/generate/types.ts 的 MapGenerationConfig
 * 形状重写；mapService.buildGeometry 内联 tiledPath 后组装的最小形状）。
 */
export interface MapGenerationConfig {
  /** 地图 key（registry 中的稳定标识）。 */
  key: string
  /** 随机种子。 */
  seed: number
  /** 积木管道（按声明顺序执行）。 */
  pipeline: MapGenerationStep[]
}

/** RGBA 颜色值（固定四元组，= 本体 exportGenerated 的 Rgba）。 */
export type Rgba = readonly [number, number, number, number]

/**
 * 语义 id → RGBA 色表（按本体 TilePalette 形状重写）。
 * JSON 线上传输后键为字符串（JS 对象键本就是字符串），数值键访问语义不变。
 */
export type TilePalette = Readonly<Record<number, Rgba>>

// ---------------------------------------------------------------------------
// 注册表 DTO（listRegistries 结果；函数值字段经 JSON 序列化剔除后的线上形状）
// ---------------------------------------------------------------------------

/**
 * 注册表条目公共形状（P1 扩展）：id + 可选元数据。configSchema 为
 * `z.toJSONSchema` 输出的标准 JSON Schema 子集；无元数据时字段缺省。
 * 其余本体 register 元数据字段（如 systems 的 after/before）宽容保留。
 */
export interface RegistriesEntry {
  id: string
  /** 功能介绍（编辑器面板展示）。 */
  description?: string
  /** 条目参数 JSON Schema（编辑器 config 子表单驱动；缺省前端降级源码）。 */
  configSchema?: unknown
  /** 其余未知字段宽容保留（形状漂移不破坏消费方）。 */
  [key: string]: unknown
}

/** SystemSpec 的线上形状（factory 函数被 JSON 序列化剔除）。 */
export interface RegistrySystemSpec extends RegistriesEntry {
  id: string
  after?: string[]
  before?: string[]
  defaultOrder?: number
}

/** ArchetypeSpec 的线上形状（全字段 JSON 安全；id=kind 供前端统一按 id 取用）。 */
export interface RegistryArchetypeSpec extends RegistriesEntry {
  id: string
  kind: string
  tags?: string[]
  components: Record<string, unknown>
  behavior?: string
  team?: number
}

/** ActionEntry 的线上形状（factory 函数被 JSON 序列化剔除；id=name）。 */
export interface RegistryActionEntry extends RegistriesEntry {
  id: string
}

/** listRegistries 结果（对齐 server/src/types.ts 的 RegistriesPayload 线上形状）。 */
export interface ListRegistriesResult {
  systems: RegistrySystemSpec[]
  archetypes: RegistryArchetypeSpec[]
  actions: RegistryActionEntry[]
  /** 组件名 → 条目元数据（无元数据为 null；避免不可序列化的组件对象上线路）。 */
  components: Record<string, RegistriesEntry | null>
  mapGenerators: RegistriesEntry[]
}

// ---------------------------------------------------------------------------
// getSchema（P1：SCHEMA_TABLE 的 16 个 kind → JSON Schema；P5 §1.3 扩展）
// ---------------------------------------------------------------------------

export interface GetSchemaParams {
  /** schema kind（登记的 16 个 kind 之一；未登记 → bad_request）。 */
  kind: string
}

export interface GetSchemaResult {
  /** `z.toJSONSchema(schema, { metadata: registry, reused: "inline" })` 输出。 */
  jsonSchema: unknown
}

// ---------------------------------------------------------------------------
// 各方法参数 / 结果 DTO
// ---------------------------------------------------------------------------

/** ping 结果（含 zod 版本与 framework 自检；依赖单实例化证明用）。 */
export interface PingResult {
  pong: true
  /** driver 进程内解析到的 zod 版本（预期为本体的 4.4.3，非 server 的 4.6.5）。 */
  zodVersion: string
  /** framework 门面关键导出可用性自检（不触发 bootstrap）。 */
  frameworkOk: boolean
  pid: number
  rss: number
  gameRoot: string
}

// validateFile ----------------------------------------------------------------

export interface ValidateFileParams {
  /** schema kind（登记的 16 个 kind 之一；未登记 → bad_request）。 */
  kind: string
  /** 待校验的 JSON 值（平台侧已完成 JSON.parse）。 */
  data: unknown
}

export interface ValidateFileResult {
  valid: boolean
  /** 失败时的 zod issues（§0.2 形状）；成功为空数组。 */
  issues: SidecarZodIssue[]
}

// validateWhole ---------------------------------------------------------------

export interface ValidateWholeParams {
  /** game.json 绝对路径（存在性预检由 driver 负责，先于 loadGameDefinition）。 */
  gameJsonPath: string
}

export interface ValidateWholeResult {
  ok: boolean
  message: string
}

// buildMapGeometry ------------------------------------------------------------

export interface BuildMapGeometryParams {
  /** 平台侧完成 tiledPath 内联等文件 I/O 后的最终生成配置。 */
  config: MapGenerationConfig
}

// 结果 = SerializedMapGeometry（见上方共享形状）

// exportMapArtifacts ----------------------------------------------------------

export interface ExportMapArtifactsParams {
  config: MapGenerationConfig
  /** 语义 id → RGBA 色表（可选；缺省全部语义走兜底灰）。 */
  palette?: TilePalette
}

/** 导出结果：driver 写 os.tmpdir()/admin-map-export-<uuid>/ 后的路径三元组。 */
export interface ExportMapArtifactsResult {
  dir: string
  jsonPath: string
  pngPath: string
}

// ---------------------------------------------------------------------------
// 方法名 → 参数/结果 契约表（client 与 driver 共用；两侧各自实现同一张表）
// ---------------------------------------------------------------------------

export interface SidecarMethodMap {
  ping: { params: Record<string, never>; result: PingResult }
  listRegistries: { params: Record<string, never>; result: ListRegistriesResult }
  getSchema: { params: GetSchemaParams; result: GetSchemaResult }
  validateFile: { params: ValidateFileParams; result: ValidateFileResult }
  validateWhole: { params: ValidateWholeParams; result: ValidateWholeResult }
  buildMapGeometry: { params: BuildMapGeometryParams; result: SerializedMapGeometry }
  exportMapArtifacts: { params: ExportMapArtifactsParams; result: ExportMapArtifactsResult }
}

export type SidecarMethod = keyof SidecarMethodMap
