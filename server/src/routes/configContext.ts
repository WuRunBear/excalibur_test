/**
 * 配置上下文 REST 路由（S3-A，挂载于 /api/config-context）。
 *
 * GET /api/config-context → 本体 game/ 与活动工作区的清单级同步状态：
 * - official：本体 game/ 当前清单（fingerprint 与工作区基线同算法，sha256 前 16 位）
 * - workspace：活动工作区当前清单；无活动工作区 / 已被删 → null
 * - inSync：两侧 fingerprint 一致；workspace 为 null → true
 * - changes：活动工作区 vs 本体 game/ 逐文件对比（S4 落盘 diff 的基础）；无工作区 → []
 */
import { Router } from 'express'
import type { Request, Response } from 'express'

import { gameConfigsDir } from '../config.js'
import { workspaceService } from '../services/workspaceService.js'
import type { ConfigContextPayload } from '../types.js'
import { handleError, ok } from './helpers.js'

export const configContextRouter = Router()

configContextRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const official = await workspaceService.describeDir(gameConfigsDir)
    const workspace = await workspaceService.describeActiveWorkspaceGame()
    const changes = workspace ? await workspaceService.diffAgainstSource() : []

    const payload: ConfigContextPayload = {
      official: { fingerprint: official.fingerprint, fileCount: official.fileCount },
      workspace,
      inSync: workspace ? workspace.fingerprint === official.fingerprint : true,
      changes,
    }
    ok(res, payload)
  } catch (err) {
    handleError(res, err)
  }
})
