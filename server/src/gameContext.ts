/**
 * GameContext —— 全部"游戏特化"常量的单一出口（T1.4；T2.3 工厂化）。
 *
 * Phase 1（单游戏）里 defaultGameContext 以数据固化现状行为（gameId 'gst'，
 * 全部取值与原 config.ts / instanceManager.ts / configService.ts 硬编码一致）。
 * Phase 2（T2.3）起提供 forGame(gameId) 工厂：registry entry + manifest 合成
 * per-game 上下文，消费方（config 兼容壳 / instanceManager / saveService /
 * logStream / liveState / configService.routeSchemaKind）不再持有游戏特化硬编码。
 * defaultGameContext 保留导出（存量消费方兼容，T2.4 才改接 forGame）。
 *
 * 约定：
 * - 本文件位于 <excalibur_test>/server/src/，按相对层数定位本体仓库
 *   game_server_test（../../../game_server_test/），GAME_ROOT 环境变量可覆盖。
 * - 派生目录（logs / saves / game）只定义路径；是否创建由使用方负责
 *   （本阶段只有 gameLogsDir 需要容错不存在）。
 * - ports.official 的解析优先级：OFFICIAL_PORT env → 本体 .env 的 PORT → 3000
 *   （official 不注入 PORT，展示值只能尽力解析，详见 config.ts 原注释语义）。
 *
 * forGame 合成规则（T2.3）：
 * - gameRoot：git 源锚定 server/games/<id>/checkout/；local 源锚定
 *   resolveLocalGamePath 的解析结果（registry.ts）；
 * - manifest：server/games/<id>/game.json 存在 → 读取 + zod 校验；不存在 →
 *   对 gameRoot 跑 probeManifest（id 显式传 gameId）现场生成并**写盘**（此后
 *   manifest 文件是单一事实源，T2.5 导入流同样写这里）；
 * - ports 取 registry entry.ports（T2.1 播种时继承 defaultGameContext 现状值）；
 * - 缓存：manifest 文件 mtime+size 或 registry.json mtime+size 变化 → 重建；
 *   显式 invalidateGameContext(gameId) 兜底。
 * - 模块循环：本文件 ↔ games/registry.ts / games/manifest.ts 互相 import，
 *   但全部只在函数体内使用对方导出（ESM live binding，无 TDZ 风险）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import {
  assertManifest,
  probeManifest,
  type GameManifest,
} from './games/manifest.js'
import {
  DEFAULT_REGISTRY_PATH,
  getGame,
  resolveLocalGamePath,
  type GameRegistryEntry,
} from './games/registry.js'

/**
 * schema 路由表条目：relPath（'/' 分隔，相对工作区 game/）→ schemaKind。
 *
 * - pattern：完整锚定（^...$）的正则源串（new RegExp(pattern) 使用）。
 * - kind：'*' 语义表示 kind = 命中文件的文件名（去 .json 后缀，即规则名，
 *   如 rules/combat.json → 'combat'）；其余为字面 kind（如 'GameDefinition'）。
 */
export interface SchemaRoute {
  pattern: string
  kind: string
}

/** 单个游戏的全部特化上下文。 */
export interface GameContext {
  /** 游戏标识（Phase 2 per-game 工厂的键）。 */
  gameId: string
  /** 本体游戏仓库根（游戏实例的工作目录）。 */
  gameRoot: string
  /** 本体配置目录（<gameRoot>/game，S2-A 工作区镜像源）。 */
  gameConfigsDir: string
  /** 本体游戏日志目录（winston File transport 写 <gameRoot>/logs/game.log）。 */
  gameLogsDir: string
  /** 本体游戏日志文件（logStream tail 的目标，不存在时容错等待）。 */
  gameLogFile: string
  /** official 存档目录（<gameRoot>/data/saves）。 */
  savesDir: string
  /** 本体环境文件（official 展示端口解析链读取 .env 的 PORT 用）。 */
  envFile: string
  /** 双角色展示端口（official 见上方解析链；preview 恒 3200）。 */
  ports: { official: number; preview: number }
  /** 游戏实例启动命令（win32 下 pnpm → pnpm.cmd 的平台适配留在消费方）。 */
  start: { command: string; args: string[] }
  /** preview 实例注入的环境变量**名**（值由消费方在 spawn 前动态解析）。 */
  envInjection: { port: string; configPath: string; saveDir: string }
  /** 配置文件 schema 路由表（configService.routeSchemaKind 的数据源）。 */
  schemaRoutes: SchemaRoute[]
  /** Colyseus 房间名（liveState server 侧 join；web 端本 Phase 仍用常量）。 */
  roomName: string
}

/**
 * 从本体 .env 解析 PORT（模仿游戏进程 dotenv 的读取位置与不覆盖语义的近似值）。
 * 解析失败（文件不存在 / 无 PORT 行）返回 undefined。
 */
function readGameEnvPort(envFile: string): number | undefined {
  try {
    const raw = fs.readFileSync(envFile, 'utf8')
    const m = /^PORT\s*=\s*(\d+)\s*(?:#.*)?$/m.exec(raw)
    return m ? Number(m[1]) : undefined
  } catch {
    return undefined
  }
}

/**
 * 本体游戏仓库根。默认从 server/src/gameContext.ts 向上三层定位：
 * src → server → excalibur_test → game/，GAME_ROOT 环境变量可覆盖。
 */
const gameRoot = path.resolve(
  process.env.GAME_ROOT ?? fileURLToPath(new URL('../../../game_server_test/', import.meta.url)),
)

const gameConfigsDir = path.join(gameRoot, 'game')
const gameLogsDir = path.join(gameRoot, 'logs')
const envFile = path.join(gameRoot, '.env')

/** 当前游戏上下文（Phase 1 单游戏：全部值取自现状代码，行为不变）。 */
export const defaultGameContext: GameContext = {
  gameId: 'gst',
  gameRoot,
  gameConfigsDir,
  gameLogsDir,
  gameLogFile: path.join(gameLogsDir, 'game.log'),
  savesDir: path.join(gameRoot, 'data', 'saves'),
  envFile,
  ports: {
    official: Number(process.env.OFFICIAL_PORT ?? readGameEnvPort(envFile) ?? 3000),
    preview: 3200,
  },
  start: { command: 'pnpm', args: ['dev'] },
  envInjection: { port: 'PORT', configPath: 'GAME_CONFIG_PATH', saveDir: 'SAVE_DIR' },
  schemaRoutes: [
    { pattern: '^game\\.json$', kind: 'GameDefinition' },
    { pattern: '^entities\\/[^/]+\\.json$', kind: 'Archetype' },
    { pattern: '^maps\\/registry\\.json$', kind: 'MapRegistry' },
    { pattern: '^rules\\/combat\\.json$', kind: '*' },
    { pattern: '^rules\\/needs\\.json$', kind: '*' },
    { pattern: '^rules\\/crafting\\.json$', kind: '*' },
    { pattern: '^rules\\/daynight\\.json$', kind: '*' },
    { pattern: '^rules\\/server\\.json$', kind: '*' },
  ],
  roomName: 'game',
}

// ---------------------------------------------------------------------------
// T2.3：forGame(gameId) 工厂 —— registry entry + manifest 合成 per-game 上下文
// ---------------------------------------------------------------------------

/** games 目录默认位置（<excalibur_test>/server/games；registry.json / <id>/game.json 都锚这里）。 */
export const DEFAULT_GAMES_DIR = path.resolve(fileURLToPath(new URL('../games', import.meta.url)))

/** forGame 可注入路径（测试用 /tmp 路径，避免污染真实 server/games/）。 */
export interface ForGameOptions {
  /** registry.json 路径（缺省 DEFAULT_REGISTRY_PATH，含 GAMES_REGISTRY_PATH env 语义）。 */
  registryPath?: string
  /** games 目录（<dir>/<id>/game.json 与 git 源 checkout 锚点；缺省 server/games/）。 */
  gamesDir?: string
}

/** gameContext 工厂域错误；code 供 T2.7 REST 层映射状态码（404/422/500）。 */
export class GameContextError extends Error {
  constructor(
    readonly code: 'game_not_registered' | 'manifest_invalid' | 'manifest_probe_failed' | 'manifest_write_error',
    message: string,
  ) {
    super(message)
    this.name = 'GameContextError'
  }
}

interface StatFingerprint {
  mtimeMs: number
  size: number
}

interface ContextCacheSlot {
  ctx: GameContext
  /** manifest 文件指纹；null = 文件不存在（本次为探测生成路径）。 */
  manifest: StatFingerprint | null
  /** registry.json 文件指纹；null = 文件不存在。 */
  registry: StatFingerprint | null
}

/** 缓存键含注入路径（测试注入 /tmp 与真实路径互不串台）。 */
const contextCache = new Map<string, ContextCacheSlot>()

function statOrNull(file: string): StatFingerprint | null {
  try {
    const st = fs.statSync(file)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    return null
  }
}

function sameStat(a: StatFingerprint | null, b: StatFingerprint | null): boolean {
  if (a === null || b === null) return a === b
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

function cacheKey(gameId: string, options?: ForGameOptions): string {
  return `${options?.registryPath ?? DEFAULT_REGISTRY_PATH}\u0000${options?.gamesDir ?? DEFAULT_GAMES_DIR}\u0000${gameId}`
}

/** manifest 文件路径：<gamesDir>/<gameId>/game.json。 */
export function manifestPathFor(gameId: string, options?: ForGameOptions): string {
  return path.join(options?.gamesDir ?? DEFAULT_GAMES_DIR, gameId, 'game.json')
}

/** 显式失效缓存（下次 forGame 必重建；manager/后续任务的外部兜底入口）。 */
export function invalidateGameContext(gameId: string, options?: ForGameOptions): boolean {
  return contextCache.delete(cacheKey(gameId, options))
}

/**
 * per-game 上下文工厂（T2.3）：
 * - 游戏未注册 → game_not_registered（T2.7 映射 404）；
 * - manifest 文件存在 → 读取 + zod 校验（不过 → manifest_invalid，422）；
 * - manifest 文件不存在 → probeManifest(gameRoot, { id: gameId }) 现场生成并
 *   原子写盘 <gamesDir>/<id>/game.json（探测失败 → manifest_probe_failed，422）；
 * - 缓存命中（manifest/registry 文件指纹均未变）→ 直接返回缓存对象；
 *   任一变化 → 重建。
 */
export function forGame(gameId: string, options?: ForGameOptions): GameContext {
  const registryPath = options?.registryPath
  const gamesDir = options?.gamesDir ?? DEFAULT_GAMES_DIR
  const manifestPath = manifestPathFor(gameId, options)

  // registry 读取错误（损坏等 RegistryError）原样上抛（fail-fast，T2.7 映射 500）
  const entry = getGame(gameId, { registryPath })
  if (!entry) {
    throw new GameContextError('game_not_registered', `游戏未注册：${gameId}（registry: ${registryPath ?? DEFAULT_REGISTRY_PATH}）`)
  }

  const key = cacheKey(gameId, options)
  const regStat = statOrNull(registryPath ?? DEFAULT_REGISTRY_PATH)
  const manStat = statOrNull(manifestPath)
  const hit = contextCache.get(key)
  if (hit && sameStat(hit.registry, regStat) && sameStat(hit.manifest, manStat)) return hit.ctx

  const ctx = buildGameContext(gameId, entry, gamesDir, manifestPath)
  contextCache.set(key, {
    ctx,
    manifest: statOrNull(manifestPath),
    registry: regStat,
  })
  return ctx
}

function buildGameContext(
  gameId: string,
  entry: GameRegistryEntry,
  gamesDir: string,
  manifestPath: string,
): GameContext {
  const gameRoot = resolveGameRoot(gameId, entry, gamesDir)
  const manifest = loadOrProbeManifest(gameId, gameRoot, manifestPath)
  return synthGameContext(gameId, entry, gameRoot, manifest)
}

/** git 源锚 server/games/<id>/checkout/；local 源锚 resolveLocalGamePath 解析结果。 */
function resolveGameRoot(gameId: string, entry: GameRegistryEntry, gamesDir: string): string {
  if (entry.source.type === 'git') return path.join(gamesDir, gameId, 'checkout')
  return resolveLocalGamePath(entry.source)
}

function loadOrProbeManifest(gameId: string, gameRoot: string, manifestPath: string): GameManifest {
  let raw: string | null = null
  try {
    raw = fs.readFileSync(manifestPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new GameContextError('manifest_invalid', `manifest 读取失败 ${manifestPath}: ${(err as Error).message}`)
    }
  }
  if (raw !== null) {
    try {
      // assertManifest：zod 校验失败抛 ManifestValidationError → 归一为 GameContextError
      return assertManifest(JSON.parse(raw))
    } catch (err) {
      if (err instanceof GameContextError) throw err
      if (err instanceof SyntaxError) {
        throw new GameContextError('manifest_invalid', `manifest JSON 解析失败（${manifestPath}）: ${err.message}`)
      }
      throw new GameContextError('manifest_invalid', `manifest 校验失败（${manifestPath}）: ${(err as Error).message}`)
    }
  }
  // 兜底：gst 现状还没有 manifest 文件 —— 对 gameRoot 现场探测生成并写盘，
  // 此后 manifest 文件是单一事实源（id 显式传 gameId，不用目录名推导）。
  const probe = probeOrThrow(gameId, gameRoot)
  writeManifestFile(manifestPath, probe)
  return probe
}

function probeOrThrow(gameId: string, gameRoot: string): GameManifest {
  const probe = probeManifest(gameRoot, { id: gameId })
  if (!probe.ok) {
    const detail = probe.errors.map((e) => `${e.path.length > 0 ? e.path.join('.') : '(root)'}: ${e.message}`).join('; ')
    throw new GameContextError('manifest_probe_failed', `manifest 探测失败（${gameRoot}）: ${detail}`)
  }
  return probe.manifest
}

/** manifest 原子写盘：同目录临时文件 + rename（与 registry.writeRegistry 同策略）。 */
function writeManifestFile(manifestPath: string, manifest: GameManifest): void {
  const dir = path.dirname(manifestPath)
  try {
    fs.mkdirSync(dir, { recursive: true })
    const tmp = path.join(dir, `.${path.basename(manifestPath)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
    fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, manifestPath)
  } catch (err) {
    throw new GameContextError('manifest_write_error', `manifest 写盘失败 ${manifestPath}: ${(err as Error).message}`)
  }
}

/** manifest + registry entry → GameContext（路径字段全部锚定 gameRoot）。 */
function synthGameContext(
  gameId: string,
  entry: GameRegistryEntry,
  gameRoot: string,
  m: GameManifest,
): GameContext {
  return {
    gameId,
    gameRoot,
    gameConfigsDir: path.join(gameRoot, m.configDir),
    gameLogsDir: path.join(gameRoot, m.logsDir),
    gameLogFile: path.join(gameRoot, m.logsDir, 'game.log'),
    savesDir: path.join(gameRoot, m.savesDir),
    envFile: path.join(gameRoot, m.envFile),
    ports: { official: entry.ports.official, preview: entry.ports.preview },
    start: { command: m.start.command, args: [...m.start.args] },
    envInjection: { ...m.envInjection },
    schemaRoutes: m.schemaRoutes.map((route) => ({ ...route })),
    roomName: m.observer.roomName,
  }
}
