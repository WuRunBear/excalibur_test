/**
 * 落盘（Apply）与备份 REST 路由（S4-A）。
 *
 * applyRouter 挂载于 /api/apply：
 * - POST /plan           → 对当前全部 changes 出计划（只读）
 * - POST /execute {paths} → 备份 → 写回本体 → 刷新工作区基线（安全性守卫见 applyService）
 *
 * backupsRouter 挂载于 /api/backups：
 * - GET  /:root            → 备份列表（createdAt 倒序，manifest 容错缺失）
 * - POST /:backupId/rollback → 完整逆操作（与 execute 共用互斥）
 */
import { Router } from 'express'
import type { Request, Response } from 'express'

import { applyService } from '../services/applyService.js'
import { fail, handleError, ok } from './helpers.js'

export const applyRouter = Router()
export const backupsRouter = Router()

/** POST /api/apply/plan → 落盘计划（含 diff/统计/文件级校验）。 */
applyRouter.post('/plan', async (_req: Request, res: Response) => {
  try {
    ok(res, await applyService.plan())
  } catch (err) {
    handleError(res, err)
  }
})

/** POST /api/apply/execute {paths: string[]} → 执行落盘。 */
applyRouter.post('/execute', async (req: Request, res: Response) => {
  try {
    const paths = req.body?.paths
    if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== 'string' || !p.trim())) {
      fail(res, 400, 'paths 必须为非空字符串数组')
      return
    }
    ok(res, await applyService.execute(paths))
  } catch (err) {
    handleError(res, err)
  }
})

/** GET /api/backups → 备份列表。 */
backupsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    ok(res, await applyService.listBackups())
  } catch (err) {
    handleError(res, err)
  }
})

/** POST /api/backups/:backupId/rollback → 回滚。 */
backupsRouter.post('/:backupId/rollback', async (req: Request<{ backupId: string }>, res: Response) => {
  try {
    ok(res, await applyService.rollback(req.params.backupId))
  } catch (err) {
    handleError(res, err)
  }
})
