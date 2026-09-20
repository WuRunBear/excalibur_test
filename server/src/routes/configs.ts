/**
 * 配置读写 REST 路由（S2-A，挂载于 /api/configs）。
 *
 * 全部作用于活动工作区；无活动工作区 → 400 {code:1, message:'未设置活动工作区'}。
 *
 * 契约：
 * - GET  /api/configs/tree                → { tree: TreeNode }（目录在前、字典序）
 * - GET  /api/configs/file?path=rel       → { path, content, schemaKind }
 * - PUT  /api/configs/file {path,content} → 写盘（json 先语法再 schema 校验）→ { path, valid:true }
 *       语法错误 → 400（message 含行号提示）；schema 不通过 → 422 {detail:{errors}}
 * - POST /api/configs/validate {path,content}   → { schemaKind, valid, errors }（不写盘）
 * - POST /api/configs/validate-all              → { valid, message }（整体校验，不写盘）
 *
 * 路径穿越防护：resolve 后必须落在工作区 game 目录内，越界 → 400。
 */
import { Router } from 'express'
import type { Request, Response } from 'express'

import { configService } from '../services/configService.js'
import { fail, handleError, ok } from './helpers.js'

export const configsRouter = Router()

/** GET /api/configs/tree → 配置文件树。 */
configsRouter.get('/tree', async (_req: Request, res: Response) => {
  try {
    ok(res, await configService.tree())
  } catch (err) {
    handleError(res, err)
  }
})

/** GET /api/configs/file?path=rel → 读文件原文 + schemaKind。 */
configsRouter.get('/file', async (req: Request, res: Response) => {
  try {
    const rel = req.query.path
    if (typeof rel !== 'string' || !rel.trim()) {
      fail(res, 400, 'query path 必须为非空字符串')
      return
    }
    ok(res, await configService.readFile(rel))
  } catch (err) {
    handleError(res, err)
  }
})

/** PUT /api/configs/file {path, content} → 校验后写盘。 */
configsRouter.put('/file', async (req: Request, res: Response) => {
  try {
    const { path: rel, content } = req.body ?? {}
    if (typeof rel !== 'string' || !rel.trim()) {
      fail(res, 400, 'path 必须为非空字符串')
      return
    }
    if (typeof content !== 'string') {
      fail(res, 400, 'content 必须为字符串')
      return
    }
    ok(res, await configService.writeFile(rel, content))
  } catch (err) {
    handleError(res, err)
  }
})

/** POST /api/configs/validate {path, content} → 单文件校验（不写盘）。 */
configsRouter.post('/validate', async (req: Request, res: Response) => {
  try {
    const { path: rel, content } = req.body ?? {}
    if (typeof rel !== 'string' || !rel.trim()) {
      fail(res, 400, 'path 必须为非空字符串')
      return
    }
    if (typeof content !== 'string') {
      fail(res, 400, 'content 必须为字符串')
      return
    }
    ok(res, await configService.validateFile(rel, content))
  } catch (err) {
    handleError(res, err)
  }
})

/** POST /api/configs/validate-all → 活动工作区整体校验（Spike-2 核心函数）。 */
configsRouter.post('/validate-all', async (_req: Request, res: Response) => {
  try {
    ok(res, await configService.validateAll())
  } catch (err) {
    handleError(res, err)
  }
})
