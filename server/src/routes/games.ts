/**
 * games 管理 REST 路由 + per-game 路由作用域（T2.7）。
 *
 * 挂载结构（index.ts；scoped 先、legacy 后——express 5 参数路由冲突规避）：
 * - `app.use('/api/games', gamesRouter)`                      列表 / 导入
 * - `app.use('/api/games/:gameId', gameResolver, gameScopedRouter)`
 *   详情 / sync / PATCH / DELETE + 全部领域子路由（instances/workspaces/
 *   configs/config-context/apply/backups/maps/saves/registries/live）
 * - 旧挂载点（/api/instances 等）保留：`legacyGameScope` 中间件把
 *   `req.gameId` 置为 isDefault 游戏后走同一批 Router 实例——**内部 forward、
 *   不做 307**（Q3 已拍板：WS 无法 307 且 forward 对客户端无感）；别名删除
 *   时点 = P3（Q4）。
 *
 * gameResolver：:gameId 已注册 → req.gameId；未注册 → 404。
 *
 * REST 状态码（本文件新增面）：
 * - GameSyncError：bad_source/probe_failed/smoke_failed → 422、
 *   not_registered → 404、conflict → 409、command_failed → 500（detail.stderrTail）
 * - GameContextError → 经 handleError 委托 helpers.gameContextErrorStatus
 *   （唯一映射源）：game_not_registered → 404，manifest_* → 422
 * - ManifestValidationError → 422（detail.errors）
 * - RegistryError：bad_game_id → 400，其余 → 500
 * - ConflictError（默认游戏危险组合守卫）→ 409（handleError 既有语义）
 *
 * 注意：PATCH/DELETE 的默认游戏守卫按规格"危险组合按现有错误类处理"实现：
 * - DELETE 默认游戏 → 409（须先把 isDefault 转移给其他游戏）；
 * - 最后一个游戏 DELETE → 409；
 * - 默认游戏 PATCH isDefault:false 且无其他默认候选 → 409。
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'

import {
  defaultGameContext,
  forGame,
  GameContextError,
  manifestPathFor,
} from '../gameContext.js'
import {
  assertManifest,
  formatManifestIssues,
  ManifestValidationError,
  validateManifest,
  type GameManifest,
} from '../games/manifest.js'
import {
  getGame,
  readRegistry,
  RegistryError,
  upsertGame,
  type GameRegistryEntry,
  type GameSource,
} from '../games/registry.js'
import { sidecarManager } from '../sidecar/manager.js'
import { GameSyncError, gameSyncService } from '../services/gameSyncService.js'
import { invalidateServicesFor } from '../services/index.js'
import { ConflictError } from '../services/instanceManager.js'
import { applyRouter, backupsRouter } from './apply.js'
import { configContextRouter } from './configContext.js'
import { configIndexRouter } from './configIndex.js'
import { configsRouter } from './configs.js'
import { fail, handleError, ok } from './helpers.js'
import { liveRouter } from './live.js'
import { mapsRouter } from './maps.js'
import { processRouter } from './process.js'
import { registriesRouter } from './registries.js'
import { savesRouter } from './saves.js'
import { schemasRouter } from './schemas.js'
import { workspaceRouter } from './workspace.js'

// ---------------------------------------------------------------------------
// 错误映射（本文件新增错误域 → REST 状态码）
// ---------------------------------------------------------------------------

const GAME_SYNC_STATUS: Record<GameSyncError['code'], number> = {
  bad_source: 422,
  probe_failed: 422,
  smoke_failed: 422,
  not_registered: 404,
  conflict: 409,
  command_failed: 500,
}

/** games 路由统一 catch：新错误域映射 + 既有 handleError 兜底。
 *  GameContextError 不在此分支——统一委托 helpers.handleError
 *  （gameContextErrorStatus 唯一映射源；T2.9 对齐，原 write_error 500 → 422）。 */
function handleGamesError(res: Response, err: unknown): void {
  if (err instanceof GameSyncError) {
    fail(res, GAME_SYNC_STATUS[err.code], err.message, err.detail !== undefined ? { stderrTail: err.detail } : undefined)
    return
  }
  if (err instanceof ManifestValidationError) {
    fail(res, 422, err.message, { errors: err.issues })
    return
  }
  if (err instanceof RegistryError) {
    fail(res, err.code === 'bad_game_id' ? 400 : 500, err.message)
    return
  }
  handleError(res, err)
}

// ---------------------------------------------------------------------------
// 默认游戏解析（legacy forward 的目标；Q3）
// ---------------------------------------------------------------------------

/** registry 中 isDefault 的游戏 id；无（异常态）→ defaultGameContext.gameId 兜底。 */
function defaultGameId(): string {
  for (const [id, entry] of Object.entries(readRegistry().games)) {
    if (entry.isDefault) return id
  }
  return defaultGameContext.gameId
}

// ---------------------------------------------------------------------------
// 挂载层中间件
// ---------------------------------------------------------------------------

/**
 * scoped 挂载的 :gameId 解析器：已注册 → req.gameId；未注册 → 404；
 * registry 读取失败（损坏等 RegistryError）→ 500（fail-fast）。
 */
export function gameResolver(req: Request, res: Response, next: NextFunction): void {
  const gameId = req.params.gameId
  if (typeof gameId !== 'string' || gameId.length === 0) {
    fail(res, 404, 'missing :gameId')
    return
  }
  try {
    if (!getGame(gameId)) {
      fail(res, 404, `游戏未注册：${gameId}`)
      return
    }
  } catch (err) {
    handleGamesError(res, err)
    return
  }
  req.gameId = gameId
  next()
}

/**
 * 旧挂载点作用域注入（Q3 内部 forward）：req.gameId = isDefault 游戏。
 * registry 读取失败时回退 defaultGameContext.gameId 并记日志——旧路由在
 * Phase 1 从不读 registry，此回退保持"旧客户端不断"语义。
 */
export function legacyGameScope(req: Request, _res: Response, next: NextFunction): void {
  if (req.gameId === undefined) {
    try {
      req.gameId = defaultGameId()
    } catch (err) {
      console.error('[games] registry 读取失败，旧路由回退默认游戏:', err)
      req.gameId = defaultGameContext.gameId
    }
  }
  next()
}

// ---------------------------------------------------------------------------
// sidecar 状态摘要（GET 列表/详情；describe 不触发 driver spawn）
// ---------------------------------------------------------------------------

function sidecarSummary(gameId: string): {
  fingerprint: string
  fingerprintSource: string
  alive: boolean
  pid: number | null
  spawnFailures: number
  unavailable: string | null
} {
  const desc = sidecarManager.describe(gameId)
  return {
    fingerprint: desc.fingerprint,
    fingerprintSource: desc.fingerprintSource,
    alive: desc.client.alive,
    pid: desc.client.pid,
    spawnFailures: desc.client.spawnFailures,
    unavailable: desc.client.unavailable,
  }
}

function sidecarStatus(gameId: string): ReturnType<typeof sidecarManager.describe> {
  return sidecarManager.describe(gameId)
}

// ---------------------------------------------------------------------------
// manifest 读写（详情展示 + PATCH 高级字段）
// ---------------------------------------------------------------------------

/** 读 manifest 文件；缺失 → null（不探测、不写盘——GET 零副作用）。 */
function readManifestOrNull(gameId: string): GameManifest | null {
  const file = manifestPathFor(gameId)
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new GameContextError('manifest_invalid', `manifest 读取失败 ${file}: ${(err as Error).message}`)
  }
  try {
    return assertManifest(JSON.parse(raw))
  } catch (err) {
    if (err instanceof GameContextError) throw err
    throw new GameContextError(
      'manifest_invalid',
      `manifest 校验失败（${file}）: ${(err as Error).message}`,
    )
  }
}

/** manifest 原子写盘：同目录临时文件 + rename（与 gameContext/registry 同策略）。 */
function writeManifestFile(gameId: string, manifest: GameManifest): void {
  const file = manifestPathFor(gameId)
  const dir = path.dirname(file)
  try {
    fs.mkdirSync(dir, { recursive: true })
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
    fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
  } catch (err) {
    throw new GameContextError('manifest_write_error', `manifest 写盘失败 ${file}: ${(err as Error).message}`)
  }
}

/** PATCH 用：manifest 文件缺失时经 forGame 物化（探测生成并写盘），再读回。 */
function loadManifestForPatch(gameId: string): GameManifest {
  const existing = readManifestOrNull(gameId)
  if (existing !== null) return existing
  forGame(gameId) // 缺失 → 现场探测写盘（失败抛 GameContextError → 422/500）
  const materialized = readManifestOrNull(gameId)
  if (materialized === null) {
    throw new GameContextError('manifest_write_error', `manifest 物化后仍不可读：${manifestPathFor(gameId)}`)
  }
  return materialized
}

// ---------------------------------------------------------------------------
// 详情负载（GET /api/games/:gameId 与 PATCH 返回共用形状）
// ---------------------------------------------------------------------------

function gameDetailPayload(gameId: string): Record<string, unknown> {
  const entry = getGame(gameId)
  if (!entry) throw new GameContextError('game_not_registered', `游戏未注册：${gameId}`)
  return {
    id: gameId,
    ...entry,
    manifest: readManifestOrNull(gameId),
    sidecar: sidecarStatus(gameId),
  }
}

// ---------------------------------------------------------------------------
// gamesRouter（挂载于 /api/games）：列表 + 导入
// ---------------------------------------------------------------------------

export const gamesRouter = Router()

/** GET /api/games → 列表 + 状态（name/isDefault/source/resolved/ports/isImporting/sidecar 摘要）。 */
gamesRouter.get('/', (_req: Request, res: Response) => {
  try {
    const games = Object.entries(readRegistry().games).map(([id, entry]) => ({
      id,
      ...entry,
      isImporting: gameSyncService.isImporting(id),
      sidecar: sidecarSummary(id),
    }))
    ok(res, { defaultGameId: defaultGameId(), games })
  } catch (err) {
    handleGamesError(res, err)
  }
})

/** body 轻校验：字符串可选字段（存在时必须是 string）。 */
function checkOptionalString(res: Response, body: Record<string, unknown>, key: string): boolean {
  const value = body[key]
  if (value !== undefined && typeof value !== 'string') {
    fail(res, 400, `${key} 必须为字符串`)
    return false
  }
  return true
}

/**
 * POST /api/games/import { source:{type:'git',url,ref}|{type:'local',path}, id?, name? }
 * → gameSyncService.importGame（T2.5 服务层；导入中同 id → 409）。
 * git clone 全流程可达分钟级——请求挂起至完成，进度打 admin 日志。
 */
gamesRouter.post('/import', async (req: Request, res: Response) => {
  try {
    const body: unknown = req.body
    if (typeof body !== 'object' || body === null) {
      fail(res, 400, 'body 必须为 JSON 对象')
      return
    }
    const b = body as Record<string, unknown>
    if (typeof b.source !== 'object' || b.source === null) {
      fail(res, 400, 'source 必须为对象（{type:"git",url,ref} 或 {type:"local",path}）')
      return
    }
    if (!checkOptionalString(res, b, 'id') || !checkOptionalString(res, b, 'name')) return
    const result = await gameSyncService.importGame(
      {
        source: b.source as GameSource,
        ...(b.id !== undefined ? { id: b.id as string } : {}),
        ...(b.name !== undefined ? { name: b.name as string } : {}),
      },
      {
        onProgress: (e) => console.log(`[games:import] ${e.gameId} ${e.stage}: ${e.message}`),
      },
    )
    ok(res, result)
  } catch (err) {
    handleGamesError(res, err)
  }
})

// ---------------------------------------------------------------------------
// gameScopedRouter（挂载于 /api/games/:gameId，gameResolver 之后）
// ---------------------------------------------------------------------------

export const gameScopedRouter = Router()

// ---- 游戏 详情/同步/编辑（先注册，避免与领域子路由的单段参数冲突）----

/** GET /api/games/:gameId → manifest + registry entry + 端口 + sidecar 状态。 */
gameScopedRouter.get('/', (req: Request, res: Response) => {
  try {
    ok(res, gameDetailPayload(req.gameId))
  } catch (err) {
    handleGamesError(res, err)
  }
})

/** POST /api/games/:gameId/sync → gameSyncService.syncGame（幂等更新）。 */
gameScopedRouter.post('/sync', async (req: Request, res: Response) => {
  try {
    const result = await gameSyncService.syncGame(req.gameId, {
      onProgress: (e) => console.log(`[games:sync] ${e.gameId} ${e.stage}: ${e.message}`),
    })
    ok(res, result)
  } catch (err) {
    handleGamesError(res, err)
  }
})

/** PATCH body 允许的字段（registry 字段 + manifest 高级字段；未知键拒绝防静默 no-op）。 */
const PATCH_ALLOWED_KEYS = new Set([
  'name',
  'isDefault',
  'source',
  'start',
  'envInjection',
  'schemaRoutes',
  'roomName',
  'trustScripts',
])

/** PATCH registry 部分落盘（ports/resolved/createdAt 原样保留；isDefault 单例由 upsertGame 保证）。 */
function patchRegistryEntry(gameId: string, entry: GameRegistryEntry, next: GameRegistryEntry): void {
  const changed =
    next.name !== entry.name ||
    next.isDefault !== entry.isDefault ||
    JSON.stringify(next.source) !== JSON.stringify(entry.source)
  if (changed) upsertGame(gameId, next)
}

/**
 * PATCH /api/games/:gameId：
 * - registry 字段：name / isDefault / source.path|ref（source.type 不可变，改源类型请删除重导）；
 * - manifest 高级字段：start / envInjection / schemaRoutes / roomName / trustScripts
 *   （整份 validateManifest 校验后原子写盘）；
 * - 改后 sidecarManager.invalidate(gameId)（= gameContext 缓存 + driver 一并失效；
 *   servicesFor 容器经 contextHolder 热更新，既有服务实例原样保留）。
 */
gameScopedRouter.patch('/', async (req: Request, res: Response) => {
  try {
    const gameId = req.gameId
    const entry = getGame(gameId)
    if (!entry) {
      fail(res, 404, `游戏未注册：${gameId}`)
      return
    }
    const body: unknown = req.body
    if (typeof body !== 'object' || body === null) {
      fail(res, 400, 'body 必须为 JSON 对象')
      return
    }
    const b = body as Record<string, unknown>
    const unknownKeys = Object.keys(b).filter((k) => !PATCH_ALLOWED_KEYS.has(k))
    if (unknownKeys.length > 0) {
      fail(res, 400, `不支持的字段：${unknownKeys.join(', ')}（允许：${[...PATCH_ALLOWED_KEYS].join(', ')}）`)
      return
    }
    if (Object.keys(b).length === 0) {
      fail(res, 400, '无可更新字段')
      return
    }

    // ---- registry 字段 ----
    let nextEntry: GameRegistryEntry = { ...entry }
    if (b.name !== undefined) {
      if (typeof b.name !== 'string' || b.name.trim().length === 0) {
        fail(res, 400, 'name 必须为非空字符串')
        return
      }
      nextEntry.name = b.name
    }
    if (b.isDefault !== undefined) {
      if (typeof b.isDefault !== 'boolean') {
        fail(res, 400, 'isDefault 必须为 boolean')
        return
      }
      if (entry.isDefault && b.isDefault === false) {
        // 危险组合：默认游戏摘牌且无接替者 → legacy forward 失去目标（409）
        const hasSuccessor = Object.entries(readRegistry().games).some(
          ([id, e]) => id !== gameId && e.isDefault,
        )
        if (!hasSuccessor) {
          throw new ConflictError(
            `游戏 ${gameId} 是当前默认游戏且无其他游戏可接替 isDefault，拒绝置 false（先把目标游戏 PATCH isDefault=true）`,
          )
        }
      }
      nextEntry.isDefault = b.isDefault
    }
    if (b.source !== undefined) {
      const s = b.source
      if (typeof s !== 'object' || s === null) {
        fail(res, 400, 'source 必须为对象')
        return
      }
      const src = s as Record<string, unknown>
      const type = src.type ?? entry.source.type
      if (type !== entry.source.type) {
        fail(res, 400, `source.type 变更不支持（当前 ${entry.source.type}）；如需换源类型请 DELETE 后重新导入`)
        return
      }
      if (type === 'local') {
        const prevPath = entry.source.type === 'local' ? entry.source.path : undefined
        const p = src.path ?? prevPath
        if (typeof p !== 'string' || p.trim().length === 0) {
          fail(res, 400, 'source.path 必须为非空字符串')
          return
        }
        nextEntry.source = { type: 'local', path: p }
      } else {
        const prevGit = entry.source.type === 'git' ? entry.source : undefined
        const url = src.url ?? prevGit?.url
        const ref = src.ref ?? prevGit?.ref
        if (typeof url !== 'string' || url.trim().length === 0 || typeof ref !== 'string' || ref.trim().length === 0) {
          fail(res, 400, 'git 源需要非空 source.url 与 source.ref')
          return
        }
        nextEntry.source = { type: 'git', url, ref }
      }
    }
    patchRegistryEntry(gameId, entry, nextEntry)

    // ---- manifest 高级字段 ----
    // roomName 在 manifest 中位于 observer.roomName（GameContext.roomName 的出处）
    const manifestKeys = ['start', 'envInjection', 'schemaRoutes', 'roomName', 'trustScripts'] as const
    const wantsManifest = manifestKeys.some((k) => b[k] !== undefined)
    if (wantsManifest) {
      const current = loadManifestForPatch(gameId)
      const candidate: Record<string, unknown> = { ...current }
      for (const k of manifestKeys) {
        if (b[k] === undefined) continue
        if (k === 'roomName') {
          const observer: Record<string, unknown> = { ...(current.observer as Record<string, unknown>) }
          observer.roomName = b[k]
          candidate.observer = observer
        } else {
          candidate[k] = b[k]
        }
      }
      const vr = validateManifest(candidate)
      if (!vr.ok) {
        fail(res, 422, `manifest 校验失败: ${formatManifestIssues(vr.issues)}`, { errors: vr.issues })
        return
      }
      writeManifestFile(gameId, vr.manifest)
    }

    // 改后失效（规格 T2.7）：gameContext 缓存 + sidecar driver 一并重建（lazy）
    sidecarManager.invalidate(gameId)
    ok(res, gameDetailPayload(gameId))
  } catch (err) {
    handleGamesError(res, err)
  }
})

/**
 * DELETE /api/games/:gameId → gameSyncService.removeGame（registry 删项 +
 * <gamesDir>/<id>/ 清理；workspaces/backups 不动）。二次确认由前端负责，
 * 服务端直接执行。危险组合守卫（ConflictError → 409）：默认游戏不可删、
 * 最后一个游戏不可删。
 */
gameScopedRouter.delete('/', (req: Request, res: Response) => {
  try {
    const gameId = req.gameId
    const reg = readRegistry()
    const entry = reg.games[gameId]
    if (!entry) {
      fail(res, 404, `游戏未注册：${gameId}`)
      return
    }
    if (entry.isDefault) {
      throw new ConflictError(`默认游戏不可删除：${gameId}（先把 isDefault 转移到其他游戏）`)
    }
    if (Object.keys(reg.games).length <= 1) {
      throw new ConflictError(`最后一个游戏不可删除：${gameId}`)
    }
    const result = gameSyncService.removeGame(gameId)
    invalidateServicesFor(gameId) // 丢弃容器缓存（不停止运行中进程；平台既有语义）
    ok(res, result)
  } catch (err) {
    handleGamesError(res, err)
  }
})

// ---- 领域子路由（与旧挂载点共用同一批 Router 实例，行为逐点不变）----
// 各 Router 原本锚定自己的资源根（/api/instances 等）；scoped 挂载在字面子路径
// 上消费掉资源段，Router 内部看到的相对路径与旧挂载逐字一致（/:role、/:id …）。

gameScopedRouter.use('/instances', processRouter)
gameScopedRouter.use('/workspaces', workspaceRouter)
gameScopedRouter.use('/configs', configsRouter)
gameScopedRouter.use('/config-context', configContextRouter)
// P1：配置 schema 与引用下拉索引（只读透传 / 活动工作区抽取；校验链路零改动）
gameScopedRouter.use('/schemas', schemasRouter)
gameScopedRouter.use('/config-index', configIndexRouter)
gameScopedRouter.use('/apply', applyRouter)
gameScopedRouter.use('/backups', backupsRouter)
gameScopedRouter.use('/maps', mapsRouter)
gameScopedRouter.use('/saves', savesRouter)
gameScopedRouter.use('/registries', registriesRouter)
gameScopedRouter.use('/live', liveRouter)
