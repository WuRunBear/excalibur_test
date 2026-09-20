/**
 * 进程管理 REST 路由（S1-C，挂载于 /api/instances）。
 *
 * 统一响应结构：
 * - 成功：{ code: 0, message: 'ok', detail }
 * - 失败：{ code: 1, message, detail? }，并携带对应 HTTP 状态码
 *   （400 非法 role/参数；409 状态冲突；500 其余内部错误）。
 */
import { Router } from 'express'
import type { Request, Response } from 'express'

import { getInstanceManager, isInstanceRole } from '../services/instanceManager.js'
import { logStream } from '../services/logStream.js'
import type { InstanceRole } from '../types.js'
import { fail, handleError, ok } from './helpers.js'

export const processRouter = Router()

/** 校验 :role 参数，非法时返回 false（已写 400 响应）。 */
function checkRole(res: Response, role: string): role is InstanceRole {
  if (isInstanceRole(role)) return true
  fail(res, 400, `invalid role "${role}" (expected "official" | "preview")`)
  return false
}

/** GET /api/instances → 双角色状态快照。 */
processRouter.get('/', (_req: Request, res: Response) => {
  ok(res, {
    official: getInstanceManager('official').snapshot,
    preview: getInstanceManager('preview').snapshot,
  })
})

/** GET /api/instances/:role → 单角色状态快照。 */
processRouter.get('/:role', (req: Request<{ role: string }>, res: Response) => {
  const role = req.params.role
  if (!checkRole(res, role)) return
  ok(res, getInstanceManager(role).snapshot)
})

/** POST /api/instances/:role/start → 启动实例。 */
processRouter.post('/:role/start', async (req: Request<{ role: string }>, res: Response) => {
  const role = req.params.role
  if (!checkRole(res, role)) return
  try {
    ok(res, await getInstanceManager(role).start())
  } catch (err) {
    handleError(res, err)
  }
})

/** POST /api/instances/:role/stop → 停止实例（树杀，等待退出归因）。 */
processRouter.post('/:role/stop', async (req: Request<{ role: string }>, res: Response) => {
  const role = req.params.role
  if (!checkRole(res, role)) return
  try {
    ok(res, await getInstanceManager(role).stop())
  } catch (err) {
    handleError(res, err)
  }
})

/** POST /api/instances/:role/restart → 重启实例（stop 完成后 start）。 */
processRouter.post('/:role/restart', async (req: Request<{ role: string }>, res: Response) => {
  const role = req.params.role
  if (!checkRole(res, role)) return
  try {
    ok(res, await getInstanceManager(role).restart())
  } catch (err) {
    handleError(res, err)
  }
})

/** GET /api/instances/:role/logs?lines=200 → 环形缓冲最近 N 行（前端初始化回填）。 */
processRouter.get('/:role/logs', (req: Request<{ role: string }>, res: Response) => {
  const role = req.params.role
  if (!checkRole(res, role)) return
  const raw = Number(req.query.lines)
  const lines = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200
  ok(res, { role, lines: logStream.getRecent(role, lines) })
})
