/**
 * 工作区 REST 路由（S2-A，挂载于 /api/workspaces）。
 *
 * 契约（web 侧按此实现）：
 * - GET    /api/workspaces              → { activeId, items: WorkspaceMeta[] }
 * - POST   /api/workspaces {name}       → WorkspaceMeta（新建后自动设为活动）
 * - POST   /api/workspaces/:id/activate → WorkspaceMeta
 * - PATCH  /api/workspaces/:id {name}   → WorkspaceMeta
 * - DELETE /api/workspaces/:id          → { id }（删活动工作区则 activeId 置 null）
 * - GET    /api/workspaces/:id/changes  → { files: [{path, status}] }
 *
 * 错误：400（参数非法/路径越界）、404（工作区不存在）、422（校验失败，仅 configs 用）、
 * 500（其余）。统一 {code, message, detail?} 结构。
 */
import { Router } from 'express'
import type { Request, Response } from 'express'

import { fail, handleError, ok, servicesForRequest } from './helpers.js'

export const workspaceRouter = Router()

/** GET /api/workspaces → 列表 + 活动工作区。 */
workspaceRouter.get('/', async (req: Request, res: Response) => {
  try {
    ok(res, await servicesForRequest(req).workspace.list())
  } catch (err) {
    handleError(res, err)
  }
})

/** POST /api/workspaces {name} → 新建并激活。 */
workspaceRouter.post('/', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const name = req.body?.name
    if (typeof name !== 'string' || !name.trim()) {
      fail(res, 400, 'name 必须为非空字符串')
      return
    }
    ok(res, await servicesForRequest(req).workspace.create(name))
  } catch (err) {
    handleError(res, err)
  }
})

/** POST /api/workspaces/:id/activate → 设为活动。 */
workspaceRouter.post('/:id/activate', async (req: Request<{ id: string }>, res: Response) => {
  try {
    ok(res, await servicesForRequest(req).workspace.activate(req.params.id))
  } catch (err) {
    handleError(res, err)
  }
})

/** PATCH /api/workspaces/:id {name} → 重命名。 */
workspaceRouter.patch('/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const name = req.body?.name
    if (typeof name !== 'string' || !name.trim()) {
      fail(res, 400, 'name 必须为非空字符串')
      return
    }
    ok(res, await servicesForRequest(req).workspace.rename(req.params.id, name))
  } catch (err) {
    handleError(res, err)
  }
})

/** DELETE /api/workspaces/:id → 删除（活动工作区被删则 activeId 置 null）。 */
workspaceRouter.delete('/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    ok(res, await servicesForRequest(req).workspace.remove(req.params.id))
  } catch (err) {
    handleError(res, err)
  }
})

/** GET /api/workspaces/:id/changes → 当前镜像 vs 基线的文件级变更。 */
workspaceRouter.get('/:id/changes', async (req: Request<{ id: string }>, res: Response) => {
  try {
    ok(res, await servicesForRequest(req).workspace.changes(req.params.id))
  } catch (err) {
    handleError(res, err)
  }
})
