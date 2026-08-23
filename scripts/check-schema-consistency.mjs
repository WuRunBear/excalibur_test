import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * 跨端 schema 一致性护栏（D4）。
 *
 * 背景：
 * - 服务端权威 schema 定义在 game_server_test/framework/net/colyseus/state/（RoomState.ts 等）
 * - 客户端协议文件是 src/game/net/schema.ts（由 schema:gen + schema:sync 产出）
 * - 已知风险：schema-codegen 出错时可能以 exit 0 静默失败（输出空/缺文件），
 *   且 sync-colyseus-schema.mjs 在源缺失时静默跳过——两端 schema 漂移无任何信号，
 *   客户端解码增量补丁时才会爆发。本脚本把「漂移」变成硬失败。
 *
 * 校验内容：
 * 1. 客户端 schema.ts 存在且非空（空文件 = codegen 静默失败的典型产物）
 * 2. 服务端每个 `export class X extends Schema` 的类名与 @type() 字段名集合，
 *    与客户端 schema.ts 中同名类完全一致（双向对比，多/缺/改任一即失败）
 *
 * 注意：只比「类名 + 字段名」，不比字段类型与顺序——类型由 TypeScript 编译兜底，
 * 字段名是增量补丁编解码的关键路径（名字不一致 = refId/field 解码失败）。
 *
 * 使用方式：
 * - 在 excalibur_test 下运行：pnpm schema:check
 * - 已接入 pnpm check / check:all（run-s 第一个环节，漂移先于 lint/type-check 报错）
 * - 测试用位置参数可覆盖路径（默认取仓库相对布局）：
 *   node scripts/check-schema-consistency.mjs [serverStateDir] [clientSchemaPath]
 */
const projectRoot = path.resolve(import.meta.dirname, '..')
const serverStateDir =
  process.argv[2] ??
  path.resolve(projectRoot, '..', 'game_server_test', 'framework', 'net', 'colyseus', 'state')
const clientSchemaPath =
  process.argv[3] ?? path.resolve(projectRoot, 'src', 'game', 'net', 'schema.ts')

/**
 * 从源码中提取 schema 定义：`export class X extends Schema` 的类名与 @type() 字段名。
 * @param {string} source
 * @returns {Map<string, Set<string>>} className → fieldName 集合
 */
function extractSchema(source) {
  const classes = new Map()
  const classRe = /export\s+class\s+(\w+)\s+extends\s+Schema\s*\{/g
  const starts = [...source.matchAll(classRe)]
  starts.forEach((match, i) => {
    const bodyEnd = i + 1 < starts.length ? starts[i + 1].index : source.length
    const body = source.slice(match.index, bodyEnd)
    const fields = new Set()
    // 服务端格式：@type("uint32")\n  tick: number = 0;
    // 生成格式：  @type("uint32") public tick!: number;
    for (const fm of body.matchAll(/@type\([^)]*\)\s*(?:public\s+)?(\w+)/g)) {
      fields.add(fm[1])
    }
    classes.set(match[1], fields)
  })
  return classes
}

function fmtClass(name, fields) {
  return `${name}(${[...fields].sort().join(', ')})`
}

const problems = []

// 1) 客户端 schema 必须存在且非空
let clientSource = ''
try {
  clientSource = await fs.readFile(clientSchemaPath, 'utf8')
} catch (err) {
  console.error(`[schema:check] FAIL: 客户端 schema 不可读（${clientSchemaPath}）：${err.message}`)
  console.error(
    '[schema:check] 先运行：cd ../game_server_test && pnpm schema:gen && cd ../excalibur_test && pnpm schema:sync',
  )
  process.exit(1)
}
if (clientSource.trim().length === 0) {
  console.error(
    `[schema:check] FAIL: 客户端 schema 为空文件（${clientSchemaPath}）——schema-codegen 静默失败的典型产物`,
  )
  process.exit(1)
}

// 2) 服务端 state 目录下所有 Schema 类与客户端逐类比对
let serverFiles
try {
  serverFiles = (await fs.readdir(serverStateDir)).filter((f) => f.endsWith('.ts'))
} catch (err) {
  console.error(`[schema:check] FAIL: 服务端 state 目录不可读（${serverStateDir}）：${err.message}`)
  process.exit(1)
}

const serverClasses = new Map()
for (const file of serverFiles) {
  const source = await fs.readFile(path.join(serverStateDir, file), 'utf8')
  for (const [name, fields] of extractSchema(source)) {
    serverClasses.set(name, fields)
  }
}
if (serverClasses.size === 0) {
  console.error(`[schema:check] FAIL: 服务端 state 目录未解析到任何 Schema 类（${serverStateDir}）`)
  process.exit(1)
}

const clientClasses = extractSchema(clientSource)

for (const [name, serverFields] of serverClasses) {
  const clientFields = clientClasses.get(name)
  if (!clientFields) {
    problems.push(`客户端缺类 ${name}（服务端: ${fmtClass(name, serverFields)}）`)
    continue
  }
  for (const field of serverFields) {
    if (!clientFields.has(field)) {
      problems.push(`${name} 缺字段 ${field}（客户端: ${fmtClass(name, clientFields)}）`)
    }
  }
}
for (const [name, clientFields] of clientClasses) {
  const serverFields = serverClasses.get(name)
  if (!serverFields) {
    problems.push(`客户端多出未知类 ${name}（${fmtClass(name, clientFields)}）——疑似残留或手改`)
    continue
  }
  for (const field of clientFields) {
    if (!serverFields.has(field)) {
      problems.push(`${name} 多出未知字段 ${field}（服务端: ${fmtClass(name, serverFields)}）`)
    }
  }
}

if (problems.length > 0) {
  console.error('[schema:check] FAIL: 两端 schema 漂移：')
  for (const p of problems) {
    console.error(`  - ${p}`)
  }
  console.error(
    '[schema:check] 修复：改服务端 state 定义后运行 game_server_test `pnpm schema:gen` + 本工程 `pnpm schema:sync`；勿手改 src/game/net/schema.ts',
  )
  process.exit(1)
}

console.log(
  `[schema:check] OK: 两端 schema 一致（服务端 ${serverClasses.size} 个类：${[...serverClasses.keys()]
    .sort()
    .join(', ')}）`,
)
