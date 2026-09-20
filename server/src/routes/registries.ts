/**
 * 注册表 REST 路由（S6-A，挂载于 /api/registries）。
 *
 * GET /api/registries → bootstrap 后五类注册表；验收基准 = 本体
 * `pnpm tools list-registries` 输出（数量/条目 id 一致）。
 * components 只取键（值置 null，避免序列化组件定义的巨大输出）；
 * mapGenerators 取条目 id（积木函数不可序列化）。
 */
import { Router } from 'express'
import type { Request, Response } from 'express'

import {
  bootstrapFramework,
  listRegisteredActions,
  listRegisteredArchetypes,
  listRegisteredComponents,
  listRegisteredMapGenerators,
  listRegisteredSystems,
} from '../../gameBridge/index.js'
import type { RegistriesPayload } from '../types.js'
import { handleError, ok } from './helpers.js'

export const registriesRouter = Router()

registriesRouter.get('/', async (_req: Request, res: Response) => {
  try {
    bootstrapFramework()
    const payload: RegistriesPayload = {
      systems: listRegisteredSystems(),
      archetypes: listRegisteredArchetypes(),
      actions: listRegisteredActions(),
      components: Object.fromEntries(
        Object.keys(listRegisteredComponents()).map((k) => [k, null]),
      ) as Record<string, null>,
      mapGenerators: listRegisteredMapGenerators().map((g) => ({ id: g.id })),
    }
    ok(res, payload)
  } catch (err) {
    handleError(res, err)
  }
})
