/**
 * REST 路由公共响应助手（S1-C 抽取，S2-A 起供全部路由复用）。
 *
 * 统一响应结构：
 * - 成功：{ code: 0, message: 'ok', detail }
 * - 失败：{ code: 1, message, detail? }，携带对应 HTTP 状态码。
 */
import type { Response } from 'express'

import { ValidationFailedError } from '../services/configService.js'
import { ConflictError } from '../services/instanceManager.js'
import { WorkspaceError } from '../services/workspaceService.js'

/** 成功响应。 */
export function ok(res: Response, detail: unknown): void {
  res.json({ code: 0, message: 'ok', detail })
}

/** 错误响应。 */
export function fail(res: Response, status: number, message: string, detail?: unknown): void {
  res.status(status).json({ code: 1, message, ...(detail !== undefined ? { detail } : {}) })
}

/**
 * 统一异常映射：
 * - ConflictError（进程状态冲突）→ 409
 * - ConfigValidationError → 422（detail.errors 携带校验明细）
 * - WorkspaceError → 其自带 status（400/404/500）
 * - 其余 → 500
 */
export function handleError(res: Response, err: unknown): void {
  if (err instanceof ConflictError) {
    fail(res, err.status, err.message)
    return
  }
  if (err instanceof ValidationFailedError) {
    fail(res, 422, err.message, { errors: err.errors })
    return
  }
  if (err instanceof WorkspaceError) {
    fail(res, err.status, err.message)
    return
  }
  console.error('[routes] unexpected error:', err)
  fail(res, 500, err instanceof Error ? err.message : String(err))
}
