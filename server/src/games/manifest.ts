/**
 * game manifest —— server/games/<id>/game.json 的 zod schema 与默认值探测（T2.2）。
 *
 * manifest 是"游戏接入契约"的数据表达：T2.5 导入流用 probeManifest(checkoutDir)
 * 生成默认 manifest，T2.3 GameContext 工厂用 manifest（+ registry entry）合成
 * per-game 上下文，T2.10 游戏详情页编辑高级字段后经 PATCH 走同一 schema 校验。
 *
 * 设计要点：
 * - 路径字段一律为相对 checkout 游戏根的相对路径（'/' 分隔），manifest 才能
 *   跨 checkout 位置移植（git 源锚 server/games/<id>/checkout/，local 源锚外部目录）。
 * - schemaRoutes 默认值**直接引用** defaultGameContext.schemaRoutes（T1.4 抽出的
 *   8 条路由数据），不复制一份数据防漂移；第二款游戏接入时手工改这份默认值——
 *   这就是契约的"考试点"（规格 T2.2）。
 * - capabilities 探测锚点是 framework/index.ts（缺失即硬错误，与 T2.5 local 源
 *   导入的服务端校验同一条硬线）。
 * - observer.plugin 无现状对照值（P3 插件化才产生目录语义），'excalibur-colyseus'
 *   为唯一设定值。
 * - .env 的 PORT 只提示、不覆盖端口池分配（T2.1 registry entry 的 ports 为准）。
 * - 校验失败一律以 { path, message }[] 表达（§0.2 zod issue 形状），供 REST 422。
 */
import fs from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { defaultGameContext } from '../gameContext.js'

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

/** 相对路径字段：'/' 分隔、非绝对、无 '~' 展开、无 '\\'（win32 分隔符，Q7 linux-only）。 */
const relativePath = z
  .string()
  .min(1)
  .refine(
    (v) => !path.isAbsolute(v) && !v.startsWith('~') && !v.includes('\\'),
    { message: "必须为 '/' 分隔的相对路径（相对 checkout 游戏根）" },
  )

/**
 * schemaRoutes[].pattern：完整锚定的正则源串。解析期即验证可编译，
 * 防止坏 pattern 在 configService.routeSchemaKind 运行期 new RegExp 时炸裂。
 */
const regexSource = z
  .string()
  .min(1)
  .refine(
    (src) => {
      try {
        new RegExp(src)
        return true
      } catch {
        return false
      }
    },
    { message: '必须为可编译的正则源串（完整锚定，如 ^game\\.json$）' },
  )

/**
 * manifest schema。strictObject：未知键报错（防手改 manifest 时字段名拼写错误
 * 被静默丢弃）。字段语义注释与 gameContext.ts 的 GameContext 一一对应。
 */
export const gameManifestSchema = z.strictObject({
  /** 游戏标识：与 registry entry、REST /api/games/:gameId 的 :gameId 一致；字符集同 WS 频道名白名单 [\w-]。 */
  id: z.string().regex(/^[\w-]+$/, { message: '只允许字母/数字/下划线/连字符' }),
  /** 配置目录（默认 'game'，S2-A 工作区镜像源）。 */
  configDir: relativePath,
  /** 配置入口文件（相对 configDir，默认 'game.json'；整体校验的目标）。 */
  configEntry: relativePath,
  /** official 存档目录（默认 'data/saves'）。 */
  savesDir: relativePath,
  /** 游戏日志目录（默认 'logs'；gameLogFile 派生为 <logsDir>/game.log）。 */
  logsDir: relativePath,
  /** 游戏环境文件（默认 '.env'，official 展示端口解析链读取其 PORT）。 */
  envFile: relativePath,
  /** 游戏实例启动命令（win32 下 pnpm→pnpm.cmd 的平台适配留在消费方）。 */
  start: z.strictObject({ command: z.string().min(1), args: z.array(z.string()) }),
  /** preview 实例注入的环境变量**名**（值由消费方在 spawn 前动态解析）。 */
  envInjection: z.strictObject({
    port: z.string().min(1),
    configPath: z.string().min(1),
    saveDir: z.string().min(1),
  }),
  /** 配置文件 schema 路由表（routeSchemaKind 的数据源；kind '*' = 文件名去 .json 语义）。 */
  schemaRoutes: z.array(z.strictObject({ pattern: regexSource, kind: z.string().min(1) })),
  /** sidecar 能力开关（探测锚点 framework/index.ts，存在即全开）。 */
  capabilities: z.strictObject({
    wholeConfigValidation: z.boolean(),
    mapGeometry: z.boolean(),
    registries: z.array(z.string().min(1)),
  }),
  /** 观察端挂点（web 插件契约位，P3 启用）。 */
  observer: z.strictObject({
    plugin: z.string().min(1),
    roomName: z.string().min(1),
    clientSchema: z.strictObject({ source: relativePath, stateDir: relativePath }).optional(),
  }),
  /** T2.5：导入自动 pnpm install 是否允许跑 scripts 的白名单开关（Q6，缺省 false）。 */
  trustScripts: z.boolean().optional(),
})

export type GameManifest = z.infer<typeof gameManifestSchema>

// ---------------------------------------------------------------------------
// 校验（REST 422 用）
// ---------------------------------------------------------------------------

/** §0.2 zod issue 形状：path 只留 string|number（zod 4 实测只产生这两类）。 */
export interface ManifestIssue {
  path: (string | number)[]
  message: string
}

function toManifestIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): ManifestIssue[] {
  return issues.map((issue) => ({
    path: issue.path.filter(
      (p): p is string | number => typeof p === 'string' || typeof p === 'number',
    ),
    message: issue.message,
  }))
}

export type ManifestValidationResult =
  | { ok: true; manifest: GameManifest }
  | { ok: false; issues: ManifestIssue[] }

/** 校验 manifest 数据；失败返回带字段路径的 issues（§0.2 形状，供 REST 422）。 */
export function validateManifest(input: unknown): ManifestValidationResult {
  const parsed = gameManifestSchema.safeParse(input)
  if (parsed.success) return { ok: true, manifest: parsed.data }
  return { ok: false, issues: toManifestIssues(parsed.error.issues) }
}

/** issues → 单行文案（REST 422 的 message 用）。 */
export function formatManifestIssues(issues: ManifestIssue[]): string {
  return issues
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ')
}

/** 校验失败的可抛异常（issues 随行，调用方 catch 后映射 422）。 */
export class ManifestValidationError extends Error {
  readonly issues: ManifestIssue[]
  constructor(issues: ManifestIssue[]) {
    super(formatManifestIssues(issues))
    this.name = 'ManifestValidationError'
    this.issues = issues
  }
}

/** 校验并失败即抛（assert 风格便捷层）。 */
export function assertManifest(input: unknown): GameManifest {
  const result = validateManifest(input)
  if (!result.ok) throw new ManifestValidationError(result.issues)
  return result.manifest
}

// ---------------------------------------------------------------------------
// 默认值探测
// ---------------------------------------------------------------------------

/**
 * capabilities.registries 默认值：五类注册表，与 sidecar listRegistries 返回的
 * ListRegistriesResult 键一致（server/src/sidecar/protocol.ts）。
 */
const DEFAULT_CAPABILITY_REGISTRIES = [
  'systems',
  'archetypes',
  'actions',
  'components',
  'mapGenerators',
] as const

/** observer.plugin 默认值：现状无对照值（P3 插件化才产生目录语义），唯一设定值。 */
const DEFAULT_OBSERVER_PLUGIN = 'excalibur-colyseus'

const DEFAULT_CONFIG_DIR = 'game'
const DEFAULT_CONFIG_ENTRY = 'game.json'
const DEFAULT_SAVES_DIR = 'data/saves'
const DEFAULT_LOGS_DIR = 'logs'
const DEFAULT_ENV_FILE = '.env'

/** 未提供 id 时由 checkout 目录名推导兜底（T2.5 导入流应显式传入 registry id）。 */
function deriveIdFromDir(checkoutDir: string): string {
  const base = path
    .basename(checkoutDir)
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base.length > 0 ? base : 'game'
}

/** 读 .env 的 PORT（与 gameContext.readGameEnvPort 同语义；那边未导出，就地实现）。 */
function readEnvPort(envFile: string): number | undefined {
  try {
    const m = /^PORT\s*=\s*(\d+)\s*(?:#.*)?$/m.exec(fs.readFileSync(envFile, 'utf8'))
    return m ? Number(m[1]) : undefined
  } catch {
    return undefined
  }
}

export interface ProbeOptions {
  /** 游戏标识；缺省时由 checkout 目录名推导（导入流 T2.5 应显式传入）。 */
  id?: string
}

export type ProbeResult =
  | { ok: true; manifest: GameManifest; notes: string[] }
  | { ok: false; errors: ManifestIssue[]; notes: string[] }

/**
 * 按 checkout 实况探测 manifest 默认值（规格 T2.2 的四条探测规则 + 完整默认填充）：
 *
 * - 存在 game/game.json → configDir='game' / configEntry='game.json'（硬锚点，
 *   缺失即失败——配置目录是本平台一切功能的镜像源）；
 * - package.json scripts 有 dev → start 默认 pnpm dev（缺失/无 dev 保留默认并提示）；
 * - 存在 framework/index.ts → capabilities 全开（硬锚点，缺失即失败）；
 * - .env 有 PORT → 提示但**不覆盖**端口池分配（T2.1 registry ports 为准）。
 * - schemaRoutes / envInjection / roomName 默认值取自 defaultGameContext（不复制数据防漂移）。
 *
 * 返回的 manifest 已过 gameManifestSchema 自校验：ok:true 即 schema 合法。
 * errors 携带具体缺失项与字段路径（供 T2.5 REST 422）。
 */
export function probeManifest(checkoutDir: string, options: ProbeOptions = {}): ProbeResult {
  const notes: string[] = []
  const root = path.resolve(checkoutDir)

  let dirStat: fs.Stats | undefined
  try {
    dirStat = fs.statSync(root)
  } catch {
    dirStat = undefined
  }
  if (!dirStat?.isDirectory()) {
    return {
      ok: false,
      notes,
      errors: [{ path: [], message: `checkout 目录不存在或不是目录：${root}` }],
    }
  }

  const errors: ManifestIssue[] = []

  // 硬锚点 1：game/game.json —— configDir/configEntry 的唯一探测源
  const gameJsonPath = path.join(root, DEFAULT_CONFIG_DIR, DEFAULT_CONFIG_ENTRY)
  if (!fs.existsSync(gameJsonPath)) {
    errors.push({
      path: ['configDir'],
      message: `缺少 ${DEFAULT_CONFIG_DIR}/${DEFAULT_CONFIG_ENTRY}（configDir/configEntry 无法确定）：${gameJsonPath}`,
    })
  }

  // 硬锚点 2：framework/index.ts —— capabilities 探测锚点；缺失则 sidecar 冒烟必失败
  const frameworkIndexPath = path.join(root, 'framework', 'index.ts')
  const hasFramework = fs.existsSync(frameworkIndexPath)
  if (!hasFramework) {
    errors.push({
      path: ['capabilities'],
      message: `缺少 framework/index.ts（sidecar 能力不可用，导入冒烟必失败）：${frameworkIndexPath}`,
    })
  }

  // start：package.json scripts.dev 存在 → 默认 pnpm dev；否则保留默认值并提示核对
  const start = { command: 'pnpm', args: ['dev'] }
  let hasDevScript: boolean | undefined
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: { dev?: unknown }
    }
    hasDevScript = typeof pkg.scripts?.dev === 'string'
  } catch {
    hasDevScript = undefined
  }
  if (hasDevScript === false) {
    notes.push('package.json 存在但 scripts 无 dev：start 保留默认 pnpm dev，请在 manifest 手工核对修改')
  } else if (hasDevScript === undefined) {
    notes.push('package.json 缺失或不可解析：start 保留默认 pnpm dev')
  }

  // .env 有 PORT：仅提示，不覆盖端口池分配（T2.1 registry entry 的 ports 为准）
  const envPort = readEnvPort(path.join(root, DEFAULT_ENV_FILE))
  if (envPort !== undefined) {
    notes.push(
      `.env 检测到 PORT=${envPort}：仅提示，不覆盖端口池分配（端口以 registry entry 的 ports 为准）`,
    )
  }

  notes.push(
    'schemaRoutes 为默认值（引用 defaultGameContext.schemaRoutes 的 8 条路由）：' +
      '第二款游戏接入时必须手工核对修改——契约考试点（规格 T2.2）',
  )

  if (errors.length > 0) return { ok: false, errors, notes }

  const draft = {
    id: options.id ?? deriveIdFromDir(root),
    configDir: DEFAULT_CONFIG_DIR,
    configEntry: DEFAULT_CONFIG_ENTRY,
    savesDir: DEFAULT_SAVES_DIR,
    logsDir: DEFAULT_LOGS_DIR,
    envFile: DEFAULT_ENV_FILE,
    start,
    envInjection: { ...defaultGameContext.envInjection },
    schemaRoutes: defaultGameContext.schemaRoutes.map((route) => ({ ...route })),
    capabilities: {
      wholeConfigValidation: hasFramework,
      mapGeometry: hasFramework,
      registries: [...DEFAULT_CAPABILITY_REGISTRIES],
    },
    observer: { plugin: DEFAULT_OBSERVER_PLUGIN, roomName: defaultGameContext.roomName },
  }

  const validated = validateManifest(draft)
  if (!validated.ok) return { ok: false, errors: validated.issues, notes }
  return { ok: true, manifest: validated.manifest, notes }
}
