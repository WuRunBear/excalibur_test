/**
 * schemaDescribe —— TS 源码前导 JSDoc → zod v4 描述注册表（P1，sidecar 侧）。
 *
 * 把一次性 spike（scripts/spike-jsdoc-schema.mts，16/16 通过）的三段逻辑产品化：
 *   1. buildSchemaRegistry(schemaTable)：ts-morph 解析 `<GAME_ROOT>/framework/
 *      config/schema/*.ts` 的前导 JSDoc，按属性名与运行时 zod shape 双侧递归
 *      对齐，用 `z.registry()` 建描述注册表（按 schema 实例身份补 description）。
 *   2. 对齐告警（组合 bullet 共享描述、文档块错位、shape 不一致）落日志，
 *      不阻断启动。
 *   3. schemaToJson(schema, registry)：`z.toJSONSchema(schema, { metadata: registry,
 *      reused: "inline" })` 统一 JSON Schema 出口。
 *
 * 关键机制（spike 实测，见 docs/spike-jsdoc-schema-report.md）：
 *   - `.meta()` 会克隆实例，无法给"已加载的 zod 实例"事后补描述；registry 按
 *     **实例身份**补 description，且不替换 shape 里的节点引用——本链路的关键。
 *   - 包装节点（optional/default/nullable/readonly）按 `_zod.def.innerType` 解包；
 *     描述挂外层包装实例即可被 toJSONSchema 采纳。
 *   - 默认 `reused: "inline"`：无 $defs/$ref。
 *
 * GAME_ROOT 锚定与 driver.ts:116-135 同源（cwd 探测优先，退化按本文件位置推断）；
 * zod 经 createRequire(<GAME_ROOT>/framework/index.ts) 解析——与 schema 同实例
 * （pnpm 双仓下 server 自己的 zod 不是同一实例）。
 *
 * 本文件位于 server/sidecar/，不在 server tsconfig 的 include 内；由 driver 以
 * tsx 运行时加载，冒烟脚本 scripts/smoke-schema-registry.mts 直测。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { Project, SyntaxKind, ts } from 'ts-morph'
import type {
  CallExpression,
  Expression,
  Node,
  PropertyAccessExpression,
  PropertyAssignment,
  SourceFile,
  VariableDeclaration,
} from 'ts-morph'

// ---------------------------------------------------------------------------
// GAME_ROOT / zod（单实例）
// ---------------------------------------------------------------------------

/** spawn 契约 cwd=GAME_ROOT；按 cwd 探测优先，退化按本文件位置推断（同 driver）。 */
export function resolveGameRoot(explicit?: string): string {
  if (explicit) return path.resolve(explicit)
  const cwd = process.cwd()
  if (fs.existsSync(path.join(cwd, 'framework', 'index.ts'))) return cwd
  const here = path.dirname(fileURLToPath(import.meta.url)) // <repo>/server/sidecar
  return path.resolve(here, '..', '..', '..', 'game_server_test')
}

/** GAME_ROOT 锚定的 zod 实例缓存（key = gameRoot，避免多根串台）。 */
let zodCache: { gameRoot: string; z: any } | null = null
function getZod(gameRoot: string): any {
  if (zodCache && zodCache.gameRoot === gameRoot) return zodCache.z
  const requireFromGame = createRequire(path.join(gameRoot, 'framework', 'index.ts'))
  const z = (requireFromGame('zod') as any).z
  if (!z || typeof z.registry !== 'function' || typeof z.toJSONSchema !== 'function') {
    throw new Error(`GAME_ROOT zod 缺少 registry/toJSONSchema（${gameRoot}）`)
  }
  zodCache = { gameRoot, z }
  return z
}

/** 默认 schema 源目录（GAME_ROOT 相对）；个别 kind 的源在别处（见 entityRules）。 */
const SCHEMA_DIR = 'framework/config/schema'

/**
 * kind → schema 源文件（GAME_ROOT 相对路径）与根导出名。
 *
 * 前 8 个为 SCHEMA_TABLE 既有 kind；P5（plan §1.3）新增后 8 个——它们是
 * validateWhole（本体 loadGameDefinition 逐文件 parse）消费、但此前不在
 * SCHEMA_TABLE 的 schema，纳入 getSchema 以点亮前端表单描述。kind 命名与
 * server 端文件路由（configService 的表单 kind 元数据路由）逐一对齐。
 * 未登记的 kind 在 buildSchemaRegistry 中告警跳过。
 */
export const KIND_SOURCES: Record<string, { file: string; exportName: string }> = {
  GameDefinition: { file: `${SCHEMA_DIR}/GameDefinitionSchema.ts`, exportName: 'GameDefinitionSchema' },
  Archetype: { file: `${SCHEMA_DIR}/ArchetypeSchema.ts`, exportName: 'ArchetypeSchema' },
  MapRegistry: { file: `${SCHEMA_DIR}/MapRegistrySchema.ts`, exportName: 'MapRegistrySchema' },
  combat: { file: `${SCHEMA_DIR}/RuleSchema.ts`, exportName: 'CombatRuleSchema' },
  needs: { file: `${SCHEMA_DIR}/RuleSchema.ts`, exportName: 'NeedsRuleSchema' },
  crafting: { file: `${SCHEMA_DIR}/RuleSchema.ts`, exportName: 'CraftingRuleSchema' },
  daynight: { file: `${SCHEMA_DIR}/RuleSchema.ts`, exportName: 'DayNightRuleSchema' },
  server: { file: `${SCHEMA_DIR}/RuleSchema.ts`, exportName: 'ServerRuleSchema' },
  // P5 §1.3 新增：validateWhole 逐文件消费的 schema（此前未纳入 getSchema）
  items: { file: `${SCHEMA_DIR}/ItemKindSchema.ts`, exportName: 'ItemKindSchema' },
  dialogues: { file: `${SCHEMA_DIR}/DialogueSchema.ts`, exportName: 'DialogueRegistrySchema' },
  quests: { file: `${SCHEMA_DIR}/QuestSchema.ts`, exportName: 'QuestRegistrySchema' },
  ecosystems: { file: `${SCHEMA_DIR}/EcosystemsSchema.ts`, exportName: 'EcosystemsSchema' },
  behaviors: { file: `${SCHEMA_DIR}/BehaviorSchema.ts`, exportName: 'BehaviorSchema' },
  player: { file: `${SCHEMA_DIR}/PlayerRuleSchema.ts`, exportName: 'PlayerRuleSchema' },
  raid: { file: `${SCHEMA_DIR}/RuleSchema.ts`, exportName: 'RaidRuleSchema' },
  entityRules: { file: 'framework/map/evolution/schema.ts', exportName: 'EntityRulesDocumentSchema' },
}

// ---------------------------------------------------------------------------
// 公开 DTO
// ---------------------------------------------------------------------------

/** 单 kind 对齐报告（冒烟/诊断用）。 */
export interface SchemaAlignReport {
  kind: string
  file: string
  exportName: string
  /** AST 扫到的对象字段数（含数组/record 内层）。 */
  scannedFields: number
  /** 属性自身 JSDoc 字段数。 */
  directFields: number
  /** 最终取到描述的字段数（含 bullet/ref 回退）。 */
  describedFields: number
  /** 挂到 registry 的描述条数。 */
  attachments: number
  warnings: string[]
}

export interface BuildSchemaRegistryOptions {
  /** 显式 GAME_ROOT（缺省与 driver 同源解析）。 */
  gameRoot?: string
  /** 对齐告警回调（缺省 console.warn；driver 下落 stderr）。 */
  onWarn?: (message: string) => void
  /** 每 kind 报告回调。 */
  onReport?: (report: SchemaAlignReport) => void
}

export interface SchemaToJsonOptions {
  gameRoot?: string
}

// ---------------------------------------------------------------------------
// zod 运行时内省
// ---------------------------------------------------------------------------

/** 包装类节点：解包到内层结构节点（描述仍挂在外层包装实例上）。 */
const WRAPPER_TYPES = new Set(['default', 'optional', 'nullable', 'readonly', 'nonoptional', 'prefault'])
const UNWRAP_TYPES = new Set([...WRAPPER_TYPES, 'catch', 'promise'])

function defOf(schema: any): any {
  return schema?._zod?.def
}
function typeOf(schema: any): string | undefined {
  return defOf(schema)?.type
}
function unwrap(schema: any): any {
  let cur = schema
  let guard = 0
  while (cur && guard++ < 50) {
    const t = typeOf(cur)
    const inner = defOf(cur)?.innerType
    if (inner && UNWRAP_TYPES.has(t)) {
      cur = inner
      continue
    }
    if (t === 'pipe' && defOf(cur)?.in) {
      cur = defOf(cur).in
      continue
    }
    break
  }
  return cur
}
function objectShape(schema: any): Record<string, any> | undefined {
  try {
    return schema?.shape
  } catch {
    return undefined
  }
}
function arrayElement(schema: any): any {
  return defOf(schema)?.element
}
function recordValue(schema: any): any {
  return defOf(schema)?.valueType
}
function unionOptions(schema: any): any[] {
  return defOf(schema)?.options ?? []
}

// ---------------------------------------------------------------------------
// AST 侧：schema 描述符
// ---------------------------------------------------------------------------

type AstKind = 'object' | 'array' | 'record' | 'union' | 'leaf'

interface AstField {
  name: string
  directDescription?: string
  /** 经 bullet（所属声明 / 同文件兜底）得到的描述。 */
  bulletDescription?: string
  /** bullet 来源：所属声明块 or 同文件其他声明（文档块错位）。 */
  bulletFrom?: 'own' | 'fallback'
  description?: string
  valueSchema: AstSchema
  file: string
  line: number
}

interface AstSchema {
  kind: AstKind
  fields?: AstField[]
  element?: AstSchema
  value?: AstSchema
  options?: AstSchema[]
  viaRef?: boolean
  declName?: string
  declDescription?: string
  file?: string
  line?: number
}

const BASE_METHODS = new Set([
  'object',
  'strictObject',
  'looseObject',
  'array',
  'record',
  'discriminatedUnion',
  'union',
  'tuple',
  'map',
  'set',
  'lazy',
])

function findBaseCall(expr: Expression | undefined): { prop: string; call: CallExpression } | undefined {
  let cur: Node | undefined = expr
  let guard = 0
  while (cur && guard++ < 50 && cur.getKind() === SyntaxKind.CallExpression) {
    const call = cur as CallExpression
    const callee = call.getExpression()
    if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return undefined
    const prop = (callee as PropertyAccessExpression).getName()
    if (BASE_METHODS.has(prop)) return { prop, call }
    cur = (callee as PropertyAccessExpression).getExpression()
  }
  return undefined
}

// ---- JSDoc 文本提取 -------------------------------------------------------

function jsDocsOfStatement(node: Node): string[] {
  const stmt = node.getFirstAncestorByKind(SyntaxKind.VariableStatement) ?? node.asKind(SyntaxKind.VariableStatement)
  if (!stmt) return []
  return stmt
    .getJsDocs()
    .map((d) => d.getDescription().trim())
    .filter(Boolean)
}
function jsDocsOfProperty(pa: PropertyAssignment): string[] {
  try {
    const comments = ts.getJSDocCommentsAndTags(pa.compilerNode)
    const out: string[] = []
    for (const c of comments) {
      if (c.kind !== SyntaxKind.JSDoc) continue
      const text = ts.getTextOfJSDocComment((c as ts.JSDoc).comment)
      if (text && text.trim()) out.push(text.trim())
    }
    if (out.length) return out
  } catch {
    /* fallthrough */
  }
  try {
    const ranges = pa.getLeadingCommentRanges()
    const raw = ranges.map((r) => r.getText()).join('\n')
    const cleaned = raw
      .replace(/\/\*\*?/g, '')
      .replace(/\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/^\s*\*\s?/, ''))
      .join('\n')
      .trim()
    return cleaned ? [cleaned] : []
  } catch {
    return []
  }
}

/** bullet 解析结果：name→desc，以及"组合 bullet"（一名多字段共享）告警条目。 */
interface BulletParse {
  map: Map<string, string>
  combined: { names: string[]; desc: string }[]
}

/** 解析 `- field：描述` / `- \`a\` / \`b\`：描述` 条目（含续行）。 */
function parseBullets(text: string): BulletParse {
  const map = new Map<string, string>()
  const combined: { names: string[]; desc: string }[] = []
  const lines = text.split('\n')
  let current: { names: string[]; parts: string[] } | null = null
  const flush = (): void => {
    if (!current) return
    const desc = current.parts.join(' ').replace(/\s+/g, ' ').trim()
    if (desc) {
      for (const n of current.names) if (!map.has(n)) map.set(n, desc)
      if (current.names.length > 1) combined.push({ names: current.names, desc })
    }
    current = null
  }
  for (const rawLine of lines) {
    const line = rawLine.replace(/^\s*\*\s?/, '')
    const m = /^\s*[-*]\s*(.+)$/.exec(line)
    if (m) {
      flush()
      const body = m[1].trim()
      const sep = /[：:]/.exec(body)
      if (!sep) continue
      const namePart = body.slice(0, sep.index)
      const descPart = body.slice(sep.index + 1).trim()
      const names = namePart
        .split('/')
        .map((n) => n.replace(/[`*]/g, '').trim())
        .filter(Boolean)
      current = { names, parts: descPart ? [descPart] : [] }
    } else if (current && /^\s+\S/.test(rawLine) && !/^\s*[-*]/.test(line)) {
      current.parts.push(line.trim())
    } else if (!line.trim()) {
      // 空行不结束 bullet
    } else {
      flush()
    }
  }
  flush()
  return { map, combined }
}

/** 同文件内所有 JSDoc 块的 bullet 汇总（兜底，按源码顺序首个命中）。 */
function fileBullets(file: SourceFile): Map<string, string> {
  const cached = fileBulletsCache.get(file)
  if (cached) return cached
  const merged = new Map<string, string>()
  const add = (texts: string[]): void => {
    for (const t of texts) for (const [k, v] of parseBullets(t).map) if (!merged.has(k)) merged.set(k, v)
  }
  for (const stmt of file.getVariableStatements()) {
    add(stmt.getJsDocs().map((d) => d.getDescription()))
    const init = stmt.getDeclarationList().getDeclarations()[0]?.getInitializer()
    if (!init) continue
    for (const pa of init.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) add(jsDocsOfProperty(pa))
  }
  fileBulletsCache.set(file, merged)
  return merged
}
const fileBulletsCache = new WeakMap<SourceFile, Map<string, string>>()

// ---- AST schema 构建 ------------------------------------------------------

interface AstBuildCtx {
  project: Project
  varIndex: Map<string, { file: SourceFile; decl: VariableDeclaration }>
  cache: Map<string, AstSchema>
  /** 告警去重。 */
  seenWarnings: Set<string>
  warn: (message: string) => void
  /** 路径相对化用的 GAME_ROOT。 */
  gameRoot: string
}

function resolveIdentifier(
  name: string,
  file: SourceFile,
  ctx: AstBuildCtx,
  seen: Set<string>,
): AstSchema {
  const localDecl = file.getVariableDeclaration?.(name)
  const hit = (localDecl ? { file, decl: localDecl } : undefined) ?? ctx.varIndex.get(name)
  if (!hit?.decl) return { kind: 'leaf', viaRef: true, declName: name }
  const key = `${hit.file.getFilePath()}#${name}`
  const cached = ctx.cache.get(key)
  if (cached) return cached
  if (seen.has(key)) return { kind: 'leaf', viaRef: true, declName: name }
  const nextSeen = new Set(seen).add(key)
  const ast = astFromVariable(hit.decl, hit.file, ctx, nextSeen)
  ast.viaRef = true
  ast.declName = name
  ctx.cache.set(key, ast)
  return ast
}

function astFromVariable(
  decl: VariableDeclaration,
  file: SourceFile,
  ctx: AstBuildCtx,
  seen: Set<string>,
): AstSchema {
  const init: Expression | undefined = decl.getInitializer()
  const stmt = decl.getVariableStatement()
  const docs: string[] = stmt ? stmt.getJsDocs().map((d) => d.getDescription().trim()).filter(Boolean) : []
  for (const t of docs) collectCombinedBulletWarnings(t, ctx)
  const declDescription = docs.length ? docs[docs.length - 1] : undefined
  const ast = init ? astFromExpr(init, file, ctx, seen, docs) : { kind: 'leaf' as AstKind }
  if (declDescription && !ast.declDescription) ast.declDescription = declDescription
  ast.file = file.getFilePath()
  ast.line = decl.getStartLineNumber()
  return ast
}

function astFromExpr(
  expr: Expression | undefined,
  file: SourceFile,
  ctx: AstBuildCtx,
  seen: Set<string>,
  ownerDocs: string[] = [],
): AstSchema {
  if (!expr) return { kind: 'leaf' }
  const base = findBaseCall(expr)
  if (base) {
    const args = base.call.getArguments()
    switch (base.prop) {
      case 'object':
      case 'strictObject':
      case 'looseObject': {
        const arg = args[0]
        if (arg && arg.getKind() === SyntaxKind.ObjectLiteralExpression) {
          return buildObjectAst(arg as any, file, ctx, seen, ownerDocs)
        }
        return { kind: 'object', fields: [] }
      }
      case 'array':
        return { kind: 'array', element: astFromExpr(args[0], file, ctx, seen) }
      case 'record':
        return { kind: 'record', value: astFromExpr(args[args.length - 1], file, ctx, seen) }
      case 'discriminatedUnion':
      case 'union': {
        const arr = args[args.length - 1]
        const options: AstSchema[] = []
        if (arr && arr.getKind() === SyntaxKind.ArrayLiteralExpression) {
          for (const el of (arr as any).getElements()) options.push(astFromExpr(el, file, ctx, seen))
        }
        return { kind: 'union', options }
      }
      default:
        return { kind: 'leaf' }
    }
  }
  if (expr.getKind() === SyntaxKind.Identifier) {
    return resolveIdentifier(expr.getText(), file, ctx, seen)
  }
  return { kind: 'leaf' }
}

function buildObjectAst(
  obj: any,
  file: SourceFile,
  ctx: AstBuildCtx,
  seen: Set<string>,
  ownerDocs: string[],
): AstSchema {
  const ownBullets = new Map<string, string>()
  for (const t of ownerDocs) {
    for (const [k, v] of parseBullets(t).map) if (!ownBullets.has(k)) ownBullets.set(k, v)
  }
  const fBullets = fileBullets(file)
  const fields: AstField[] = []
  for (const prop of obj.getProperties()) {
    if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue
    const pa = prop as PropertyAssignment
    const name = pa.getName()
    const directList = jsDocsOfProperty(pa)
    const directDescription = directList[0]
    const own = ownBullets.get(name)
    const fallback = own === undefined ? fBullets.get(name) : undefined
    const bulletDescription = own ?? fallback
    const bulletFrom: AstField['bulletFrom'] = own !== undefined ? 'own' : fallback !== undefined ? 'fallback' : undefined
    if (bulletFrom === 'fallback') {
      ctx.warn(
        `文档块错位：字段 "${name}"（${rel(file.getFilePath(), ctx)}:${pa.getStartLineNumber()}）的描述取自同文件其他声明的 bullet（存在同名误配风险）`,
      )
    }
    const init = pa.getInitializer()
    const valueSchema = astFromExpr(init, file, ctx, seen)
    fields.push({
      name,
      directDescription,
      bulletDescription,
      bulletFrom,
      description: directDescription ?? bulletDescription,
      valueSchema,
      file: file.getFilePath(),
      line: pa.getStartLineNumber(),
    })
  }
  return { kind: 'object', fields }
}

/** 组合 bullet（`- a/b/c：同一句`）共享描述告警。 */
function collectCombinedBulletWarnings(text: string, ctx: AstBuildCtx): void {
  for (const c of parseBullets(text).combined) {
    ctx.warn(`组合 bullet 共享描述：「${c.names.join('/')}」→ "${truncate(c.desc, 48)}"（逐字段对齐会重复）`)
  }
}

function truncate(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}

function rel(file: string, ctx?: AstBuildCtx): string {
  const root = ctx?.gameRoot ?? ''
  if (root && file.startsWith(root)) return 'game_server_test/' + path.relative(root, file)
  return file
}

// ---------------------------------------------------------------------------
// 对齐 + registry 注入
// ---------------------------------------------------------------------------

interface Attachment {
  path: (string | number)[]
  description: string
  source: 'jsdoc' | 'bullet' | 'ref-decl'
}

interface AlignReport {
  attachments: Attachment[]
  warnings: string[]
  fields: { direct: boolean; doc: boolean }[]
}

function align(
  runtimeNode: any,
  ast: AstSchema,
  pathSegs: (string | number)[],
  descForNode: string | undefined,
  _sourceOfDesc: Attachment['source'] | undefined,
  registry: any,
  report: AlignReport,
  warn: (message: string) => void,
): void {
  if (runtimeNode == null) return
  if (descForNode) {
    registry.add(runtimeNode, { description: descForNode })
    report.attachments.push({ path: pathSegs, description: descForNode, source: 'jsdoc' })
  }
  const node = unwrap(runtimeNode)
  const t = typeOf(node)

  if (ast.kind === 'object') {
    if (t !== 'object') {
      warn(`AST=object 但运行时 type=${t ?? '?'} @ ${pathLabel(pathSegs)}（跳过递归）`)
      return
    }
    const shape = objectShape(node) ?? {}
    const runtimeKeys = new Set(Object.keys(shape))
    for (const f of ast.fields!) {
      const rt = shape[f.name]
      const childPath = [...pathSegs, 'properties', f.name]
      if (rt === undefined) {
        warn(`运行时 shape 缺字段 "${f.name}" @ ${pathLabel(pathSegs)}（源码 ${rel(f.file)}:${f.line}）`)
        report.fields.push({ direct: !!f.directDescription, doc: false })
        continue
      }
      runtimeKeys.delete(f.name)
      const childDesc = f.description ?? (f.valueSchema.viaRef ? f.valueSchema.declDescription : undefined)
      report.fields.push({ direct: !!f.directDescription, doc: !!childDesc })
      if (childDesc) report.attachments.push({ path: childPath, description: childDesc, source: 'jsdoc' })
      align(rt, f.valueSchema, childPath, childDesc, undefined, registry, report, warn)
    }
    for (const extra of runtimeKeys) {
      warn(`源码缺字段 "${extra}"（运行时 shape 有）@ ${pathLabel(pathSegs)}`)
    }
    return
  }

  if (ast.kind === 'array') {
    if (t !== 'array') {
      warn(`AST=array 但运行时 type=${t ?? '?'} @ ${pathLabel(pathSegs)}`)
      return
    }
    const childPath = [...pathSegs, 'items']
    const childDesc = ast.element?.viaRef ? ast.element.declDescription : undefined
    align(arrayElement(node), ast.element ?? { kind: 'leaf' }, childPath, childDesc, undefined, registry, report, warn)
    return
  }

  if (ast.kind === 'record') {
    if (t !== 'record') {
      warn(`AST=record 但运行时 type=${t ?? '?'} @ ${pathLabel(pathSegs)}`)
      return
    }
    const childPath = [...pathSegs, 'additionalProperties']
    const childDesc = ast.value?.viaRef ? ast.value.declDescription : undefined
    align(recordValue(node), ast.value ?? { kind: 'leaf' }, childPath, childDesc, undefined, registry, report, warn)
    return
  }

  if (ast.kind === 'union') {
    if (t !== 'union') {
      warn(`AST=union 但运行时 type=${t ?? '?'} @ ${pathLabel(pathSegs)}`)
      return
    }
    const opts = unionOptions(node)
    const astOpts = ast.options ?? []
    for (let i = 0; i < astOpts.length; i++) {
      const childPath = [...pathSegs, 'oneOf', i]
      const o = astOpts[i]!
      const childDesc = o.viaRef ? o.declDescription : undefined
      align(opts[i], o, childPath, childDesc, undefined, registry, report, warn)
    }
    if (opts.length !== astOpts.length) {
      warn(`union 分支数不一致：AST=${astOpts.length} 运行时=${opts.length} @ ${pathLabel(pathSegs)}`)
    }
    return
  }
  // leaf：描述已在上方挂好
}

function pathLabel(pathSegs: (string | number)[]): string {
  return pathSegs.length ? '/' + pathSegs.join('/') : '(root)'
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 读取 KIND_SOURCES 引用到的全部源目录的 .ts（默认 schema 目录 + 个别 kind 的
 * 源目录，如 framework/map/evolution）+ 建全局变量索引（跨文件标识符解析用）。
 */
function loadProject(gameRoot: string): { project: Project; varIndex: Map<string, { file: SourceFile; decl: VariableDeclaration }> } {
  const dirs = new Set<string>()
  for (const src of Object.values(KIND_SOURCES)) {
    dirs.add(path.dirname(path.join(gameRoot, src.file)))
  }
  const project = new Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true })
  let added = 0
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      project.addSourceFileAtPath(path.join(dir, f))
      added += 1
    }
  }
  if (added === 0) throw new Error(`schema 源目录为空（检查 ${[...dirs].join(', ')}）`)
  const varIndex = new Map<string, { file: SourceFile; decl: VariableDeclaration }>()
  for (const sf of project.getSourceFiles()) {
    for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const name = decl.getName()
      if (!varIndex.has(name)) varIndex.set(name, { file: sf, decl })
    }
  }
  return { project, varIndex }
}

/**
 * 构建描述注册表：遍历 schemaTable 的 kind，用 ts-morph 源 AST 与运行时 zod
 * 实例双侧对齐，返回 `z.registry()`。单 kind 失败仅告警跳过（不阻断启动）。
 * 未在 KIND_SOURCES 登记的 kind 告警跳过。
 */
export function buildSchemaRegistry(
  schemaTable: Record<string, unknown>,
  options: BuildSchemaRegistryOptions = {},
): unknown {
  const gameRoot = resolveGameRoot(options.gameRoot)
  const warn = options.onWarn ?? ((m: string) => console.warn(`[schemaDescribe] ${m}`))
  const z = getZod(gameRoot)
  const registry = z.registry()
  let loaded: ReturnType<typeof loadProject> | null = null
  try {
    loaded = loadProject(gameRoot)
  } catch (err) {
    warn(`加载 schema 源失败，描述注册表为空：${err instanceof Error ? err.message : String(err)}`)
    return registry
  }
  const { project, varIndex } = loaded

  for (const kind of Object.keys(schemaTable)) {
    const src = KIND_SOURCES[kind]
    if (!src) {
      warn(`kind "${kind}" 无 schema 源映射，跳过描述对齐`)
      continue
    }
    try {
      const file = project.getSourceFileOrThrow(path.join(gameRoot, src.file))
      const decl = file.getVariableDeclarationOrThrow(src.exportName)
      const ctx: AstBuildCtx = {
        project,
        varIndex,
        cache: new Map(),
        seenWarnings: new Set(),
        gameRoot,
        warn: (m) => {
          if (ctx.seenWarnings.has(m)) return
          ctx.seenWarnings.add(m)
          warn(`[${kind}] ${m}`)
        },
      }
      const ast = astFromVariable(decl, file, ctx, new Set())
      const report: AlignReport = { attachments: [], warnings: [], fields: [] }
      align(schemaTable[kind], ast, [], undefined, undefined, registry, report, ctx.warn)
      for (const w of report.warnings) {
        if (ctx.seenWarnings.has(w)) continue
        ctx.seenWarnings.add(w)
        warn(`[${kind}] ${w}`)
      }
      const allWarnings = [...ctx.seenWarnings]
      options.onReport?.({
        kind,
        file: src.file,
        exportName: src.exportName,
        scannedFields: report.fields.length,
        directFields: report.fields.filter((f) => f.direct).length,
        describedFields: report.fields.filter((f) => f.doc).length,
        attachments: report.attachments.length,
        warnings: allWarnings,
      })
    } catch (err) {
      warn(`[${kind}] 描述对齐失败（继续）：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return registry
}

/** 统一 JSON Schema 出口：registry 按实例身份补 description；inline 无 $ref。 */
export function schemaToJson(
  schema: unknown,
  registry: unknown,
  options: SchemaToJsonOptions = {},
): unknown {
  const gameRoot = resolveGameRoot(options.gameRoot)
  const z = getZod(gameRoot)
  return z.toJSONSchema(schema, { metadata: registry, reused: 'inline' })
}
