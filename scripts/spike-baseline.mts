/**
 * T0.2 基线生成器——用【当前生产机制】产生 Phase 0 对比用的"标准答案"。
 *
 * 现状机制 = gameBridge 进程内 import：本脚本 import ../server/gameBridge/index.js
 * （与 server/src/services、server/src/routes 同源），其内部的 'framework'、
 * 'framework/config/schema/*' 等裸说明符经 server/tsconfig.json 的 paths 解析到
 * 本体仓 ../game_server_test/framework/。因此本脚本必须以 server 包为 cwd 运行，
 * 让 tsx 加载 server/tsconfig.json——这正是现状机制本身，不允许绕过：
 *
 *   cd server && pnpm exec tsx ../scripts/spike-baseline.mts
 *
 * 产出 /tmp/opencode/spike/baseline.json，五个键：
 * - registries     ：复刻 server/src/routes/registries.ts:25-37（bootstrap +
 *                    五类 list；components 只取键、mapGenerators 只取 id）
 * - wholeValid     ：对本体 game/game.json 走 gameBridge/validate.ts 的
 *                    validateWholeConfig 同款逻辑 → { ok, message }
 * - wholeInvalid   ：本体 game/ 拷贝到 /tmp/opencode/spike/broken-game/ 并破坏
 *                    game.json（删必填键 tickRate）→ { ok:false, message } 原文
 * - geometry       ：读本体 game/maps/registry.json（official 源），对每个
 *                    kind !== 'tiled' 的 key 执行 mapService.buildGeometry 同款
 *                    流程（含 tiledPath 内联，mapService.ts:131-162）→
 *                    serializeGeometry 结果；tiled 图记录其报错文案
 * - validateFile   ：3 用例（合法 wolf.json / 删必填字段的破坏版 archetype /
 *                    schema 路由未命中路径），issues 按 §0.2 契约取
 *                    { path, message } 两字段
 *
 * 红线 R1：本脚本对本体仓只读（bootstrapFramework 为纯内存操作，无文件写入）；
 * 临时产物全部落在 /tmp/opencode/ 下。不修改本仓任何现有文件。
 */
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// 现状机制入口：gameBridge 进程内 import（勿改为任何直接/动态加载本体的方式）
// ---------------------------------------------------------------------------
import {
  ArchetypeSchema,
  CombatRuleSchema,
  CraftingRuleSchema,
  DayNightRuleSchema,
  GameDefinitionSchema,
  MapRegistrySchema,
  NeedsRuleSchema,
  ServerRuleSchema,
  bootstrapFramework,
  buildMapGeometry,
  getRegistries,
  listRegisteredActions,
  listRegisteredArchetypes,
  listRegisteredComponents,
  listRegisteredMapGenerators,
  listRegisteredSystems,
  serializeGeometry,
  validateWholeConfig,
} from '../server/gameBridge/index.js'

// ---------------------------------------------------------------------------
// GAME_ROOT / gameConfigsDir：如实复现 server/src/config.ts:27-29、37 的默认解析
// （config.ts 位于 server/src/，向上三层到仓库父级再进 game_server_test/；
//   本脚本位于 scripts/，等价相对深度为两层。GAME_ROOT 环境变量覆盖语义一致。）
// ---------------------------------------------------------------------------
const GAME_ROOT = path.resolve(
  process.env.GAME_ROOT ?? fileURLToPath(new URL('../../game_server_test/', import.meta.url)),
)
/** 本体配置目录（= config.ts 的 gameConfigsDir：<GAME_ROOT>/game）。 */
const gameConfigsDir = path.join(GAME_ROOT, 'game')

// ---------------------------------------------------------------------------
// SCHEMA_TABLE + routeSchemaKind：复刻 server/src/services/configService.ts:49-69
// （schema 一律经 gameBridge 引用；kind=规则名时直接用文件名干）
// ---------------------------------------------------------------------------
/** schema 最小结构接口（safeParse 形状）——同 configService.ts:42-46。 */
interface SafeParseLike {
  safeParse(data: unknown):
    | { success: true; data: unknown }
    | { success: false; error: { issues: readonly { path: PropertyKey[]; message: string }[] } }
}

/** 已登记 schema 的路由表（其他路径 schemaKind=null 不校验）。 */
const SCHEMA_TABLE: Record<string, SafeParseLike> = {
  GameDefinition: GameDefinitionSchema,
  Archetype: ArchetypeSchema,
  MapRegistry: MapRegistrySchema,
  combat: CombatRuleSchema,
  needs: NeedsRuleSchema,
  crafting: CraftingRuleSchema,
  daynight: DayNightRuleSchema,
  server: ServerRuleSchema,
}

/** relPath（'/' 分隔，相对工作区 game/）→ schemaKind；不在路由表内 → null。 */
function routeSchemaKind(relPath: string): string | null {
  const norm = relPath.split(path.sep).join('/')
  if (norm === 'game.json') return 'GameDefinition'
  if (/^entities\/[^/]+\.json$/.test(norm)) return 'Archetype'
  if (norm === 'maps/registry.json') return 'MapRegistry'
  const rule = /^rules\/(combat|needs|crafting|daynight|server)\.json$/.exec(norm)
  if (rule) return rule[1]
  return null
}

// ---------------------------------------------------------------------------
// geometry：mapService.buildGeometry（source='official'）同款流程的进程内复刻
// ---------------------------------------------------------------------------

/** registry.json 结构（只声明用到的字段，其余透传给 buildMapGeometry 前剥离）。 */
interface RegistryFile {
  maps: Record<string, Record<string, unknown>>
}

/** 读本体 registry.json（official 源；缺文件/结构非法的报错文案同 mapService.ts:186-197）。 */
async function readOfficialRegistry(): Promise<RegistryFile> {
  const file = path.join(gameConfigsDir, 'maps', 'registry.json')
  if (!fs.existsSync(file)) {
    throw new Error(`registry.json 不存在（official）`)
  }
  const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as RegistryFile
  if (!parsed || typeof parsed !== 'object' || !parsed.maps || typeof parsed.maps !== 'object') {
    throw new Error(`registry.json 结构非法（official）：缺少 maps 对象`)
  }
  return parsed
}

/**
 * 单图 geometry 构建 + 序列化（= mapService.geometry(key, 'official') 的全流程）。
 * 报错语义与 mapService.ts:124-178 逐行对应（tiled → 400 文案；管道错误 → 422 文案），
 * 此处以 throw Error(message) 表达，由调用方记录 message。
 */
async function buildOfficialGeometry(key: string): Promise<ReturnType<typeof serializeGeometry>> {
  const registryDir = path.join(gameConfigsDir, 'maps')
  const raw = await readOfficialRegistry()
  const entry = raw.maps[key]
  if (!entry) {
    throw new Error(`地图不存在：${key}（official）`)
  }
  if (entry.kind === 'tiled') {
    // mapService.ts:126-128（REST 400）
    throw new Error('tiled 类型地图不支持 pipeline 几何生成')
  }
  bootstrapFramework()

  // —— tiledPath 内联：逐行复刻 mapService.ts:131-162 ——
  const pipeline: { generator: string; params?: Record<string, unknown> }[] = []
  const steps = Array.isArray(entry.pipeline) ? (entry.pipeline as { generator: string; params?: Record<string, unknown> }[]) : []
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]
    const params = (step.params ?? {}) as Record<string, unknown>
    if (params.tiledPath === undefined) {
      pipeline.push(step)
      continue
    }
    if (params.tiled !== undefined) {
      // mapService.ts:140-142（REST 422）
      throw new Error(`地图 "${key}" 管道步骤 ${index}：tiled 与 tiledPath 只能声明其一`)
    }
    if (typeof params.tiledPath !== 'string') {
      // mapService.ts:143-145（REST 422）
      throw new Error(`地图 "${key}" 管道步骤 ${index}：tiledPath 必须为字符串`)
    }
    // 防穿越：模板必须位于 maps/ 目录（registryDir）内
    const tiledAbs = path.resolve(registryDir, params.tiledPath)
    if (!tiledAbs.startsWith(registryDir + path.sep)) {
      // mapService.ts:147-150（REST 400）
      throw new Error(`地图 "${key}" 管道步骤 ${index}：tiledPath 越界`)
    }
    let tiledJson: unknown
    try {
      tiledJson = JSON.parse(await fsp.readFile(tiledAbs, 'utf8'))
    } catch (err) {
      // mapService.ts:151-159（REST 422）
      throw new Error(
        `地图 "${key}" 管道步骤 ${index}：tiledPath "${params.tiledPath}" 加载失败（${err instanceof Error ? err.message : String(err)}）`,
      )
    }
    const { tiledPath: _omit, ...rest } = params
    pipeline.push({ generator: step.generator, params: { ...rest, tiled: tiledJson } })
  }

  const config = {
    key,
    seed: typeof entry.seed === 'number' ? entry.seed : 0,
    pipeline,
  }
  try {
    // mapService.ts:164-170
    return serializeGeometry(buildMapGeometry(config, getRegistries().mapGeneratorRegistry))
  } catch (err) {
    // mapService.ts:171-177（REST 422）：管道引用未注册积木 / 出口结构硬错误
    throw new Error(`地图生成失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---------------------------------------------------------------------------
// zod issues → §0.2 契约形状（driver 原样序列化 issues 时只取 path/message 两字段）
// ---------------------------------------------------------------------------
function contractIssues(
  issues: readonly { path: PropertyKey[]; message: string }[],
): { path: (string | number)[]; message: string }[] {
  return issues.map((issue) => ({
    path: issue.path.filter(
      (seg): seg is string | number => typeof seg === 'string' || typeof seg === 'number',
    ),
    message: issue.message,
  }))
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const outDir = '/tmp/opencode/spike'
  await fsp.mkdir(outDir, { recursive: true })
  const baseline: Record<string, unknown> = {}

  // 1) registries —— 复刻 registries.ts:25-37
  bootstrapFramework()
  baseline.registries = {
    systems: listRegisteredSystems(),
    archetypes: listRegisteredArchetypes(),
    actions: listRegisteredActions(),
    components: Object.fromEntries(
      Object.keys(listRegisteredComponents()).map((k) => [k, null]),
    ) as Record<string, null>,
    mapGenerators: listRegisteredMapGenerators().map((g) => ({ id: g.id })),
  }

  // 2) wholeValid —— 本体 game/game.json（gameBridge/validate.ts 同款，含存在性预检）
  baseline.wholeValid = validateWholeConfig(path.join(gameConfigsDir, 'game.json'))

  // 3) wholeInvalid —— 本体 game/ 拷贝 → 破坏 game.json（删必填键 tickRate）
  //    （GameDefinitionSchema 中 tickRate 为 z.number().min(1) 必填、无 default；
  //     文件仍存在，因此走的是 loadGameDefinition 的 zod 失败路径而非存在性预检）
  const brokenGameDir = path.join(outDir, 'broken-game')
  await fsp.rm(brokenGameDir, { recursive: true, force: true })
  await fsp.cp(gameConfigsDir, brokenGameDir, { recursive: true })
  const brokenGameJsonPath = path.join(brokenGameDir, 'game.json')
  const brokenDef = JSON.parse(await fsp.readFile(brokenGameJsonPath, 'utf8')) as Record<string, unknown>
  delete brokenDef.tickRate
  await fsp.writeFile(brokenGameJsonPath, JSON.stringify(brokenDef, null, 2), 'utf8')
  baseline.wholeInvalid = validateWholeConfig(brokenGameJsonPath)

  // 4) geometry —— official 源 registry.json，逐 key 走 buildGeometry 同款流程
  const raw = await readOfficialRegistry()
  const geometryMaps: Record<string, unknown> = {}
  for (const key of Object.keys(raw.maps)) {
    try {
      geometryMaps[key] = { ok: true, geometry: await buildOfficialGeometry(key) }
    } catch (err) {
      geometryMaps[key] = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
  baseline.geometry = {
    source: 'official',
    registryPath: path.join(gameConfigsDir, 'maps', 'registry.json'),
    maps: geometryMaps,
  }

  // 5) validateFile —— 3 用例（configService.validateFile 的语义，不落盘）
  const validateFileCase = (
    relPath: string,
    parsed: unknown,
  ): { relPath: string; schemaKind: string | null; valid: boolean; issues: unknown[] } => {
    const kind = routeSchemaKind(relPath)
    if (!kind) {
      // configService.ts:189：路由未命中 → 不校验直接通过（内容甚至不进 schema）
      return { relPath, schemaKind: null, valid: true, issues: [] }
    }
    const result = SCHEMA_TABLE[kind].safeParse(parsed)
    if (result.success) {
      return { relPath, schemaKind: kind, valid: true, issues: [] }
    }
    return { relPath, schemaKind: kind, valid: false, issues: contractIssues(result.error.issues) }
  }

  // 用例 1：合法 entities/wolf.json
  const wolfRaw = await fsp.readFile(path.join(gameConfigsDir, 'entities', 'wolf.json'), 'utf8')
  const wolfValid = validateFileCase('entities/wolf.json', JSON.parse(wolfRaw))

  // 用例 2：破坏版 archetype（拷到 /tmp/opencode/spike/ 后删必填字段 kind）
  const brokenArchetypePath = path.join(outDir, 'broken-archetype.json')
  const brokenArchetype = JSON.parse(wolfRaw) as Record<string, unknown>
  delete brokenArchetype.kind // ArchetypeSchema 中 kind 为必填
  await fsp.writeFile(brokenArchetypePath, JSON.stringify(brokenArchetype, null, 2), 'utf8')
  const wolfBroken = validateFileCase(
    'entities/broken-archetype.json',
    JSON.parse(await fsp.readFile(brokenArchetypePath, 'utf8')),
  )

  // 用例 3：schema 路由未命中的真实文件（maps/entity-rules.json → kind=null）
  const unrouted = validateFileCase('maps/entity-rules.json', { note: '路由未命中，现状不解析' })

  baseline.validateFile = {
    wolfValid,
    brokenArchetype: wolfBroken,
    unroutedPath: unrouted,
  }

  const outPath = path.join(outDir, 'baseline.json')
  await fsp.writeFile(outPath, JSON.stringify(baseline, null, 2) + '\n', 'utf8')

  // ---- 摘要（诊断输出，方便人工抽查）----
  const reg = baseline.registries as { components: Record<string, null>; mapGenerators: { id: string }[] } & Record<string, unknown[]>
  const geom = baseline.geometry as { maps: Record<string, { ok: boolean; error?: string }> }
  console.log(`[spike-baseline] baseline.json → ${outPath}`)
  console.log(`[spike-baseline] GAME_ROOT=${GAME_ROOT}`)
  console.log(
    `[registries] systems=${reg.systems.length} archetypes=${reg.archetypes.length} actions=${reg.actions.length} components=${Object.keys(reg.components).length} mapGenerators=${reg.mapGenerators.length}`,
  )
  console.log(`[wholeValid] ${JSON.stringify(baseline.wholeValid)}`)
  console.log(`[wholeInvalid] ${JSON.stringify(baseline.wholeInvalid)}`)
  const geomKeys = Object.keys(geom.maps)
  const tiledError =
    'tiled-demo' in geometryMaps && !(geometryMaps['tiled-demo'] as { ok: boolean }).ok
      ? (geometryMaps['tiled-demo'] as { error: string }).error
      : '(no tiled map found)'
  console.log(
    `[geometry] maps=${geomKeys.join(',')} (pipeline ok=${geomKeys.filter((k) => (geom.maps[k] as { ok: boolean }).ok).length}) tiledError="${tiledError}"`,
  )
  console.log(`[validateFile] ${JSON.stringify(baseline.validateFile)}`)
}

main().catch((err) => {
  console.error('[spike-baseline] FAILED:', err)
  process.exit(1)
})
