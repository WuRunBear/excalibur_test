/**
 * sidecar driver 正式版（T1.2；P1 新增 getSchema，现覆盖 7 个 RPC 方法）。
 *
 * 进程模型：由平台侧以 cwd=<GAME_ROOT>、tsx + 本体 tsconfig spawn 的常驻子进程。
 * 协议（docs/multi-game-plan.md §0.2）：
 *   请求  { id: number, method: string, params?: object }     —— stdin，NDJSON
 *   响应  { id, ok: true, result } | { id, ok: false, error: { code, message } } —— stdout，NDJSON
 *   行 JSON.parse 失败 → { id: null, ok: false, error: { code: 'bad_request', message } }
 *   错误码：bad_request（参数形状错）/ game_config_error（校验不过/生成失败）/ driver_error（内部异常）。
 *
 * stdout 纪律：stdout 只允许协议帧，一切诊断走 stderr。本体日志器基于 winston
 * 且带 Console transport（会向 process.stdout 写行，见 framework/utils/logger.ts），
 * 因此本模块在进入任何请求处理前把 process.stdout.write 整体重定向到 stderr，
 * 协议帧改用 fs.writeSync(1, …) 直写 fd 1——即使 framework 内部有 console 系列
 * 或 winston 输出也不可能混入帧流。已知限制：ESM 静态 import 提升使 framework 模块先于该
 * 补丁求值，若出现"模块加载期日志"仍会漏出（当前 framework 各模块无加载期日志，
 * spike 脚本会把任何非协议 stdout 行以 protocol violation 报出）。
 *
 * 引入路径实况（复刻 server/gameBridge/index.ts:11-25，即生产现状）：
 * - list* 系列注册表函数在 framework/api（门面不导出）；
 * - GameDefinitionSchema / bootstrapFramework / loadGameDefinition / 地图函数 /
 *   规则系 schema（RuleSchema）/ exportGeometryArtifacts 走 framework 门面；
 * - ArchetypeSchema / MapRegistrySchema 未走门面再导出，只能经别名子路径
 *   framework/config/schema/* 引入。
 * 上述别名由 tsx 加载本体 tsconfig.json（TSX_TSCONFIG_PATH / --tsconfig）解析。
 *
 * 与平台侧的类型共享（T1.1）：协议信封与全部 DTO 定义在
 * ../src/sidecar/protocol.ts（相对引用，无别名依赖，不受本文件由本体 tsconfig
 * 加载的影响）。protocol.ts 是纯类型模块，这里用 `import type` 引入——tsx/esbuild
 * 在运行时整体擦除，不产生任何运行时加载；类型层面则让 driver 的框架类型返回值
 * 持续受协议 DTO 结构约束（形状漂移会在编译期暴露）。
 *
 * schema kind 表：configService.ts:49-58 的 SCHEMA_TABLE 完整迁入；P5 §1.3 起
 * 再纳入 validateWhole 逐文件消费的 8 个 schema，共 16 个 kind。
 * 平台侧从此不持有任何 zod 对象。未登记 kind → bad_request。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import * as readline from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  listRegisteredActions,
  listRegisteredArchetypes,
  listRegisteredComponentEntries,
  listRegisteredMapGenerators,
  listRegisteredSystems,
} from 'framework/api'
import {
  bootstrapFramework,
  buildMapGeometry,
  CombatRuleSchema,
  CraftingRuleSchema,
  DayNightRuleSchema,
  exportGeometryArtifacts,
  GameDefinitionSchema,
  getRegistries,
  loadGameDefinition,
  NeedsRuleSchema,
  serializeGeometry,
  ServerRuleSchema,
} from 'framework'
import type { MapGeometry } from 'framework'
import type { MapGenerationConfig } from 'map/generate/types'
import { ArchetypeSchema } from 'framework/config/schema/ArchetypeSchema'
import { BehaviorSchema } from 'framework/config/schema/BehaviorSchema'
import { DialogueRegistrySchema } from 'framework/config/schema/DialogueSchema'
import { EcosystemsSchema } from 'framework/config/schema/EcosystemsSchema'
import { ItemKindSchema } from 'framework/config/schema/ItemKindSchema'
import { MapRegistrySchema } from 'framework/config/schema/MapRegistrySchema'
import { PlayerRuleSchema } from 'framework/config/schema/PlayerRuleSchema'
import { QuestRegistrySchema } from 'framework/config/schema/QuestSchema'
import { RaidRuleSchema } from 'framework/config/schema/RuleSchema'
import { EntityRulesDocumentSchema } from 'map/evolution/schema'
// 协议 DTO（T1.1）：纯类型模块，import type 运行时整体擦除（见头注释"类型共享"）。
import type {
  ExportMapArtifactsResult,
  GetSchemaResult,
  ListRegistriesResult,
  PingResult,
  RegistriesEntry,
  SerializedMapGeometry,
  TilePalette,
  ValidateFileResult,
} from '../src/sidecar/protocol.js'
// schema 描述注册表（相对路径，无别名依赖；ts-morph 从 excalibur_test 根解析）。
import { buildSchemaRegistry, schemaToJson } from './schemaDescribe.js'

// ---------------------------------------------------------------------------
// stdout 纪律与诊断输出（必须先于任何请求处理安装）
// ---------------------------------------------------------------------------

/** 协议帧直写 fd 1（绕过被重定向的 process.stdout）。 */
function writeFd1(str: string): void {
  const buf = Buffer.from(str, 'utf8')
  let offset = 0
  while (offset < buf.length) {
    try {
      offset += fs.writeSync(1, buf, offset, buf.length - offset)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EPIPE') process.exit(0) // 父进程已关闭管道
      if (code === 'EAGAIN') continue // fd 暂不可写，重试（spawn 管道默认阻塞，实际罕见）
      throw err
    }
  }
}

/** 一切诊断输出走 stderr（本补丁后 console.log 也落 stderr）。 */
const realStderrWrite = process.stderr.write.bind(process.stderr)
process.stdout.write = realStderrWrite as unknown as typeof process.stdout.write

function writeFrame(frame: unknown): void {
  writeFd1(JSON.stringify(frame) + '\n')
}

function diag(message: string): void {
  realStderrWrite(`[sidecar-driver] ${message}\n`)
}

// ---------------------------------------------------------------------------
// GAME_ROOT 与 zod 版本自检
// ---------------------------------------------------------------------------

/** spawn 契约 cwd=GAME_ROOT；按 cwd 探测优先，退化按本文件位置推断。 */
function resolveGameRoot(): string {
  const cwd = process.cwd()
  if (fs.existsSync(path.join(cwd, 'framework', 'index.ts'))) return cwd
  const here = path.dirname(fileURLToPath(import.meta.url)) // <repo>/server/sidecar
  return path.resolve(here, '..', '..', '..', 'game_server_test')
}

const GAME_ROOT = resolveGameRoot()

/**
 * driver 进程内解析到的 zod 版本：经 createRequire(<GAME_ROOT>/framework/index.ts)
 * 从本体 node_modules 解析（预期 4.4.3，而非 server 的 4.6.5）——证明依赖单实例化。
 */
let zodVersion = 'unknown'
try {
  const requireFromGame = createRequire(path.join(GAME_ROOT, 'framework', 'index.ts'))
  zodVersion = (requireFromGame('zod/package.json') as { version?: string }).version ?? 'unknown'
} catch (err) {
  diag(`zod 版本解析失败: ${err instanceof Error ? err.message : String(err)}`)
}

// ---------------------------------------------------------------------------
// RPC 方法实现
// ---------------------------------------------------------------------------

class RpcError extends Error {
  constructor(
    readonly code: 'bad_request' | 'game_config_error' | 'driver_error',
    message: string,
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

/**
 * schema 最小结构接口（safeParse 形状）。不 import zod 类型：本体 schema 与
 * server 依赖的 zod 是不同实例（pnpm 双仓），只依赖"有 safeParse"这一结构事实
 * （同 server/src/services/configService.ts 的 SafeParseLike 做法）。
 */
interface SafeParseLike {
  safeParse(data: unknown):
    | { success: true; data: unknown }
    | { success: false; error: { issues: readonly { path: PropertyKey[]; message: string }[] } }
}

/**
 * 完整 schema kind 表（T1.2 迁入：即 configService.ts:49-58 的 SCHEMA_TABLE；
 * 平台侧从此不持有任何 zod 对象）。P5 §1.3 起扩为 16 个 kind：新增的 8 个是
 * 本体 loadGameDefinition（validateWhole）逐文件消费、此前未纳入的 schema。
 * 未登记 kind → bad_request。
 */
const SCHEMA_TABLE: Record<string, SafeParseLike> = {
  GameDefinition: GameDefinitionSchema,
  Archetype: ArchetypeSchema,
  MapRegistry: MapRegistrySchema,
  combat: CombatRuleSchema,
  needs: NeedsRuleSchema,
  crafting: CraftingRuleSchema,
  daynight: DayNightRuleSchema,
  server: ServerRuleSchema,
  // P5 §1.3 新增（validateWhole 逐文件消费，此前未纳入）
  items: ItemKindSchema,
  dialogues: DialogueRegistrySchema,
  quests: QuestRegistrySchema,
  ecosystems: EcosystemsSchema,
  behaviors: BehaviorSchema,
  player: PlayerRuleSchema,
  raid: RaidRuleSchema,
  entityRules: EntityRulesDocumentSchema,
}

/** bootstrapFramework 幂等单例（本体自身已幂等，此处再拦一层避免重复副作用）。 */
let bootstrapped = false
function ensureBootstrap(): void {
  if (bootstrapped) return
  bootstrapFramework()
  bootstrapped = true
}

/**
 * A5-2：加载本体 `src/register.ts`（游戏自定义扩展注册入口）。
 *
 * driver 现有静态 import 只覆盖 framework 内置注册；本体把游戏专属 register*
 * 调用集中写在 src/register.ts，并在 src/main.ts 最先 import。这里用绝对
 * file URL 动态 import（等价"同一 tsx 加载器 + 本体 tsconfig"机制；register.ts
 * 内部的 `framework/*` 别名由 tsx 按 GAME_ROOT tsconfig 解析），副作用即完成
 * 注册。放在 stdout 纪律补丁安装之后、bootstrap 之前，避免加载期日志漏进协议帧。
 * 文件缺失或注册抛错只告警，不阻断 driver 启动（降级为仅内置注册）。
 */
let gameRegistrationsLoaded: Promise<void> | null = null
function ensureGameRegistrations(): Promise<void> {
  if (!gameRegistrationsLoaded) {
    gameRegistrationsLoaded = (async () => {
      const registerPath = path.join(GAME_ROOT, 'src', 'register.ts')
      if (!fs.existsSync(registerPath)) {
        diag(`无本体 src/register.ts，跳过游戏自定义注册（${registerPath}）`)
        return
      }
      try {
        await import(pathToFileURL(registerPath).href)
        diag('已加载本体 src/register.ts（游戏自定义扩展注册）')
      } catch (err) {
        diag(`加载本体 src/register.ts 失败（降级为仅内置注册）：${err instanceof Error ? err.message : String(err)}`)
      }
    })()
  }
  return gameRegistrationsLoaded
}

/**
 * schema 描述注册表（P1）：SCHEMA_TABLE 装配完成后惰性构建一次并缓存。
 * 构建失败（ts-morph 缺失/源不可读等）置 null，getSchema/listRegistries 降级为
 * 无 description 的 JSON Schema（仍可用），不阻断 driver。
 */
let schemaRegistry: unknown = null
let schemaRegistryBuilt = false
function getSchemaRegistry(): unknown {
  if (schemaRegistryBuilt) return schemaRegistry
  schemaRegistryBuilt = true
  try {
    schemaRegistry = buildSchemaRegistry(SCHEMA_TABLE, { onWarn: (m) => diag(`[schemaDescribe] ${m}`) })
    diag('schema 描述注册表构建完成')
  } catch (err) {
    schemaRegistry = null
    diag(`schema 描述注册表构建失败（降级为无 description）：${err instanceof Error ? err.message : String(err)}`)
  }
  return schemaRegistry
}

/** 注册条目元数据透传（description + configSchema→JSON Schema；无则字段缺省）。 */
function entryMeta(entry: { description?: string; configSchema?: unknown }): {
  description?: string
  configSchema?: unknown
} {
  const out: { description?: string; configSchema?: unknown } = {}
  if (typeof entry.description === 'string' && entry.description.length > 0) out.description = entry.description
  if (entry.configSchema) {
    try {
      out.configSchema = schemaToJson(entry.configSchema, getSchemaRegistry())
    } catch (err) {
      diag(`configSchema 转 JSON Schema 失败（忽略该字段）：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return out
}

/**
 * ping：zod 版本 + framework 自检（门面关键导出可用性；不触发 bootstrap，
 * 保持 spawn→pong 冷启延迟不受 bootstrap 开销影响）。
 */
function ping(): PingResult {
  const frameworkOk =
    typeof bootstrapFramework === 'function' &&
    typeof loadGameDefinition === 'function' &&
    typeof getRegistries === 'function' &&
    typeof buildMapGeometry === 'function' &&
    typeof serializeGeometry === 'function' &&
    typeof exportGeometryArtifacts === 'function'
  return {
    pong: true,
    frameworkOk,
    zodVersion,
    pid: process.pid,
    rss: process.memoryUsage().rss,
    gameRoot: GAME_ROOT,
  }
}

/**
 * 复刻 server/src/routes/registries.ts 的 payload 组装（游戏侧语义入 driver）。
 * P1 扩展：每条目透传 description / configSchema 元数据（configSchema 经
 * schemaToJson 转标准 JSON Schema）；无元数据时字段缺省，components 无元数据为 null。
 * 先 await 本体 src/register.ts 副作用注册，确保 src 自定义扩展进入注册表。
 */
async function listRegistries(): Promise<ListRegistriesResult> {
  await ensureGameRegistrations()
  ensureBootstrap()
  const components: Record<string, RegistriesEntry | null> = {}
  for (const entry of listRegisteredComponentEntries()) {
    const meta = entryMeta(entry)
    components[entry.name] = Object.keys(meta).length > 0 ? { id: entry.name, ...meta } : null
  }
  return {
    systems: listRegisteredSystems().map((s) => ({
      id: s.id,
      ...(s.after ? { after: s.after } : {}),
      ...(s.before ? { before: s.before } : {}),
      ...(s.defaultOrder !== undefined ? { defaultOrder: s.defaultOrder } : {}),
      ...entryMeta(s),
    })),
    archetypes: listRegisteredArchetypes().map((s) => ({
      id: s.kind,
      kind: s.kind,
      ...(s.tags ? { tags: s.tags } : {}),
      components: s.components,
      ...(s.behavior ? { behavior: s.behavior } : {}),
      ...(s.team !== undefined ? { team: s.team } : {}),
      ...entryMeta(s),
    })),
    actions: listRegisteredActions().map((a) => ({ id: a.name, ...entryMeta(a) })),
    components,
    mapGenerators: listRegisteredMapGenerators().map((g) => ({ id: g.id, ...entryMeta(g) })),
  }
}

/**
 * getSchema(kind)：把 SCHEMA_TABLE 中已加载的 zod 实例转 JSON Schema（带 registry
 * description）。无效/未登记 kind → bad_request；覆盖 SCHEMA_TABLE 的 16 个 kind。
 */
function getSchema(params: Record<string, unknown>): GetSchemaResult {
  const kind = params.kind
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new RpcError('bad_request', 'params.kind 必须为非空字符串')
  }
  const schema = SCHEMA_TABLE[kind]
  if (!schema) throw new RpcError('bad_request', `未登记的 schema kind: ${kind}`)
  return { jsonSchema: schemaToJson(schema, getSchemaRegistry()) }
}

/**
 * 整体校验：复刻 server/gameBridge/validate.ts:34-51。
 * 存在性预检必须先于 loadGameDefinition（本体对缺失 game.json 会静默回退
 * 默认定义而误报通过）；永不 throw，结果以返回值表达。
 */
function validateWhole(params: Record<string, unknown>): { ok: boolean; message: string } {
  const gameJsonPath = params.gameJsonPath
  if (typeof gameJsonPath !== 'string' || gameJsonPath.length === 0) {
    throw new RpcError('bad_request', 'params.gameJsonPath 必须为非空字符串（绝对路径）')
  }
  if (!fs.existsSync(gameJsonPath)) {
    return { ok: false, message: `game.json 不存在：${gameJsonPath}` }
  }
  try {
    ensureBootstrap()
    const def = loadGameDefinition({ gameJsonPath })
    return {
      ok: true,
      message:
        `校验通过：实体原型 ${def.resolvedEntities.length} 个，行为树 ${def.resolvedBehaviors.length} 个，` +
        `规则 ${Object.keys(def.resolvedRules).length} 个，item ${def.resolvedItems.length} 个，` +
        `地图 ${def.resolvedMapConfigs.map((c) => c.key).join(', ')}`,
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 单文件校验：schema.safeParse；失败时 issues 只取 path/message（§0.2 zod issue
 * 形状），path 过滤掉 symbol（实测 zod 只产生 string|number）。平台侧
 * mapZodIssues（configService.ts:258-267）按此形状零改动复用。
 */
function validateFile(params: Record<string, unknown>): ValidateFileResult {
  const { kind, data } = params as { kind?: unknown; data?: unknown }
  if (typeof kind !== 'string') throw new RpcError('bad_request', 'params.kind 必须为字符串')
  const schema = SCHEMA_TABLE[kind]
  if (!schema) throw new RpcError('bad_request', `未登记的 schema kind: ${kind}`)
  const parsed = schema.safeParse(data)
  if (parsed.success) return { valid: true, issues: [] }
  return {
    valid: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.filter(
        (seg): seg is string | number => typeof seg === 'string' || typeof seg === 'number',
      ),
      message: issue.message,
    })),
  }
}

/**
 * 地图几何公共步骤：config 形状预检 + bootstrap 自举（首次调用一次，幂等）+
 * 管道错误映射（未注册积木/出口结构等 → game_config_error，同 mapService 422 语义）。
 * tiledPath 内联等文件 I/O 属平台侧 mapService 职责，这里只接收最终 config。
 */
function generateGeometry(config: unknown): MapGeometry {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new RpcError('bad_request', 'params.config 必须为对象（MapGenerationConfig）')
  }
  ensureBootstrap()
  try {
    return buildMapGeometry(config as MapGenerationConfig, getRegistries().mapGeneratorRegistry)
  } catch (err) {
    throw new RpcError('game_config_error', err instanceof Error ? err.message : String(err))
  }
}

/**
 * 地图几何：纯函数生成 + serializeGeometry 序列化（序列化放 driver 内，
 * 平台不再接触 MapGeometry 类实例）。
 */
function buildMapGeometryRpc(params: Record<string, unknown>): SerializedMapGeometry {
  return serializeGeometry(generateGeometry(params.config))
}

/**
 * palette 规整（exportMapArtifacts 用）：JSON 线上传输后键为字符串，这里
 * 校验形状并转为数值键对象（与 exportGenerated 的 TilePalette 对齐）。
 * 结构校验保持轻量——语义级校验（base64 解析等）仍在平台侧 parsePalette。
 */
function normalizePalette(input: unknown): TilePalette | undefined {
  if (input === undefined) return undefined
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new RpcError('bad_request', 'params.palette 提供时必须为对象（语义 id → [r,g,b,(a)]）')
  }
  const out: Record<number, [number, number, number, number]> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const tileId = Number(key)
    const nums = (Array.isArray(value) ? value : []).map((x) => {
      if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 255) {
        throw new RpcError('bad_request', `params.palette 条目 "${key}" 含非法通道值`)
      }
      return x
    })
    if (key === '' || !Number.isInteger(tileId) || tileId < 0 || (nums.length !== 3 && nums.length !== 4)) {
      throw new RpcError('bad_request', `params.palette 条目 "${key}" 不是 [r,g,b,(a)] 0-255 数组`)
    }
    out[tileId] = nums.length === 3 ? [nums[0]!, nums[1]!, nums[2]!, 255] : [nums[0]!, nums[1]!, nums[2]!, nums[3]!]
  }
  return out
}

/**
 * 导出地图产物（T1.2 新增第 6 方法）：生成几何后调 exportGeometryArtifacts 写
 * os.tmpdir()/admin-map-export-<uuid>/（命名保持 mapService.ts:96 现状），
 * 返回路径三元组。同机共享 fs，临时目录清理责任仍在平台路由层（现状语义不变）。
 * 管道生成错误 → game_config_error；写盘失败 → driver_error（与 mapService 现状
 * 一致：生成 422、导出写盘异常走 500 语义）。
 */
function exportMapArtifactsRpc(params: Record<string, unknown>): ExportMapArtifactsResult {
  const palette = normalizePalette(params.palette)
  const geometry = generateGeometry(params.config)
  const dir = path.join(os.tmpdir(), `admin-map-export-${crypto.randomUUID()}`)
  try {
    const { jsonPath, pngPath } = exportGeometryArtifacts(geometry, {
      outDir: dir,
      ...(palette ? { palette } : {}),
    })
    return { dir, jsonPath, pngPath }
  } catch (err) {
    throw new RpcError(
      'driver_error',
      `导出产物写盘失败（${dir}）: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

const methods: Record<string, (params: Record<string, unknown>) => unknown> = {
  ping: () => ping(),
  listRegistries: () => listRegistries(),
  getSchema,
  validateWhole,
  validateFile,
  buildMapGeometry: buildMapGeometryRpc,
  exportMapArtifacts: exportMapArtifactsRpc,
}

// ---------------------------------------------------------------------------
// NDJSON 主循环（请求串行处理：framework 全局单例语义下最稳）
// ---------------------------------------------------------------------------

async function handleLine(raw: string): Promise<void> {
  const line = raw.trim()
  if (line === '') return // 纯空行静默忽略

  let req: { id?: unknown; method?: unknown; params?: unknown }
  try {
    req = JSON.parse(line)
  } catch (err) {
    writeFrame({
      id: null,
      ok: false,
      error: { code: 'bad_request', message: `行不是合法 JSON: ${err instanceof Error ? err.message : String(err)}` },
    })
    return
  }

  const id = typeof req.id === 'number' ? req.id : null
  if (typeof req.method !== 'string' || req.method.length === 0) {
    writeFrame({ id, ok: false, error: { code: 'bad_request', message: '请求缺少 method(string)' } })
    return
  }
  if (req.params !== undefined && (typeof req.params !== 'object' || req.params === null || Array.isArray(req.params))) {
    writeFrame({ id, ok: false, error: { code: 'bad_request', message: 'params 必须为对象' } })
    return
  }
  const handler = methods[req.method]
  if (!handler) {
    writeFrame({ id, ok: false, error: { code: 'bad_request', message: `未知 method: ${req.method}` } })
    return
  }

  try {
    const result = await handler((req.params ?? {}) as Record<string, unknown>)
    writeFrame({ id, ok: true, result })
  } catch (err) {
    if (err instanceof RpcError) {
      writeFrame({ id, ok: false, error: { code: err.code, message: err.message } })
    } else {
      diag(`method ${req.method} 未预期异常: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
      writeFrame({
        id,
        ok: false,
        error: { code: 'driver_error', message: err instanceof Error ? err.message : String(err) },
      })
    }
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let queue: Promise<void> = Promise.resolve()
rl.on('line', (line) => {
  // 串行：逐行 await，不并发
  queue = queue
    .then(() => handleLine(line))
    .catch((err) => diag(`请求队列异常: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`))
})
rl.on('close', () => {
  diag('stdin 关闭，driver 退出')
  process.exit(0)
})

diag(`ready: pid=${process.pid} gameRoot=${GAME_ROOT} zod=${zodVersion}`)
