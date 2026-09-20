/**
 * 地图工具 REST 路由（S5-A，挂载于 /api/maps）。
 *
 * - GET  /api/maps?source=               → 双源 registry 列表（保留声明顺序）
 * - GET  /api/maps/entity-rules?source=  → entity-rules.json 原样 JSON
 * - POST /api/maps/:key/geometry {source} → SerializedMapGeometry（与本体 /maps/runtime 同形）
 * - GET  /api/maps/:key/export?source=&format=png|json&palette=<base64 JSON> → attachment 下载
 *
 * palette：base64(JSON)，形如 {"1":[92,148,80],"2":[30,60,30,255]}，解析失败 → 400。
 * 导出走每请求独立临时目录（os tmp），响应后立即清理。
 */
import { Router } from 'express'
import type { Request, Response } from 'express'

import { mapService } from '../services/mapService.js'
import { handleError, ok } from './helpers.js'

export const mapsRouter = Router()

/** GET /api/maps?source= → 列表。 */
mapsRouter.get('/', async (req: Request, res: Response) => {
  try {
    ok(res, await mapService.listMaps(req.query.source))
  } catch (err) {
    handleError(res, err)
  }
})

/** GET /api/maps/entity-rules?source= → 演化规则原样 JSON（需在 :key 路由前注册）。 */
mapsRouter.get('/entity-rules', async (req: Request, res: Response) => {
  try {
    ok(res, await mapService.entityRules(req.query.source))
  } catch (err) {
    handleError(res, err)
  }
})

/** POST /api/maps/:key/geometry {source} → 几何快照。 */
mapsRouter.post('/:key/geometry', async (req: Request<{ key: string }>, res: Response) => {
  try {
    ok(res, await mapService.geometry(req.params.key, req.body?.source))
  } catch (err) {
    handleError(res, err)
  }
})

/** GET /api/maps/:key/export?source=&format=&palette= → attachment 下载。 */
mapsRouter.get('/:key/export', async (req: Request<{ key: string }>, res: Response) => {
  let dir: string | null = null
  try {
    const out = await mapService.exportMap(
      req.params.key,
      req.query.source,
      typeof req.query.format === 'string' ? req.query.format : undefined,
      typeof req.query.palette === 'string' ? req.query.palette : undefined,
    )
    dir = out.dir
    const content = await (await import('node:fs/promises')).readFile(out.filePath)
    res.setHeader('Content-Type', out.contentType)
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${out.filename}"; filename*=UTF-8''${encodeURIComponent(out.filename)}`,
    )
    res.send(content)
  } catch (err) {
    handleError(res, err)
  } finally {
    if (dir) {
      await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
})
