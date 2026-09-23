/**
 * 注册表 REST 路由（S6-A，挂载于 /api/registries）。
 *
 * GET /api/registries → sidecar 透传五类注册表（T1.5：payload 组装——components
 * 只取键、mapGenerators 取 id 的游戏侧语义裁剪——已移入 driver，路由层不再
 * import gameBridge）。验收基准沿用 = 本体 `pnpm tools list-registries` 输出
 * （数量/条目 id 一致）。
 */
import { Router } from 'express'
import type { Request, Response } from 'express'

import { sidecarCall } from '../sidecar/errors.js'
import { handleError, ok, servicesForRequest } from './helpers.js'

export const registriesRouter = Router()

registriesRouter.get('/', async (req: Request, res: Response) => {
  try {
    // payload 组装在 driver（listRegistries）；路由层只透传 + 统一错误映射
    // （SidecarError → §0.2 REST 状态码，见 sidecar/errors.ts 的 sidecarCall）。
    // T2.7：client 从 per-game 容器解析（sidecarManager.forGame(req.gameId)）。
    ok(res, await sidecarCall(servicesForRequest(req).sidecar().listRegistries()))
  } catch (err) {
    handleError(res, err)
  }
})
