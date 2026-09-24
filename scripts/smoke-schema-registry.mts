/**
 * 冒烟：sidecar schemaDescribe（buildSchemaRegistry / schemaToJson）+ config-index 抽取。
 * ============================================================================
 *
 * sidecar 目录不被 server tsconfig 覆盖（include 只有 src），故用运行时冒烟代替
 * 编译期校验（仿 scripts/spike-jsdoc-schema.mts 先例）：
 *   1. 从本体 schema 文件按绝对 file URL 组装 SCHEMA_TABLE 的 8 个 kind（与 driver
 *      SCHEMA_TABLE 同源实例）；
 *   2. buildSchemaRegistry → 8 kind 全部对齐成功，打印各 kind 对齐告警数；
 *   3. schemaToJson 每个 kind → 断言输出为 JSON Schema（type=object、无 $defs），
 *      并抽查 description 注入（tickRate / world.tile.width / kind）；
 *   4. config-index 抽取逻辑对本体仓 game/ 目录跑一遍，打印条目数与样例并对照真实
 *      文件抽查；
 *   5. driver 端到端：按 client.ts:14-17 的方式 spawn 常驻 driver 子进程
 *      （cwd=GAME_ROOT + TSX_TSCONFIG_PATH=本体 tsconfig，**在 spawn 前注入 env**，
 *      保证 tsx 加载器初始化时即可解析本体 `framework/*` 别名），发送
 *      ping / getSchema / listRegistries 并断言响应形状；stderr 出现
 *      "已加载本体 src/register.ts" 即验证 A5-2（B4）自定义注册入口可被加载。
 *
 * 说明：本体 `framework` 是 tsconfig paths 别名（无 node_modules 包）。tsx 只在
 * 加载器初始化时读取 TSX_TSCONFIG_PATH，故在脚本体内 `process.env` 赋值对同进程的
 * 动态 import 无效——必须 spawn 子进程复刻生产注入方式（步骤 5 即此机制）。
 * GAME_ROOT 可用环境变量覆盖。
 *
 * 运行（VALIDATION owner；不触碰线上进程）：
 *   cd excalibur_test && node --import tsx scripts/smoke-schema-registry.mts
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')
const GAME_ROOT = process.env.GAME_ROOT
  ? path.resolve(process.env.GAME_ROOT)
  : path.resolve(REPO_ROOT, '..', 'game_server_test')
const SCHEMA_DIR = path.join(GAME_ROOT, 'framework', 'config', 'schema')

// 模仿 client.ts:14-17 的 spawn 注入（tsx tsconfig + cwd=GAME_ROOT）
process.env.TSX_TSCONFIG_PATH = path.join(GAME_ROOT, 'tsconfig.json')
try {
  process.chdir(GAME_ROOT)
} catch {
  /* cwd 注入失败不阻断（绝对路径导入不依赖 cwd） */
}

const failures: string[] = []
function check(cond: boolean, label: string, detail = ''): void {
  console.log(`  ${cond ? '✔' : '✘'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures.push(label)
}

/** kind → 源文件名 + 根导出名（与 server/sidecar/schemaDescribe.ts KIND_SOURCES 对齐）。 */
const SOURCES: Record<string, { file: string; exportName: string }> = {
  GameDefinition: { file: 'GameDefinitionSchema.ts', exportName: 'GameDefinitionSchema' },
  Archetype: { file: 'ArchetypeSchema.ts', exportName: 'ArchetypeSchema' },
  MapRegistry: { file: 'MapRegistrySchema.ts', exportName: 'MapRegistrySchema' },
  combat: { file: 'RuleSchema.ts', exportName: 'CombatRuleSchema' },
  needs: { file: 'RuleSchema.ts', exportName: 'NeedsRuleSchema' },
  crafting: { file: 'RuleSchema.ts', exportName: 'CraftingRuleSchema' },
  daynight: { file: 'RuleSchema.ts', exportName: 'DayNightRuleSchema' },
  server: { file: 'RuleSchema.ts', exportName: 'ServerRuleSchema' },
}

interface SchemaAlignReport {
  kind: string
  file: string
  exportName: string
  scannedFields: number
  directFields: number
  describedFields: number
  attachments: number
  warnings: string[]
}

async function main(): Promise<void> {
  console.log(`[smoke] GAME_ROOT=${GAME_ROOT}`)
  const requireFromGame = createRequire(path.join(GAME_ROOT, 'package.json'))
  const zodVersion = (requireFromGame('zod/package.json') as { version?: string }).version ?? '?'
  console.log(`[smoke] zod(本体)=${zodVersion} tsconfig=${process.env.TSX_TSCONFIG_PATH}`)

  // ---- 1) 组装 SCHEMA_TABLE（绝对 file URL 导入 = 同源实例） ----
  const schemaTable: Record<string, unknown> = {}
  for (const [kind, src] of Object.entries(SOURCES)) {
    const mod = (await import(pathToFileURL(path.join(SCHEMA_DIR, src.file)).href)) as Record<string, unknown>
    const schema = mod[src.exportName]
    if (!schema) throw new Error(`${src.file} 未导出 ${src.exportName}`)
    schemaTable[kind] = schema
  }
  console.log(`\n[smoke] SCHEMA_TABLE 装配：${Object.keys(schemaTable).length} kind`)

  // ---- 2) buildSchemaRegistry ----
  const { buildSchemaRegistry, schemaToJson } = (await import(
    pathToFileURL(path.join(REPO_ROOT, 'server', 'sidecar', 'schemaDescribe.ts')).href
  )) as {
    buildSchemaRegistry: (
      table: Record<string, unknown>,
      options: { gameRoot: string; onWarn: (m: string) => void; onReport: (r: SchemaAlignReport) => void },
    ) => unknown
    schemaToJson: (schema: unknown, registry: unknown, options?: { gameRoot?: string }) => any
  }

  const warnings: string[] = []
  const reports: SchemaAlignReport[] = []
  const t0 = Date.now()
  const registry = buildSchemaRegistry(schemaTable, {
    gameRoot: GAME_ROOT,
    onWarn: (m) => warnings.push(m),
    onReport: (r) => reports.push(r),
  })
  console.log(`[smoke] buildSchemaRegistry 完成：${Date.now() - t0}ms，报告 ${reports.length} kind\n`)

  console.log('[smoke] 各 kind 对齐统计：')
  for (const r of reports) {
    console.log(
      `  - ${r.kind.padEnd(14)} file=${r.file.padEnd(24)} fields=${r.scannedFields} direct=${r.directFields} ` +
        `described=${r.describedFields} attachments=${r.attachments} warnings=${r.warnings.length}`,
    )
  }
  console.log(`[smoke] 全局对齐告警 ${warnings.length} 条${warnings.length ? '：' : ''}`)
  for (const w of warnings.slice(0, 20)) console.log(`    · ${w}`)

  check(reports.length === Object.keys(SOURCES).length, `8 个 kind 全部产出对齐报告`, `reports=${reports.length}`)
  check(reports.every((r) => r.attachments > 0), '每个 kind 至少注入 1 条 description')

  // ---- 3) schemaToJson（8 kind） ----
  console.log('\n[smoke] schemaToJson 输出：')
  for (const kind of Object.keys(SOURCES)) {
    try {
      const json = schemaToJson(schemaTable[kind], registry, { gameRoot: GAME_ROOT })
      const hasDefs = !!(json && (json.$defs || json.definitions))
      console.log(`  - ${kind.padEnd(14)} type=${json?.type ?? '?'} properties=${Object.keys(json?.properties ?? {}).length} $defs=${hasDefs}`)
      check(json && typeof json === 'object' && json.type === 'object', `${kind} 输出为 object JSON Schema`)
      check(!hasDefs, `${kind} inline 模式无 $defs`)
    } catch (err) {
      check(false, `${kind} schemaToJson 成功`, err instanceof Error ? err.message : String(err))
    }
  }

  // 抽查 description 注入（证明 registry 按实例身份生效）
  const gd = schemaToJson(schemaTable.GameDefinition, registry, { gameRoot: GAME_ROOT })
  const arch = schemaToJson(schemaTable.Archetype, registry, { gameRoot: GAME_ROOT })
  const tickRate = gd?.properties?.tickRate?.description
  const tileWidth = gd?.properties?.world?.properties?.tile?.properties?.width?.description
  const archKind = arch?.properties?.kind?.description
  console.log('\n[smoke] description 抽查：')
  check(typeof tickRate === 'string' && tickRate.includes('逻辑 tick'), 'GameDefinition.tickRate 描述', JSON.stringify(tickRate))
  check(typeof tileWidth === 'string' && tileWidth.includes('tile 宽度'), 'GameDefinition.world.tile.width 描述', JSON.stringify(tileWidth))
  check(typeof archKind === 'string' && archKind.includes('原型唯一标识'), 'Archetype.kind 描述', JSON.stringify(archKind))

  // ---- 4) config-index 抽取（本体仓 game/） ----
  console.log('\n[smoke] config-index 抽取：')
  const { extractConfigIndex } = (await import(
    pathToFileURL(path.join(REPO_ROOT, 'server', 'src', 'routes', 'configIndex.ts')).href
  )) as {
    extractConfigIndex: (
      tree: ConfigTreeNode,
      readFile: (rel: string) => Promise<{ content: string } | null>,
      schemaKindOf?: (rel: string) => string | null,
    ) => Promise<{ items: string[]; dialogues: string[]; quests: string[]; mapKeys: string[]; archetypes: string[] }>
  }
  const { routeSchemaKind } = (await import(
    pathToFileURL(path.join(REPO_ROOT, 'server', 'src', 'services', 'configService.ts')).href
  )) as { routeSchemaKind: (rel: string) => string | null }

  const gameDir = path.join(GAME_ROOT, 'game')
  const tree = buildTree(gameDir, '')
  const index = await extractConfigIndex(
    tree,
    async (rel) => {
      try {
        return { content: fs.readFileSync(path.join(gameDir, rel), 'utf8') }
      } catch {
        return null
      }
    },
    (rel) => routeSchemaKind(rel),
  )
  const entityFiles = fs.readdirSync(path.join(gameDir, 'entities')).filter((f) => f.endsWith('.json')).length
  const itemFiles = fs.readdirSync(path.join(gameDir, 'items')).filter((f) => f.endsWith('.json')).length
  console.log(`  items      (${index.items.length}) 样例: ${index.items.slice(0, 5).join(', ')}`)
  console.log(`  dialogues  (${index.dialogues.length}) 样例: ${index.dialogues.slice(0, 5).join(', ')}`)
  console.log(`  quests     (${index.quests.length}) 样例: ${index.quests.slice(0, 5).join(', ')}`)
  console.log(`  mapKeys    (${index.mapKeys.length}) 样例: ${index.mapKeys.slice(0, 8).join(', ')}`)
  console.log(`  archetypes (${index.archetypes.length}) 样例: ${index.archetypes.slice(0, 5).join(', ')}`)

  check(index.mapKeys.length === 5 && index.mapKeys.includes('island') && index.mapKeys.includes('cave'), 'mapKeys=5 且含 island/cave')
  check(index.dialogues.includes('villager-main'), 'dialogues 含 villager-main')
  check(index.quests.includes('collect_axe') && index.quests.includes('hunt_task'), 'quests 含 collect_axe/hunt_task')
  check(index.items.includes('axe') && index.items.includes('wood'), 'items 含 axe/wood')
  check(index.items.length === itemFiles, `items 覆盖全部 ${itemFiles} 个 item 文件`, `got=${index.items.length}`)
  check(index.archetypes.length === entityFiles && index.archetypes.includes('wolf'), `archetypes 覆盖全部 ${entityFiles} 个实体文件且含 wolf`, `got=${index.archetypes.length}`)

  // ---- 5) driver 端到端（A5-2 + getSchema/listRegistries） ----
  console.log('\n[smoke] driver 端到端（spawn：cwd=GAME_ROOT + TSX_TSCONFIG_PATH）：')
  const driverRun = await runDriverRpc([
    { id: 1, method: 'ping', params: {} },
    { id: 2, method: 'getSchema', params: { kind: 'GameDefinition' } },
    { id: 3, method: 'listRegistries', params: {} },
  ])

  const pingFrame = driverRun.frames.get(1)
  check(pingFrame?.ok === true && pingFrame.result?.pong === true, 'driver ping/pong', `zod=${pingFrame?.result?.zodVersion ?? '?'}`)
  check(pingFrame?.result?.frameworkOk === true, 'driver frameworkOk')

  const schemaFrame = driverRun.frames.get(2)
  const driverSchema = schemaFrame?.result?.jsonSchema
  check(schemaFrame?.ok === true && driverSchema?.type === 'object', 'driver getSchema(GameDefinition) 返回 object schema')
  check(typeof driverSchema?.properties?.tickRate?.description === 'string', 'driver getSchema 携带 JSDoc description')

  const regFrame = driverRun.frames.get(3)
  const reg = regFrame?.result
  check(regFrame?.ok === true && Array.isArray(reg?.systems) && reg.systems.length > 0, `driver listRegistries systems=${reg?.systems?.length ?? '?'}`)
  check(reg?.components !== null && typeof reg?.components === 'object' && !Array.isArray(reg.components), `driver listRegistries components 为对象（${Object.keys(reg?.components ?? {}).length} 项）`)
  const metaEntries = [
    ...(reg?.systems ?? []),
    ...(reg?.archetypes ?? []),
    ...(reg?.actions ?? []),
    ...(reg?.mapGenerators ?? []),
    ...Object.values(reg?.components ?? {}).filter(Boolean),
  ] as Array<Record<string, unknown>>
  const descCount = metaEntries.filter((e) => typeof e.description === 'string' && (e.description as string).length > 0).length
  const schemaCount = metaEntries.filter((e) => e.configSchema && typeof e.configSchema === 'object').length
  check(descCount > 0, `注册表条目携带 description`, `${descCount}/${metaEntries.length}`)
  check(schemaCount > 0, `注册表条目携带 configSchema`, `${schemaCount}/${metaEntries.length}`)

  if (fs.existsSync(path.join(GAME_ROOT, 'src', 'register.ts'))) {
    check(driverRun.stderr.includes('已加载本体 src/register.ts'), 'A5-2：driver 已动态加载本体 src/register.ts')
  } else {
    console.log('  ⊘ 无本体 src/register.ts，跳过 A5-2 断言')
  }

  console.log(`\n[smoke] 结果：${failures.length === 0 ? 'PASS（全部断言通过）' : `FAIL（${failures.length} 项）`}`)
  if (failures.length) {
    for (const f of failures) console.log(`  ✘ ${f}`)
    process.exitCode = 1
  }
}

interface ConfigTreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: ConfigTreeNode[]
}

interface DriverRun {
  frames: Map<number, any>
  stderr: string
}

/**
 * spawn driver 子进程并发一批 RPC，全部响应到齐（或进程退出）即关闭 stdin。
 * spawn 参数复刻 server/src/sidecar/client.ts:14-17：cwd=GAME_ROOT + TSX_TSCONFIG_PATH
 * （env 必须在 spawn 前给出——tsx 加载器初始化时读取；脚本体内的 process.env 赋值
 * 对同进程动态 import 无效）。
 */
function runDriverRpc(
  reqs: Array<{ id: number; method: string; params: Record<string, unknown> }>,
  timeoutMs = 60_000,
): Promise<DriverRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(REPO_ROOT, 'server', 'sidecar', 'driver.ts')], {
      cwd: GAME_ROOT,
      env: { ...process.env, TSX_TSCONFIG_PATH: path.join(GAME_ROOT, 'tsconfig.json') },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const frames = new Map<number, any>()
    const wanted = reqs.map((r) => r.id)
    let stdoutBuf = ''
    let stderr = ''
    const settled = (): boolean => wanted.every((id) => frames.has(id))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`driver RPC 超时（${timeoutMs}ms），已收帧 ${[...frames.keys()].join(',') || '无'}`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk
      let idx: number
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim()
        stdoutBuf = stdoutBuf.slice(idx + 1)
        if (!line) continue
        try {
          const frame = JSON.parse(line) as { id: number }
          frames.set(frame.id, frame)
        } catch {
          /* 非协议行忽略（stdout 纪律破坏由 stderr 诊断/进程崩溃暴露） */
        }
      }
      if (settled()) {
        clearTimeout(timer)
        child.stdin.end()
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', () => {
      clearTimeout(timer)
      if (settled()) resolve({ frames, stderr })
      else reject(new Error(`driver 退出但缺失响应：${wanted.filter((id) => !frames.has(id)).join(',')}`))
    })
    for (const r of reqs) child.stdin.write(`${JSON.stringify(r)}\n`)
  })
}

function buildTree(absDir: string, relPrefix: string): ConfigTreeNode {
  const dirs: ConfigTreeNode[] = []
  const files: ConfigTreeNode[] = []
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) dirs.push(buildTree(path.join(absDir, entry.name), rel))
    else if (entry.isFile()) files.push({ name: entry.name, path: rel, type: 'file' })
  }
  const byName = (a: ConfigTreeNode, b: ConfigTreeNode): number => a.name.localeCompare(b.name)
  return { name: path.basename(absDir), path: relPrefix, type: 'dir', children: [...dirs.sort(byName), ...files.sort(byName)] }
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err)
  process.exit(1)
})
