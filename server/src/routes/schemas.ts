/**
 * 配置 schema REST 路由（P1，挂载于 /api/games/:gameId/schemas）。
 *
 * GET / → `{ [kind]: JsonSchema | null }`：遍历 SCHEMA_TABLE 的 8 个 kind，逐个经
 * sidecar getSchema 聚合 JSON Schema（带 JSDoc description）。
 *
 * 容错（plan §2.1）：单个 kind 失败（driver 异常/超时/未登记）时该 kind 置 null
 * 并记日志，**不整体 500**——前端按 kind 取用，缺失即降级源码模式。
 * 服务端只透传 driver 结果；校验逻辑（zod 终门、applyService）零改动。
 */
import { Router } from 'express'
import type { Request, Response } from 'express'

import { sidecarCall } from '../sidecar/errors.js'
import { handleError, ok, servicesForRequest } from './helpers.js'

/** SCHEMA_TABLE 的 8 个 kind（与 driver SCHEMA_TABLE 键一致；平台侧不持有 zod）。 */
const SCHEMA_KINDS = [
  'GameDefinition',
  'Archetype',
  'MapRegistry',
  'combat',
  'needs',
  'crafting',
  'daynight',
  'server',
] as const

export const schemasRouter = Router()

schemasRouter.get('/', async (req: Request, res: Response) => {
  try {
    const client = servicesForRequest(req).sidecar()
    const payload: Record<string, unknown> = {}
    for (const kind of SCHEMA_KINDS) {
      try {
        const { jsonSchema } = await sidecarCall(client.getSchema({ kind }))
        payload[kind] = jsonSchema
      } catch (err) {
        console.error(`[schemas] 获取 ${kind} schema 失败:`, err)
        payload[kind] = null
      }
    }
    ok(res, payload)
  } catch (err) {
    handleError(res, err)
  }
})
