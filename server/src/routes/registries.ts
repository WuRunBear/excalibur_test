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

import { sidecar } from '../sidecar/client.js'
import { sidecarCall } from '../sidecar/errors.js'
import { handleError, ok } from './helpers.js'

export const registriesRouter = Router()

registriesRouter.get('/', async (_req: Request, res: Response) => {
  try {
    // payload 组装在 driver（listRegistries）；路由层只透传 + 统一错误映射
    // （SidecarError → §0.2 REST 状态码，见 sidecar/errors.ts 的 sidecarCall）。
    ok(res, await sidecarCall(sidecar.listRegistries()))
  } catch (err) {
    handleError(res, err)
  }
})
