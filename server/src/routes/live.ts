/**
 * liveState REST 路由（S7-A，挂载于 /api/live）。
 *
 * GET /api/live/samples?role=official|preview&limit=120 →
 * detail { role, samples: [...最新 N 条，旧→新] }（limit 夹取 1..300）。
 * 供前端初始化回填；实时增量走 ws 频道 live:{role}。
 */
import { Router } from 'express'
import type { Request, Response } from 'express'

import { isInstanceRole } from '../services/instanceManager.js'
import { liveState } from '../services/liveState.js'
import { fail, handleError, ok } from './helpers.js'

export const liveRouter = Router()

liveRouter.get('/samples', (req: Request, res: Response) => {
  try {
    const role = String(req.query.role ?? '')
    if (!isInstanceRole(role)) {
      fail(res, 400, `invalid role "${role}" (expected "official" | "preview")`)
      return
    }
    const raw = Number(req.query.limit)
    const limit = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120
    ok(res, { role, samples: liveState.getSamples(role, limit) })
  } catch (err) {
    handleError(res, err)
  }
})
