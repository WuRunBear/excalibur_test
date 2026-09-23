/**
 * REST 路由公共响应助手（S1-C 抽取，S2-A 起供全部路由复用）。
 *
 * 统一响应结构：
 * - 成功：{ code: 0, message: 'ok', detail }
 * - 失败：{ code: 1, message, detail? }，携带对应 HTTP 状态码。
 *
 * T2.7 追加：
 * - Express Request.gameId 全局增强：由 games.ts 的 gameResolver（scoped 挂载）
 *   或 legacyGameScope（旧挂载，取 isDefault 游戏）注入，全部路由处理器经
 *   servicesForRequest(req) 取 per-game 服务容器。
 * - 容器事件接线：非 compat（gst 缺省）容器在首次被路由使用时把
 *   instances.onStateChange/onLine、log.onLog 接到 wsHub 新频道公式
 *   （instance:state:{gameId} / instance:log:{gameId}:{role}）与自身
 *   liveState 观察——compat gst 容器由 index.ts 启动时接线，此处跳过防双发。
 */
import type { Response } from 'express'

import { defaultGameContext, GameContextError } from '../gameContext.js'
import { servicesFor, type GameServices } from '../services/index.js'
import { wsHub } from '../ws/hub.js'
import { ValidationFailedError } from '../services/configService.js'
import { ConflictError } from '../services/instanceManager.js'
import { WorkspaceError } from '../services/workspaceService.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** 当前请求作用域的游戏 id（gameResolver / legacyGameScope 挂载层注入，恒已设置）。 */
      gameId: string
    }
  }
}

/** 成功响应。 */
export function ok(res: Response, detail: unknown): void {
  res.json({ code: 0, message: 'ok', detail })
}

/** 错误响应。 */
export function fail(res: Response, status: number, message: string, detail?: unknown): void {
  res.status(status).json({ code: 1, message, ...(detail !== undefined ? { detail } : {}) })
}

/**
 * 统一异常映射：
 * - ConflictError（进程状态冲突）→ 409
 * - ConfigValidationError → 422（detail.errors 携带校验明细）
 * - WorkspaceError → 其自带 status（400/404/500）
 * - GameContextError → 按 code 映射（gameContextErrorStatus，T2.9 补缺：
 *   scoped 子路由此前落 500，语义应为 404/422）
 * - 其余 → 500
 */
export function handleError(res: Response, err: unknown): void {
  if (err instanceof ConflictError) {
    fail(res, err.status, err.message)
    return
  }
  if (err instanceof ValidationFailedError) {
    fail(res, 422, err.message, { errors: err.errors })
    return
  }
  if (err instanceof WorkspaceError) {
    fail(res, err.status, err.message, err.detail)
    return
  }
  if (err instanceof GameContextError) {
    fail(res, gameContextErrorStatus(err.code), err.message)
    return
  }
  console.error('[routes] unexpected error:', err)
  fail(res, 500, err instanceof Error ? err.message : String(err))
}

/**
 * GameContextError.code → REST 状态码（唯一映射源；games.ts 的 handleGamesError
 * 也经 handleError 委托至此）：
 * - game_not_registered → 404（对应 gameResolver 的未注册 404 语义）
 * - manifest_invalid / manifest_probe_failed / manifest_write_error → 422
 *   （manifest 是"游戏接入契约"数据，形状/探测/写盘失败都属请求侧资源不满足，
 *   message 已含具体缺失项；T2.9 缺陷修复口径）
 * - 其余/未来新增 code → 兜底 500
 */
export function gameContextErrorStatus(code: GameContextError['code']): number {
  switch (code) {
    case 'game_not_registered':
      return 404
    case 'manifest_invalid':
    case 'manifest_probe_failed':
    case 'manifest_write_error':
      return 422
    default:
      return 500
  }
}

// ---------------------------------------------------------------------------
// T2.7：per-game 服务寻址 + 非 compat 容器的事件接线（一次性）
// ---------------------------------------------------------------------------

/** 已完成接线的容器（按实例标识；容器热更新不换对象，WeakSet 命中即跳过）。 */
const wiredContainers = new WeakSet<GameServices>()

/** compat gst 容器锚（惰性取 servicesFor('gst')，即 index.ts 启动接线覆盖的那份）。 */
let compatAnchor: GameServices | null = null

function isCompatGstContainer(services: GameServices): boolean {
  if (compatAnchor === null) compatAnchor = servicesFor(defaultGameContext.gameId)
  return services === compatAnchor
}

/**
 * 非 compat 容器的事件接线（对齐 index.ts 对 compat gst 的既有接线，频道用
 * T2.7 新公式；仅当容器首次被使用时执行一次）。
 */
function wireContainerEvents(services: GameServices): void {
  if (wiredContainers.has(services)) return
  wiredContainers.add(services)
  if (isCompatGstContainer(services)) return // index.ts 启动接线已覆盖
  const gameId = services.gameId
  for (const manager of Object.values(services.instances)) {
    manager.onStateChange((snapshot) => {
      wsHub.broadcast(`instance:state:${snapshot.gameId || gameId}`, snapshot)
      services.live.handleInstanceStatus(snapshot.role, snapshot)
    })
    manager.onLine((role, source, line) => {
      services.log.ingestProcessLine(role, source, line)
    })
  }
  services.log.onLog((msg) => {
    wsHub.broadcast(`instance:log:${gameId}:${msg.role}`, msg)
  })
}

/**
 * 路由处理器取当前请求作用域的 per-game 服务容器（req.gameId 由挂载层保证）。
 *
 * GameContextError 处理（T2.9）：抛出前把 gameContextErrorStatus(code) 附加到
 * err.status——极少数**无 try/catch 的同步 handler**（如 process.ts 的 GET 快照
 * 三兄弟，异常会逃逸到 index.ts 的兜底错误中间件）也能按正确状态码响应
 * （兜底中间件按 err.status 取值）；走 handleError 的 handler 不受影响
 * （分支按 code 映射，status 附加值仅是兜底一致性）。
 */
export function servicesForRequest(req: { gameId: string }): GameServices {
  try {
    const services = servicesFor(req.gameId)
    wireContainerEvents(services)
    return services
  } catch (err) {
    if (err instanceof GameContextError && (err as { status?: unknown }).status === undefined) {
      ;(err as { status?: number }).status = gameContextErrorStatus(err.code)
    }
    throw err
  }
}
