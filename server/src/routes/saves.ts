/**
 * 存档管理 REST 路由（S6-A，挂载于 /api/saves）。
 *
 * scope：'official'（缺省）| 'preview'。
 * - GET    /api/saves?scope=              → 列表 + summary
 * - GET    /api/saves/:file/detail?scope= → maps 键 + topKinds
 * - DELETE /api/saves/:file?scope=        → 删除（白名单 + 穿越防护）
 * - GET    /api/saves/:file/download?scope= → attachment
 * - POST   /api/saves/:file/restore?scope= → 复制为 <saveId>.json（saveId 读本体 rules/server.json）
 */
import { Router } from 'express'
import type { Request, Response } from 'express'

import { saveService } from '../services/saveService.js'
import { handleError, ok } from './helpers.js'

export const savesRouter = Router()

/** GET /api/saves?scope= → 列表。 */
savesRouter.get('/', async (req: Request, res: Response) => {
  try {
    ok(res, await saveService.list(req.query.scope))
  } catch (err) {
    handleError(res, err)
  }
})

/** GET /api/saves/:file/detail?scope= → 详情。 */
savesRouter.get('/:file/detail', async (req: Request<{ file: string }>, res: Response) => {
  try {
    ok(res, await saveService.detail(req.params.file, req.query.scope))
  } catch (err) {
    handleError(res, err)
  }
})

/** DELETE /api/saves/:file?scope= → 删除。 */
savesRouter.delete('/:file', async (req: Request<{ file: string }>, res: Response) => {
  try {
    ok(res, await saveService.remove(req.params.file, req.query.scope))
  } catch (err) {
    handleError(res, err)
  }
})

/** GET /api/saves/:file/download?scope= → attachment 传输。 */
savesRouter.get('/:file/download', async (req: Request<{ file: string }>, res: Response) => {
  try {
    const out = await saveService.readForDownload(req.params.file, req.query.scope)
    res.setHeader('Content-Type', out.contentType)
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${out.filename}"; filename*=UTF-8''${encodeURIComponent(out.filename)}`,
    )
    res.send(out.content)
  } catch (err) {
    handleError(res, err)
  }
})

/** POST /api/saves/:file/restore?scope= → 设为活跃存档。 */
savesRouter.post('/:file/restore', async (req: Request<{ file: string }>, res: Response) => {
  try {
    ok(res, await saveService.restore(req.params.file, req.query.scope))
  } catch (err) {
    handleError(res, err)
  }
})
