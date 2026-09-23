/**
 * games registry —— server/games/registry.json 的读写层 + 端口池分配器（T2.1）。
 *
 * 职责：
 * - registry.json 整文件读写：写时同目录临时文件 + rename 原子替换（防半写，
 *   读者永远看不到半文件；最后写者整文件获胜）；
 * - 进程内缓存 + mtime/size 失效（外部改动下次读取即生效）；
 * - 端口池：official 3000-3199、preview 3200-3399，first-fit；纯函数
 *   allocatePorts 负责选端口，"分配即持久化"由 upsertGame 完成其一；
 * - ensureSeeded()：registry.json 不存在时用 defaultGameContext 播种 'gst'
 *   entry（保证 Phase 1 → Phase 2 升级后无 registry 也能起；server 启动时
 *   在 index.ts 调用一次）。
 *
 * 约定（docs/multi-game-plan.md §4 T2.1 / §6 Q1/Q2/Q5）：
 * - registry.json 是运行时状态，gitignore（Q1，与 workspaces/backups 同待遇）；
 * - gst 用 local 源（Q2）：path 存**相对平台仓库根**的路径（'../game_server_test'
 *   形态），绝对路径原样存储；resolveLocalGamePath 负责锚定回绝对路径；
 * - 默认游戏 id = 'gst'（Q5），"默认"语义用 entry.isDefault 表达（全表至多
 *   一个 true，upsertGame 写入时强制单例）。
 *
 * 播种 entry 的 resolved 三字段（commit/syncedAt/lockfileHash）置空串表示
 * "尚未同步"，由 T2.5 的 sync/探测流程回填；ports 原样继承
 * defaultGameContext.ports 的现状值（不走端口池、不做段校验——避免与线上
 * 实况漂移，端口池只服务"新分配"）。
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defaultGameContext } from '../gameContext.js'

// ---------------------------------------------------------------------------
// 常量与路径
// ---------------------------------------------------------------------------

/** 平台仓库根（excalibur_test）：由本模块位置（server/src/games/）上溯三层定位。 */
const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))

/**
 * registry.json 默认路径。GAMES_REGISTRY_PATH 环境变量可覆盖（部署/测试注入用，
 * 显式 options.registryPath 参数优先于本值）。
 */
export const DEFAULT_REGISTRY_PATH =
  process.env.GAMES_REGISTRY_PATH ?? path.join(repoRoot, 'server', 'games', 'registry.json')

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** git 源：T2.5 导入流 clone 到 server/games/<id>/checkout/。 */
export interface GitGameSource {
  type: 'git'
  url: string
  ref: string
}

/** local 源：path 相对平台仓库根锚定（resolveLocalGamePath），也可为绝对路径。 */
export interface LocalGameSource {
  type: 'local'
  path: string
}

export type GameSource = GitGameSource | LocalGameSource

/** 同步状态指纹：空串 = 尚未同步/未知（T2.5 回填）。 */
export interface GameResolved {
  /** 最近一次同步的 commit（git 源）或 gameRoot 的 git HEAD（local 源）。 */
  commit: string
  /** 最近一次同步时间（ISO 8601）。 */
  syncedAt: string
  /** pnpm-lock.yaml 的 sha256（T2.5 计算）。 */
  lockfileHash: string
}

/** registry.json 中单个游戏的 entry（形状见 docs/multi-game-plan.md §4 T2.1）。 */
export interface GameRegistryEntry {
  /** 展示名（游戏管理 UI 用；PATCH 可改）。 */
  name: string
  /** "默认游戏"标志（Q5：与 id 解耦；全表至多一个 true）。 */
  isDefault: boolean
  source: GameSource
  resolved: GameResolved
  ports: { official: number; preview: number }
  /** entry 创建时间（ISO 8601）。 */
  createdAt: string
}

/** registry.json 顶层结构。 */
export interface RegistryFile {
  games: Record<string, GameRegistryEntry>
}

/** upsert 输入：ports 可省略（省略 = 端口池 first-fit 自动分配并持久化）。 */
export type GameRegistryEntryInput = Omit<GameRegistryEntry, 'ports'> & {
  ports?: GameRegistryEntry['ports']
}

/** 可注入 registry 路径（测试用 /tmp 路径，避免污染真实 server/games/）。 */
export interface RegistryOptions {
  registryPath?: string
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** registry 域错误；code 供 T2.7 REST 层映射状态码。 */
export class RegistryError extends Error {
  constructor(
    readonly code:
      | 'registry_corrupt'
      | 'registry_read_error'
      | 'registry_write_error'
      | 'bad_game_id'
      | 'ports_exhausted'
      | 'ports_out_of_range',
    message: string,
  ) {
    super(message)
    this.name = 'RegistryError'
  }
}

// ---------------------------------------------------------------------------
// 形状校验（server 依赖里没有 zod，手写最小校验；错误信息带具体字段路径）
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function corruptError(file: string, detail: string): RegistryError {
  return new RegistryError('registry_corrupt', `registry.json 形状非法（${file}）：${detail}`)
}

function assertValidGameId(id: string): void {
  // id 会进文件系统路径（server/games/<id>/），只允许 \w 与 '-'
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id) || id.length > 64) {
    throw new RegistryError('bad_game_id', `非法 gameId：${JSON.stringify(id)}（需匹配 /^[\\w-]+$/ 且长度 ≤ 64）`)
  }
}

/** 校验并归一化单个 entry（丢弃多余字段）；形状不符抛 registry_corrupt。 */
function validateEntry(id: string, value: unknown, file: string): GameRegistryEntry {
  if (!isRecord(value)) throw corruptError(file, `games[${id}] 不是对象`)
  const { name, isDefault, source, resolved, ports, createdAt } = value
  if (typeof name !== 'string' || name.length === 0) throw corruptError(file, `games[${id}].name 需为非空字符串`)
  if (typeof isDefault !== 'boolean') throw corruptError(file, `games[${id}].isDefault 需为 boolean`)

  if (!isRecord(source)) throw corruptError(file, `games[${id}].source 不是对象`)
  let normalizedSource: GameSource
  switch (source.type) {
    case 'git':
      if (typeof source.url !== 'string' || source.url.length === 0 || typeof source.ref !== 'string') {
        throw corruptError(file, `games[${id}].source.url/ref 需为非空字符串`)
      }
      normalizedSource = { type: 'git', url: source.url, ref: source.ref }
      break
    case 'local':
      if (typeof source.path !== 'string' || source.path.length === 0) {
        throw corruptError(file, `games[${id}].source.path 需为非空字符串`)
      }
      normalizedSource = { type: 'local', path: source.path }
      break
    default:
      throw corruptError(file, `games[${id}].source.type 需为 'git' | 'local'`)
  }

  if (
    !isRecord(resolved) ||
    typeof resolved.commit !== 'string' ||
    typeof resolved.syncedAt !== 'string' ||
    typeof resolved.lockfileHash !== 'string'
  ) {
    throw corruptError(file, `games[${id}].resolved { commit, syncedAt, lockfileHash } 需全为字符串`)
  }
  if (
    !isRecord(ports) ||
    typeof ports.official !== 'number' ||
    !Number.isInteger(ports.official) ||
    typeof ports.preview !== 'number' ||
    !Number.isInteger(ports.preview)
  ) {
    throw corruptError(file, `games[${id}].ports.official/preview 需为整数`)
  }
  if (typeof createdAt !== 'string' || createdAt.length === 0) throw corruptError(file, `games[${id}].createdAt 需为非空字符串`)

  return {
    name,
    isDefault,
    source: normalizedSource,
    resolved: { commit: resolved.commit, syncedAt: resolved.syncedAt, lockfileHash: resolved.lockfileHash },
    ports: { official: ports.official, preview: ports.preview },
    createdAt,
  }
}

/** 校验整份 registry（逐 entry）；返回归一化后的新对象。 */
function validateRegistryFile(data: unknown, file: string): RegistryFile {
  if (!isRecord(data)) throw corruptError(file, '顶层不是对象')
  if (!isRecord(data.games)) throw corruptError(file, '缺 games 对象')
  const games: Record<string, GameRegistryEntry> = {}
  for (const [id, entry] of Object.entries(data.games)) {
    games[id] = validateEntry(id, entry, file)
  }
  return { games }
}

// ---------------------------------------------------------------------------
// 读写层：进程内缓存 + mtime 失效；写 = 临时文件 + rename 原子替换
// ---------------------------------------------------------------------------

interface CacheSlot {
  mtimeMs: number
  size: number
  file: RegistryFile
}

/** registry.json 是小文件（entry 量级 <100），整文件缓存足够。 */
const cache = new Map<string, CacheSlot>()

/**
 * 读 registry。文件不存在 → 空注册表（首建由 ensureSeeded 负责）；
 * 命中缓存且 mtime/size 未变 → 直接返回缓存对象（**勿直接改写返回值**，
 * 增删走 upsertGame/removeGame）。文件损坏 → registry_corrupt（fail-fast）。
 */
export function readRegistry(options?: RegistryOptions): RegistryFile {
  const file = options?.registryPath ?? DEFAULT_REGISTRY_PATH
  let st: fs.Stats
  try {
    st = fs.statSync(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { games: {} }
    throw new RegistryError('registry_read_error', `registry 状态读取失败 ${file}: ${(err as Error).message}`)
  }
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.file
  const raw = fs.readFileSync(file, 'utf8')
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    throw new RegistryError('registry_corrupt', `registry JSON 解析失败（${file}）：${(err as Error).message}`)
  }
  const parsed = validateRegistryFile(data, file)
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, file: parsed })
  return parsed
}

/**
 * 整文件写 registry：同目录临时文件（唯一命名）+ rename 原子替换——rename 在
 * 同一文件系统上是原子操作，跨进程并发读/写都不会看到半写文件。写成功后以
 * rename 后的实况刷新进程内缓存。
 */
export function writeRegistry(file: RegistryFile, options?: RegistryOptions): void {
  const target = options?.registryPath ?? DEFAULT_REGISTRY_PATH
  validateRegistryFile(file, target)
  const dir = path.dirname(target)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  const raw = `${JSON.stringify(file, null, 2)}\n`
  try {
    fs.writeFileSync(tmp, raw, 'utf8')
    fs.renameSync(tmp, target)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // 临时文件清理尽力而为
    }
    throw new RegistryError('registry_write_error', `registry 写入失败 ${target}: ${(err as Error).message}`)
  }
  const st = fs.statSync(target)
  cache.set(target, { mtimeMs: st.mtimeMs, size: st.size, file })
}

// ---------------------------------------------------------------------------
// 端口池：official 3000-3199 / preview 3200-3399，first-fit
// ---------------------------------------------------------------------------

export const OFFICIAL_PORT_RANGE = { min: 3000, max: 3199 } as const
export const PREVIEW_PORT_RANGE = { min: 3200, max: 3399 } as const

/**
 * 纯函数：在现有 games 占用之外为**新游戏** first-fit 分配 { official, preview }。
 * 持久化由调用方（upsertGame）负责；某段占满抛 ports_exhausted（带段范围文案）。
 */
export function allocatePorts(games: Record<string, GameRegistryEntry>): { official: number; preview: number } {
  const usedOfficial = new Set<number>()
  const usedPreview = new Set<number>()
  for (const entry of Object.values(games)) {
    usedOfficial.add(entry.ports.official)
    usedPreview.add(entry.ports.preview)
  }
  return {
    official: firstFit(usedOfficial, OFFICIAL_PORT_RANGE, 'official'),
    preview: firstFit(usedPreview, PREVIEW_PORT_RANGE, 'preview'),
  }
}

function firstFit(used: Set<number>, range: { readonly min: number; readonly max: number }, label: string): number {
  for (let port = range.min; port <= range.max; port++) {
    if (!used.has(port)) return port
  }
  throw new RegistryError('ports_exhausted', `${label} 端口段 ${range.min}-${range.max} 已占满，无法为新游戏分配端口`)
}

/** upsert 用：端口必须落在各自段内（播种 entry 不走此校验，见 ensureSeeded 注释）。 */
function validatePortsInSegments(ports: { official: number; preview: number }): void {
  if (ports.official < OFFICIAL_PORT_RANGE.min || ports.official > OFFICIAL_PORT_RANGE.max) {
    throw new RegistryError(
      'ports_out_of_range',
      `official 端口 ${ports.official} 不在 ${OFFICIAL_PORT_RANGE.min}-${OFFICIAL_PORT_RANGE.max} 段内`,
    )
  }
  if (ports.preview < PREVIEW_PORT_RANGE.min || ports.preview > PREVIEW_PORT_RANGE.max) {
    throw new RegistryError(
      'ports_out_of_range',
      `preview 端口 ${ports.preview} 不在 ${PREVIEW_PORT_RANGE.min}-${PREVIEW_PORT_RANGE.max} 段内`,
    )
  }
}

// ---------------------------------------------------------------------------
// entry 增删查
// ---------------------------------------------------------------------------

/** 单游戏读取；不存在返回 undefined。 */
export function getGame(id: string, options?: RegistryOptions): GameRegistryEntry | undefined {
  return readRegistry(options).games[id]
}

/**
 * 新增/覆盖一个游戏 entry 并持久化（分配即持久化）：
 * - ports 省略 → 端口池 first-fit（分配结果随本次写入落盘）；
 * - isDefault: true → 清除其余 entry 的 isDefault（全表单例）；
 * - 内部为"克隆 → 改 → 原子写"：写盘失败不会污染进程内缓存。
 */
export function upsertGame(id: string, input: GameRegistryEntryInput, options?: RegistryOptions): GameRegistryEntry {
  assertValidGameId(id)
  const reg = structuredClone(readRegistry(options))
  const entry = validateEntry(id, { ...input, ports: input.ports ?? allocatePorts(reg.games) }, `<upsert ${id}>`)
  validatePortsInSegments(entry.ports)
  if (entry.isDefault) {
    for (const [otherId, other] of Object.entries(reg.games)) {
      if (otherId !== id) other.isDefault = false
    }
  }
  reg.games[id] = entry
  writeRegistry(reg, options)
  return entry
}

/** 删除游戏 entry 并持久化；不存在返回 false（幂等）。 */
export function removeGame(id: string, options?: RegistryOptions): boolean {
  assertValidGameId(id)
  const reg = structuredClone(readRegistry(options))
  if (!(id in reg.games)) return false
  delete reg.games[id]
  writeRegistry(reg, options)
  return true
}

// ---------------------------------------------------------------------------
// 播种（Phase 1 → Phase 2 升级兼容）
// ---------------------------------------------------------------------------

export interface SeedResult {
  seeded: boolean
  registryPath: string
  entry?: GameRegistryEntry
}

/**
 * registry.json 不存在时用 defaultGameContext 播种 'gst' entry（Q2：gst 为
 * local 源）：
 * - source.path 存相对平台仓库根的解析结果（'../game_server_test' 形态，
 *   绝对路径由 resolveLocalGamePath 锚定还原）；
 * - ports 原样继承 defaultGameContext.ports 现状值（official 取本体 .env 的
 *   PORT 实际值，如 3001——不走端口池、不做段校验，避免与线上实况漂移）；
 * - resolved 三字段空串占位 = 尚未同步（T2.5 回填）。
 * 文件已存在时为幂等 no-op（不复活被删除的 entry，不覆盖任何手工修改）。
 * 并发播种（多进程同启）最后写者获胜，内容相同，无 害。
 */
export function ensureSeeded(options?: RegistryOptions): SeedResult {
  const target = options?.registryPath ?? DEFAULT_REGISTRY_PATH
  if (fs.existsSync(target)) {
    // 已有 registry：触发一次读取尽早暴露损坏文件（fail-fast），但不改写。
    readRegistry(options)
    return { seeded: false, registryPath: target }
  }
  const ctx = defaultGameContext
  const entry: GameRegistryEntry = {
    name: ctx.gameId,
    isDefault: true,
    source: { type: 'local', path: toRepoRelative(ctx.gameRoot) },
    resolved: { commit: '', syncedAt: '', lockfileHash: '' },
    ports: { official: ctx.ports.official, preview: ctx.ports.preview },
    createdAt: new Date().toISOString(),
  }
  writeRegistry({ games: { [ctx.gameId]: entry } }, options)
  return { seeded: true, registryPath: target, entry }
}

// ---------------------------------------------------------------------------
// local 源路径锚定
// ---------------------------------------------------------------------------

/**
 * local source.path → 绝对路径：相对路径以平台仓库根为基准锚定
 * （'../game_server_test' → <repo>/../game_server_test），绝对路径原样规整。
 */
export function resolveLocalGamePath(source: LocalGameSource): string {
  return path.isAbsolute(source.path) ? path.resolve(source.path) : path.resolve(repoRoot, source.path)
}

/** 绝对路径 → 相对平台仓库根的存储形态（播种 gst 用）。 */
function toRepoRelative(absolutePath: string): string {
  const rel = path.relative(repoRoot, absolutePath)
  return rel === '' ? '.' : rel
}
