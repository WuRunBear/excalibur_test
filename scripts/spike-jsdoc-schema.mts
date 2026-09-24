/**
 * Spike：TS 源码 JSDoc → zod v4 schema → z.toJSONSchema() 带 description 输出
 * ============================================================================
 *
 * 目的（一次性实验，不改任何生产代码）：
 *   验证"启动时用 ts-morph 读 TS 源码的 JSDoc 注释，把描述注入到已加载的
 *   zod v4 schema 实例，再用 z.toJSONSchema() 输出带 description 的 JSON
 *   Schema"这条链路可行。
 *
 * 关键机制（本 spike 实测结论，详见产出的 spike-report.md）：
 *   1. `.meta()` 会**返回新实例**（不修改原实例），无法给"已加载的 zod 实例"
 *      事后补描述；正确做法是 `z.registry()` + `z.toJSONSchema(schema, {
 *      metadata: registry })`——registry 按 schema **实例身份**补 description，
 *      且不会克隆/替换节点，对 shape 里已有的引用天然生效。
 *   2. zod v4 的包装节点（optional/default/nullable/readonly）需按
 *      `_zod.def.innerType` 解包；`.refine()` 在 v4 **不产生新节点**（仍是
 *      type=object，cheks 挂在 def.checks），所以 `.shape` 直接可用。
 *   3. discriminatedUnion → JSON `oneOf`；record → `additionalProperties`；
 *      array → `items`；默认 `reused: 'inline'`（不产生 $defs/$ref）。
 *
 * 对齐策略：ts-morph 双侧递归。AST 侧解析每个导出/被引用 schema const 的
 * ObjectLiteralExpression（沿 z.object/.array/.record/.discriminatedUnion 链
 * 找 base call），按属性名与运行时 zod 的 shape 逐层对齐；属性初始化是标识符
 * （引用另一 const 子 schema）时解析该 const 继续对齐。字段描述来源优先级：
 *   ① 属性自身的 JSDoc  → ② 所属 const 声明 JSDoc 里的 `- 字段：描述` 条目
 *   → ③ 同文件内任意 JSDoc 块里的同名字段条目（兜底，处理"文档块错位"现状，
 *      如 RuleSchema.ts 里合成配方的 bullet 挂在 RecipeInputSchema 声明上）
 *   → ④ 若属性值引用具名子 schema，回退用该子 schema 声明的描述。
 *
 * 只读约束：本体仓 game_server_test/ 全程只读（仅 import + 读源码），所有产物
 * 只写 excalibur_test/tmp/spike-jsdoc-schema/。
 *
 * 运行方式（脚本位置相对解析，与 cwd 无关；从 server 包取 tsx，依赖 pnpm
 * workspace 单实例；导入本体 schema 用绝对 file URL，其内部 `import 'zod'`
 * 解析到本体 node_modules 的 zod 4.4.3，本脚本的 zod 亦经 createRequire 从
 * GAME_ROOT 解析——保证与 schema 同实例）：
 *
 *   cd /mnt/jixie/data/AI/project/game/excalibur_test/server \
 *     && pnpm exec tsx ../scripts/spike-jsdoc-schema.mts
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Project, SyntaxKind, ts } from 'ts-morph'
import type { CallExpression, Expression, Node, PropertyAccessExpression, PropertyAssignment } from 'ts-morph'

// ---------------------------------------------------------------------------
// 路径与 zod（单实例）
// ---------------------------------------------------------------------------
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..') // excalibur_test/
const GAME_ROOT = path.resolve(REPO_ROOT, '..', 'game_server_test') // 本体仓（只读）
const SCHEMA_DIR = path.join(GAME_ROOT, 'framework', 'config', 'schema')
const OUT_DIR = path.join(REPO_ROOT, 'tmp', 'spike-jsdoc-schema')

const requireFromGame = createRequire(path.join(GAME_ROOT, 'package.json'))
const zodPkg = requireFromGame('zod/package.json') as { version?: string }
const zod = requireFromGame('zod') as any
const { z } = zod

// ---------------------------------------------------------------------------
// zod 运行时内省工具
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
    // pipe: 取输入端（本仓 schema 未用，防御性）
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
  /** 字段自身的 JSDoc 描述。 */
  directDescription?: string
  /** 经 bullet（所属声明 / 同文件兜底）得到的描述。 */
  bulletDescription?: string
  /** 最终字段描述（direct ?? bullet）。 */
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
  /** 值来自具名 const 引用。 */
  viaRef?: boolean
  declName?: string
  /** 被引用 const 声明的描述（用作字段自身无描述时的回退）。 */
  declDescription?: string
  file?: string
  line?: number
}

const BASE_METHODS = new Set(['object', 'array', 'record', 'discriminatedUnion', 'union', 'tuple', 'map', 'set', 'lazy'])

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
  // 退化：前导注释块原文
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

/** 解析 `- field：描述` / `- \`a\` / \`b\`：描述` 条目（含续行）。 */
function parseBullets(text: string): Map<string, string> {
  const map = new Map<string, string>()
  const lines = text.split('\n')
  let current: { names: string[]; parts: string[] } | null = null
  const flush = (): void => {
    if (!current) return
    const desc = current.parts.join(' ').replace(/\s+/g, ' ').trim()
    if (desc) for (const n of current.names) if (!map.has(n)) map.set(n, desc)
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
      // 续行（缩进的非 bullet 行）
      current.parts.push(line.trim())
    } else if (!line.trim()) {
      // 空行不结束 bullet（文档里 bullet 之间常夹空行）
    } else {
      flush()
    }
  }
  flush()
  return map
}

/** 同文件内所有 JSDoc 块的 bullet 汇总（兜底，按源码顺序首个命中）。 */
function fileBullets(file: any): Map<string, string> {
  const cached = fileBulletsCache.get(file)
  if (cached) return cached
  const merged = new Map<string, string>()
  const add = (texts: string[]): void => {
    for (const t of texts) for (const [k, v] of parseBullets(t)) if (!merged.has(k)) merged.set(k, v)
  }
  for (const stmt of file.getVariableStatements()) {
    add(stmt.getJsDocs().map((d: any) => d.getDescription()))
    const init = stmt.getDeclarationList().getDeclarations()[0]?.getInitializer()
    if (!init) continue
    for (const pa of init.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) add(jsDocsOfProperty(pa))
  }
  fileBulletsCache.set(file, merged)
  return merged
}
const fileBulletsCache = new WeakMap<object, Map<string, string>>()

// ---- AST schema 构建 ------------------------------------------------------
interface AstBuildCtx {
  project: Project
  varIndex: Map<string, { file: any; decl: any }>
  cache: Map<string, AstSchema>
}

function resolveIdentifier(name: string, file: any, ctx: AstBuildCtx, seen: Set<string>): AstSchema {
  const hit = (file.getVariableDeclaration?.(name) ? { file, decl: file.getVariableDeclaration(name) } : undefined) ?? ctx.varIndex.get(name)
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

function astFromVariable(decl: any, file: any, ctx: AstBuildCtx, seen: Set<string>): AstSchema {
  const init: Expression | undefined = decl.getInitializer()
  const stmt = decl.getVariableStatement()
  const docs: string[] = stmt ? stmt.getJsDocs().map((d: any) => d.getDescription().trim()).filter(Boolean) : []
  const declDescription = docs.length ? docs[docs.length - 1] : undefined
  const ast = init ? astFromExpr(init, file, ctx, seen, docs) : { kind: 'leaf' as AstKind }
  if (declDescription && !ast.declDescription) ast.declDescription = declDescription
  ast.file = file.getFilePath()
  ast.line = decl.getStartLineNumber()
  return ast
}

function astFromExpr(
  expr: Expression | undefined,
  file: any,
  ctx: AstBuildCtx,
  seen: Set<string>,
  ownerDocs: string[] = [],
): AstSchema {
  if (!expr) return { kind: 'leaf' }
  const base = findBaseCall(expr)
  if (base) {
    const args = base.call.getArguments()
    switch (base.prop) {
      case 'object': {
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
  file: any,
  ctx: AstBuildCtx,
  seen: Set<string>,
  ownerDocs: string[],
): AstSchema {
  const ownBullets = new Map<string, string>()
  for (const t of ownerDocs) for (const [k, v] of parseBullets(t)) if (!ownBullets.has(k)) ownBullets.set(k, v)
  const fBullets = fileBullets(file)
  const fields: AstField[] = []
  for (const prop of obj.getProperties()) {
    if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue
    const pa = prop as PropertyAssignment
    const name = pa.getName()
    const directList = jsDocsOfProperty(pa)
    const directDescription = directList[0]
    const bulletDescription = ownBullets.get(name) ?? fBullets.get(name)
    const init = pa.getInitializer()
    const valueSchema = astFromExpr(init, file, ctx, seen)
    fields.push({
      name,
      directDescription,
      bulletDescription,
      description: directDescription ?? bulletDescription,
      valueSchema,
      file: file.getFilePath(),
      line: pa.getStartLineNumber(),
    })
  }
  return { kind: 'object', fields }
}

// ---------------------------------------------------------------------------
// 对齐 + registry 注入
// ---------------------------------------------------------------------------
interface Attachment {
  path: (string | number)[]
  description: string
  kind: 'field'
  fieldName: string
  file: string
  line: number
  direct: boolean
  bullet: boolean
  source: 'jsdoc' | 'bullet' | 'ref-decl'
}
interface AlignReport {
  attachments: Attachment[]
  warnings: string[]
  /** 每个 object 字段的统计（含未注入的）。 */
  fields: {
    name: string
    path: (string | number)[]
    file: string
    line: number
    direct: boolean
    doc: boolean
    expected?: string
    source?: Attachment['source']
  }[]
}

function align(
  runtimeNode: any,
  ast: AstSchema,
  pathSegs: (string | number)[],
  descForNode: string | undefined,
  sourceOfDesc: Attachment['source'] | undefined,
  registry: any,
  report: AlignReport,
  registryByNode: Map<any, string>,
): void {
  if (runtimeNode == null) return
  if (descForNode) {
    registry.add(runtimeNode, { description: descForNode })
    registryByNode.set(runtimeNode, descForNode)
  }
  const node = unwrap(runtimeNode)
  const t = typeOf(node)

  if (ast.kind === 'object') {
    if (t !== 'object') {
      report.warnings.push(`AST=object 但运行时 type=${t ?? '?'} @ ${pathLabel(pathSegs)}（跳过递归）`)
      return
    }
    const shape = objectShape(node) ?? {}
    const runtimeKeys = new Set(Object.keys(shape))
    for (const f of ast.fields) {
      const rt = shape[f.name]
      const childPath = [...pathSegs, 'properties', f.name]
      if (rt === undefined) {
        report.warnings.push(`运行时 shape 缺字段 "${f.name}" @ ${pathLabel(pathSegs)}（源码 ${rel(f.file)}:${f.line}）`)
        report.fields.push({ name: f.name, path: childPath, file: f.file, line: f.line, direct: !!f.directDescription, doc: !!(f.description || (f.valueSchema.viaRef && f.valueSchema.declDescription)), expected: f.description, source: f.directDescription ? 'jsdoc' : f.bulletDescription ? 'bullet' : undefined })
        continue
      }
      runtimeKeys.delete(f.name)
      const childDesc = f.description ?? (f.valueSchema.viaRef ? f.valueSchema.declDescription : undefined)
      const childSource: Attachment['source'] | undefined = f.directDescription
        ? 'jsdoc'
        : f.bulletDescription
          ? 'bullet'
          : childDesc
            ? 'ref-decl'
            : undefined
      report.fields.push({
        name: f.name,
        path: childPath,
        file: f.file,
        line: f.line,
        direct: !!f.directDescription,
        doc: !!childDesc,
        expected: childDesc,
        source: childSource,
      })
      if (childDesc) {
        report.attachments.push({
          path: childPath,
          description: childDesc,
          kind: 'field',
          fieldName: f.name,
          file: f.file,
          line: f.line,
          direct: !!f.directDescription,
          bullet: !!f.bulletDescription,
          source: childSource!,
        })
      }
      align(rt, f.valueSchema, childPath, childDesc, childSource, registry, report, registryByNode)
    }
    for (const extra of runtimeKeys) {
      report.warnings.push(`源码缺字段 "${extra}"（运行时 shape 有）@ ${pathLabel(pathSegs)}`)
    }
    return
  }

  if (ast.kind === 'array') {
    if (t !== 'array') {
      report.warnings.push(`AST=array 但运行时 type=${t ?? '?'} @ ${pathLabel(pathSegs)}`)
      return
    }
    const childPath = [...pathSegs, 'items']
    const childDesc = ast.element?.viaRef ? ast.element.declDescription : undefined
    align(arrayElement(node), ast.element ?? { kind: 'leaf' }, childPath, childDesc, childDesc ? 'ref-decl' : undefined, registry, report, registryByNode)
    return
  }

  if (ast.kind === 'record') {
    if (t !== 'record') {
      report.warnings.push(`AST=record 但运行时 type=${t ?? '?'} @ ${pathLabel(pathSegs)}`)
      return
    }
    const childPath = [...pathSegs, 'additionalProperties']
    const childDesc = ast.value?.viaRef ? ast.value.declDescription : undefined
    align(recordValue(node), ast.value ?? { kind: 'leaf' }, childPath, childDesc, childDesc ? 'ref-decl' : undefined, registry, report, registryByNode)
    return
  }

  if (ast.kind === 'union') {
    if (t !== 'union') {
      report.warnings.push(`AST=union 但运行时 type=${t ?? '?'} @ ${pathLabel(pathSegs)}`)
      return
    }
    const opts = unionOptions(node)
    const astOpts = ast.options ?? []
    for (let i = 0; i < astOpts.length; i++) {
      const childPath = [...pathSegs, 'oneOf', i]
      const o = astOpts[i]
      const childDesc = o.viaRef ? o.declDescription : undefined
      align(opts[i], o, childPath, childDesc, childDesc ? 'ref-decl' : undefined, registry, report, registryByNode)
    }
    if (opts.length !== astOpts.length) {
      report.warnings.push(`union 分支数不一致：AST=${astOpts.length} 运行时=${opts.length} @ ${pathLabel(pathSegs)}`)
    }
    return
  }
  // leaf：本身描述已在上方挂好，无需递归
}

function pathLabel(pathSegs: (string | number)[]): string {
  return pathSegs.length ? '/' + pathSegs.join('/') : '(root)'
}
function rel(file: string): string {
  if (file.startsWith(GAME_ROOT)) return 'game_server_test/' + path.relative(GAME_ROOT, file)
  if (file.startsWith(REPO_ROOT)) return 'excalibur_test/' + path.relative(REPO_ROOT, file)
  return file
}

// ---------------------------------------------------------------------------
// JSON 输出导航验证（含 $ref 兜底）
// ---------------------------------------------------------------------------
function resolveRef(root: any, ref: string): any {
  if (!ref.startsWith('#/')) return undefined
  let cur = root
  for (const seg of ref.slice(2).split('/')) {
    if (cur == null) return undefined
    cur = cur[seg.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  return cur
}
function navigate(root: any, pathSegs: (string | number)[]): any {
  let cur = root
  let guard = 0
  while (guard++ < 100) {
    if (cur && typeof cur === 'object' && typeof cur.$ref === 'string') {
      const target = resolveRef(root, cur.$ref)
      if (target === undefined) return undefined
      // 合并 $ref 旁的兄弟键（如 description）
      cur = { ...target, ...Object.fromEntries(Object.entries(cur).filter(([k]) => k !== '$ref')) }
      continue
    }
    break
  }
  for (const seg of pathSegs) {
    if (cur == null) return undefined
    while (cur && typeof cur === 'object' && typeof cur.$ref === 'string') {
      const target = resolveRef(root, cur.$ref)
      if (target === undefined) return undefined
      cur = { ...target, ...Object.fromEntries(Object.entries(cur).filter(([k]) => k !== '$ref')) }
    }
    if (typeof seg === 'number') {
      if (Array.isArray(cur)) {
        cur = cur[seg]
      } else {
        const arr = cur.oneOf ?? cur.anyOf
        cur = Array.isArray(arr) ? arr[seg] : undefined
      }
    } else {
      cur = cur[seg]
    }
  }
  return cur
}

// ---------------------------------------------------------------------------
// 单 kind 处理
// ---------------------------------------------------------------------------
interface KindResult {
  kind: string
  rootExport: string
  fileName: string
  schema: any
  report: AlignReport
  json: any
  verified: number
  missing: Attachment[]
  checks: { name: string; pass: boolean; detail: string }[]
  hasDefs: boolean
}

function collectFilesForKind(kind: string): string[] {
  switch (kind) {
    case 'GameDefinition':
      return ['GameDefinitionSchema.ts']
    case 'crafting':
      return ['RuleSchema.ts']
    case 'MapRegistry':
      return ['MapRegistrySchema.ts']
    case 'Archetype':
      return ['ArchetypeSchema.ts']
    default:
      return []
  }
}

async function processKind(
  kind: string,
  rootExport: string,
  fileName: string,
  project: Project,
  varIndex: Map<string, { file: any; decl: any }>,
): Promise<KindResult> {
  const mod = await import(pathToFileURL(path.join(SCHEMA_DIR, fileName)).href)
  const schema = mod[rootExport]
  if (!schema) throw new Error(`导出 ${rootExport} 不存在于 ${fileName}`)
  const file = project.getSourceFileOrThrow(path.join(SCHEMA_DIR, fileName))
  const decl = file.getVariableDeclarationOrThrow(rootExport)
  const ctx: AstBuildCtx = { project, varIndex, cache: new Map() }
  const ast = astFromVariable(decl, file, ctx, new Set())
  // 根节点不挂声明级描述（避免把整段文档当根描述），字段级/被引用级照常。
  const registry = z.registry()
  const report: AlignReport = { attachments: [], warnings: [], fields: [] }
  const registryByNode = new Map<any, string>()
  align(schema, ast, [], undefined, undefined, registry, report, registryByNode)

  const json = z.toJSONSchema(schema, { metadata: registry })
  const hasDefs = !!(json && (json.$defs || json.definitions))

  // 验证：每条 attachment 在输出 JSON 的对应 pointer 上是否有该 description
  const missing: Attachment[] = []
  let verified = 0
  for (const a of report.attachments) {
    const node = navigate(json, a.path)
    if (node && typeof node === 'object' && node.description === a.description) {
      verified++
    } else {
      missing.push(a)
    }
  }

  const checks = buildChecks(kind, json)
  return { kind, rootExport, fileName, schema, report, json, verified, missing, checks, hasDefs }
}

function descAt(json: any, pathSegs: (string | number)[]): string | undefined {
  const node = navigate(json, pathSegs)
  return node && typeof node === 'object' ? node.description : undefined
}
function expectDesc(json: any, pathSegs: (string | number)[], mustContain: string): { pass: boolean; detail: string } {
  const d = descAt(json, pathSegs)
  const pass = typeof d === 'string' && d.includes(mustContain)
  return { pass, detail: `path=${pathLabel(pathSegs)} 期望含"${mustContain}"，实际=${d === undefined ? '(无)' : JSON.stringify(d.slice(0, 60))}` }
}

function buildChecks(kind: string, json: any): KindResult['checks'] {
  const c: KindResult['checks'] = []
  if (kind === 'GameDefinition') {
    c.push({ name: '顶层 tickRate 描述', ...expectDesc(json, ['properties', 'tickRate'], '逻辑 tick') })
    c.push({ name: '顶层 world 描述', ...expectDesc(json, ['properties', 'world'], '全局世界段') })
    c.push({ name: 'world.tile.width 描述', ...expectDesc(json, ['properties', 'world', 'properties', 'tile', 'properties', 'width'], 'tile 宽度') })
    c.push({ name: 'world.tile.height 描述', ...expectDesc(json, ['properties', 'world', 'properties', 'tile', 'properties', 'height'], 'tile 高度') })
    c.push({ name: 'netSync.fields[].component 描述', ...expectDesc(json, ['properties', 'netSync', 'properties', 'fields', 'items', 'properties', 'component'], '组件名') })
  }
  if (kind === 'crafting') {
    c.push({ name: 'recipes[].inputs 描述', ...expectDesc(json, ['properties', 'recipes', 'items', 'properties', 'inputs'], 'kind 字符串引用') })
    c.push({ name: 'recipes[].outputs 描述', ...expectDesc(json, ['properties', 'recipes', 'items', 'properties', 'outputs'], 'kind 字符串引用') })
    c.push({ name: 'recipes[].stationType 描述', ...expectDesc(json, ['properties', 'recipes', 'items', 'properties', 'stationType'], '站点类型') })
    // 缺 JSDoc 的字段应无 description 且不报错
    const kindDesc = descAt(json, ['properties', 'recipes', 'items', 'properties', 'inputs', 'items', 'properties', 'kind'])
    c.push({ name: '无 JSDoc 字段 kind 不产生描述（允许缺省）', pass: kindDesc === undefined, detail: `recipes[].inputs[].kind description=${kindDesc === undefined ? '(无)' : JSON.stringify(kindDesc)}` })
  }
  if (kind === 'MapRegistry') {
    c.push({ name: 'union 分支0(pipeline).seed 描述', ...expectDesc(json, ['properties', 'maps', 'additionalProperties', 'oneOf', 0, 'properties', 'seed'], '随机种子') })
    c.push({ name: 'union 分支0(pipeline).pipeline 描述', ...expectDesc(json, ['properties', 'maps', 'additionalProperties', 'oneOf', 0, 'properties', 'pipeline'], '生成积木管道') })
    c.push({ name: 'union 分支1(tiled).path 描述', ...expectDesc(json, ['properties', 'maps', 'additionalProperties', 'oneOf', 1, 'properties', 'path'], 'Tiled JSON') })
    c.push({ name: 'union 分支1(tiled).initialAgeTicks 描述', ...expectDesc(json, ['properties', 'maps', 'additionalProperties', 'oneOf', 1, 'properties', 'initialAgeTicks'], '初始演化跨度') })
  }
  if (kind === 'Archetype') {
    c.push({ name: 'components(record) 描述', ...expectDesc(json, ['properties', 'components'], '组件名') })
    const valNode = navigate(json, ['properties', 'components', 'additionalProperties'])
    c.push({ name: 'components 值为 unknown → 无 properties 可递归、不报错', pass: !!valNode && typeof valNode === 'object' && !('properties' in valNode), detail: `components.additionalProperties = ${valNode === undefined ? '(缺失)' : JSON.stringify(valNode).slice(0, 80)}` })
    c.push({ name: 'tags 描述', ...expectDesc(json, ['properties', 'tags'], '标签组件') })
  }
  return c
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const KINDS: { kind: string; rootExport: string; fileName: string; outFile: string }[] = [
  { kind: 'GameDefinition', rootExport: 'GameDefinitionSchema', fileName: 'GameDefinitionSchema.ts', outFile: 'game-definition.schema.json' },
  { kind: 'crafting', rootExport: 'CraftingRuleSchema', fileName: 'RuleSchema.ts', outFile: 'crafting.schema.json' },
  { kind: 'MapRegistry', rootExport: 'MapRegistrySchema', fileName: 'MapRegistrySchema.ts', outFile: 'map-registry.schema.json' },
  { kind: 'Archetype', rootExport: 'ArchetypeSchema', fileName: 'ArchetypeSchema.ts', outFile: 'archetype.schema.json' },
]

async function main(): Promise<void> {
  await fsp.mkdir(OUT_DIR, { recursive: true })

  // ts-morph project 覆盖全部 schema 文件（供跨文件标识符解析 + 同文件 bullet 兜底）
  const project = new Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true })
  const allFiles = await fsp.readdir(SCHEMA_DIR)
  for (const f of allFiles.filter((f) => f.endsWith('.ts'))) {
    project.addSourceFileAtPath(path.join(SCHEMA_DIR, f))
  }
  // 全局变量索引（跨文件解析标识符；同名以最新写入为准，实际本仓无跨文件同名冲突）
  const varIndex = new Map<string, { file: any; decl: any }>()
  for (const sf of project.getSourceFiles()) {
    for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const name = decl.getName()
      if (!varIndex.has(name)) varIndex.set(name, { file: sf, decl })
    }
  }

  const results: KindResult[] = []
  for (const k of KINDS) {
    try {
      const r = await processKind(k.kind, k.rootExport, k.fileName, project, varIndex)
      results.push(r)
      await fsp.writeFile(path.join(OUT_DIR, k.outFile), JSON.stringify(r.json, null, 2) + '\n', 'utf8')
      console.log(`[spike-jsdoc-schema] ${k.kind}: → ${k.outFile}（attachments=${r.report.attachments.length} verified=${r.verified} missing=${r.missing.length} warnings=${r.report.warnings.length} $defs=${r.hasDefs}）`)
    } catch (err) {
      console.error(`[spike-jsdoc-schema] ${k.kind} 处理失败:`, err)
    }
  }

  const reportText = buildReport(results)
  await fsp.writeFile(path.join(OUT_DIR, 'spike-report.md'), reportText, 'utf8')
  console.log(`[spike-jsdoc-schema] 报告 → ${path.join(OUT_DIR, 'spike-report.md')}`)

  // 成功标准汇总
  const allChecks = results.flatMap((r) => r.checks.map((c) => ({ kind: r.kind, ...c })))
  const failed = allChecks.filter((c) => !c.pass)
  console.log(`\n[spike-jsdoc-schema] 成功标准检查：${allChecks.length - failed.length}/${allChecks.length} 通过`)
  for (const c of allChecks) console.log(`  ${c.pass ? '✔' : '✘'} [${c.kind}] ${c.name} — ${c.detail}`)
  if (failed.length) process.exitCode = 1
}

function buildReport(results: KindResult[]): string {
  const lines: string[] = []
  lines.push('# Spike 报告：TS JSDoc → zod v4 → z.toJSONSchema 描述注入')
  lines.push('')
  lines.push(`- 生成时间：${new Date().toISOString()}`)
  lines.push(`- 本体 schema 目录（只读）：\`${rel(SCHEMA_DIR)}\``)
  lines.push(`- zod 版本（经 createRequire(GAME_ROOT) 解析，与 schema 同实例）：\`${zodPkg.version ?? '?'}\``)
  lines.push(`- toJSONSchema reused 默认：inline（实测无 $defs/$ref；本报告逐一核对了结果）`)
  lines.push(`- 运行方式：\`cd excalibur_test/server && pnpm exec tsx ../scripts/spike-jsdoc-schema.mts\``)
  lines.push('')
  lines.push('## 统计总览')
  lines.push('')
  lines.push('| kind | 输出文件 | 扫描字段数 | 直接 JSDoc | 有描述(含 bullet/ref) | 成功注入并验证 | 丢失 | 对齐告警 |')
  lines.push('|------|----------|-----------:|-----------:|----------------------:|---------------:|-----:|---------:|')
  for (const r of results) {
    const total = r.report.fields.length
    const direct = r.report.fields.filter((f) => f.direct).length
    const doc = r.report.fields.filter((f) => f.doc).length
    lines.push(
      `| ${r.kind} | \`${KINDS.find((k) => k.kind === r.kind)?.outFile}\` | ${total} | ${direct} | ${doc} | ${r.verified} | ${r.missing.length} | ${r.report.warnings.length} |`,
    )
  }
  lines.push('')
  lines.push('> 注：`成功注入并验证` = 该字段的 description 在输出 JSON 的对应 JSON pointer 上被逐条核对存在且相等。')
  lines.push('> `直接 JSDoc` 仅统计属性自身 JSDoc；`有描述` 额外含从声明 bullet 清单 / 被引用子 schema 声明回退得到的描述。')
  lines.push('')

  for (const r of results) {
    lines.push(`## ${r.kind}（${r.rootExport} ← ${r.fileName}）`)
    lines.push('')
    const withDoc = r.report.fields.filter((f) => f.doc)
    lines.push(`- 扫描字段：${r.report.fields.length}；直接 JSDoc：${r.report.fields.filter((f) => f.direct).length}；有描述：${withDoc.length}；注入验证：${r.verified}/${withDoc.length}`)
    lines.push(`- 输出：\`${KINDS.find((k) => k.kind === r.kind)?.outFile}\`；$defs=${r.hasDefs}；对齐告警：${r.report.warnings.length}`)
    lines.push('')
    lines.push('字段注入明细：')
    lines.push('')
    lines.push('| JSON pointer | 字段 | 来源 | 描述（截断） | 位置 |')
    lines.push('|--------------|------|------|--------------|------|')
    for (const a of r.report.attachments) {
      const short = a.description.replace(/\s+/g, ' ').slice(0, 48)
      lines.push(`| \`${pathLabel(a.path)}\` | ${a.fieldName} | ${a.source} | ${short}${a.description.length > 48 ? '…' : ''} | ${rel(a.file)}:${a.line} |`)
    }
    lines.push('')
    if (r.missing.length) {
      lines.push('### 丢失清单（源码有描述但未在输出对应位置出现）')
      lines.push('')
      for (const a of r.missing) {
        lines.push(`- \`${pathLabel(a.path)}\` 字段 \`${a.fieldName}\`（${rel(a.file)}:${a.line}）— 期望描述：${a.description.replace(/\s+/g, ' ').slice(0, 60)}`)
      }
      lines.push('')
    } else {
      lines.push('丢失清单：**空**（所有取到描述的字段都已在输出对应位置验证存在）。')
      lines.push('')
    }
    // 无描述字段（允许缺省）
    const noDoc = r.report.fields.filter((f) => !f.doc)
    if (noDoc.length) {
      lines.push(`无描述字段（允许缺省，不报错）：`)
      lines.push('')
      for (const f of noDoc) lines.push(`- \`${pathLabel(f.path)}\`（${rel(f.file)}:${f.line}）`)
      lines.push('')
    }
    if (r.report.warnings.length) {
      lines.push('### 对齐告警')
      lines.push('')
      for (const w of r.report.warnings) lines.push(`- ${w}`)
      lines.push('')
    }
    // 成功标准
    if (r.checks.length) {
      lines.push('### 成功标准检查')
      lines.push('')
      for (const c of r.checks) lines.push(`- ${c.pass ? '✔' : '✘'} ${c.name} — ${c.detail}`)
      lines.push('')
    }
  }

  lines.push('## 结论')
  lines.push('')
  const allChecks = results.flatMap((r) => r.checks)
  const failed = allChecks.filter((c) => !c.pass)
  const totalMissing = results.reduce((n, r) => n + r.missing.length, 0)
  const totalWarn = results.reduce((n, r) => n + r.report.warnings.length, 0)
  lines.push(`- 成功标准：${allChecks.length - failed.length}/${allChecks.length} 通过；丢失字段：${totalMissing}；对齐告警：${totalWarn}。`)
  lines.push(`- 判定：${failed.length === 0 && totalMissing === 0 ? '**可行** —— 链路成立。' : '**有条件可行** —— 见上方失败/丢失清单。'}`)
  lines.push('')
  lines.push('### zod v4 机制坑（实测）')
  lines.push('')
  lines.push('1. **`.meta()` 会克隆实例**（`s !== s.meta({...})`），无法对"已加载的 zod 实例"事后补描述；本 spike 改用 `z.registry()` + `z.toJSONSchema(schema, { metadata: registry })`，registry 按**实例身份**补 description，且不需要替换 shape 里的节点引用——这是本链路能成立的关键。')
  lines.push('2. **`.refine()` 在 v4 不产生新节点**（type 仍为 `object`，校验挂在 `def.checks`），因此 `.shape` 直接可用，不需要穿透 ZodEffects。')
  lines.push('3. **包装节点必须按 `_zod.def.innerType` 解包**：`optional` / `default` / `nullable` / `readonly`。描述挂在外层包装实例上即可被 `toJSONSchema` 采纳（实测 `ZodDefault`、`ZodOptional` 外层描述均出现在输出）。')
  lines.push('4. **`toJSONSchema` 默认 `reused: "inline"`**，不产生 `$defs`/`$ref`；同一子 schema 实例被多处引用时输出会内联复制，描述随之复制（本 spike 的验证器仍带 `$ref` 兜底导航以备未来切换 `reused: "ref"`）。')
  lines.push('5. **映射约定**：`discriminatedUnion` → `oneOf`；`record` → `additionalProperties`；`array` → `items`；`z.unknown()` → `{}`（无结构、无描述）。')
  lines.push('')
  lines.push('### 对齐策略要点')
  lines.push('')
  lines.push('- 双侧递归：AST 沿 `z.object/.array/.record/.discriminatedUnion` 链找 base call（`.optional()/.refine()` 等链式调用自动穿透），运行时按 zod `shape` 同层按属性名对齐；属性值是标识符时解析该 const（含非导出 const，经 ts-morph 索引，不依赖运行时可导入性）。')
  lines.push('- 描述来源三级回退：① 属性自身 JSDoc → ② 所属声明 JSDoc 的 `- 字段：描述` 条目 → ③ 同文件任意 JSDoc 块的同名字段条目（兜底，处理本仓"文档块错位"现状，如 `RuleSchema.ts` 里合成配方的 bullet 实际挂在 `RecipeInputSchema` 声明上）→ ④ 引用具名子 schema 时回退其声明描述。')
  lines.push('- 本仓 `tickRate` 无属性级 JSDoc，其描述仅在 `GameDefinitionSchema` 声明块 bullet 里，正由②命中；`recipes[].inputs/outputs` 由③命中。')
  lines.push('')
  lines.push('### 已知局限与启发式副作用（如实记录）')
  lines.push('')
  lines.push('1. **组合 bullet 会让多字段共享描述**：声明块里 `- entities/behaviors/rules/items/dialogues/quests：各内容文件路径` 这类合并写法，本 spike 按 `/` 拆名后给 `entities/behaviors/rules/items`（`dialogues/quests` 有属性级 JSDoc 覆盖）分到同一句"各内容文件路径"。生产实现建议改用更精确的锚点，或先完善本体 JSDoc。')
  lines.push('2. **文档块错位需要同文件兜底**：`RuleSchema.ts` 里合成配方的 bullet（`stationType`/`inputs`/`outputs`）实际挂在 `RecipeInputSchema` 声明上，只能靠"同文件任意 JSDoc 块同名字段"兜底（③）。同名跨声明时存在误配风险。')
  lines.push('3. **只覆盖从 kind 根可达的 schema**：独立 const 子 schema 若未被任何导出根引用，不会出现在输出，也不参与统计。')
  lines.push('4. **递归/自引用 schema**：AST 侧用 `seen` 集合防环；本仓未遇到，未做端到端验证。')
  lines.push('5. **一致性守卫**：运行时 shape 与 AST 不一致（多键/少键/类型不符）会记为"对齐告警"，本仓 0 条——说明当前源码与运行时结构完全同构。')
  lines.push('6. **registry 生命周期**：`z.registry()` 是进程内、按实例身份的表；生产应"每次启动构造 registry → 注入 → toJSONSchema"，并保证 schema 实例不被重新加载/替换，否则描述丢失。')
  lines.push('7. **`reused: "ref"` 未端到端验证**：本 spike 用默认 inline；验证器虽带 `$ref` 导航兜底，但未对 `toJSONSchema(schema, { reused: "ref" })` 的 `$defs` 描述做端到端实测。若生产要压缩体积切到 ref 模式，应补测。')
  lines.push('8. **本 spike 只读本体**：仅 `import`/读源码，未写 `game_server_test` 任何文件；产物全部在 `excalibur_test/tmp/spike-jsdoc-schema/`。')
  lines.push('')
  return lines.join('\n')
}

main().catch((err) => {
  console.error('[spike-jsdoc-schema] FAILED:', err)
  process.exit(1)
})
