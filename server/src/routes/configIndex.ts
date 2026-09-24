/**
 * 配置引用索引 REST 路由（P1，挂载于 /api/games/:gameId/config-index）。
 *
 * GET / → `{ items, dialogues, quests, mapKeys, archetypes }`：引用型字段下拉数据，
 * 全部来自活动工作区的配置文件本身。复用 configService.tree() + readFile() 遍历
 * 活动工作区 game/，抽取逻辑对照本体仓实际配置文件格式与 configService.
 * routeSchemaKind 映射表：
 *   - entities/*.json（routeSchemaKind=Archetype）→ 每文件单个 Archetype 对象，取 `kind`；
 *   - maps/registry.json（routeSchemaKind=MapRegistry）→ `maps` 表键；
 *   - items/*.json      → 单个 ItemKind 对象，取 `kind`（缺失回退文件名去后缀）；
 *   - dialogues/*.json  → 根 `trees[]`，取每棵树的 `id`（treeId）；
 *   - quests/*.json     → 根 `quests[]`，取每条任务的 `id`。
 * items/dialogues/quests 未登记于 schemaRoutes（不参与单文件 zod 校验），故按路径
 * 前缀识别；entities/maps 以 routeSchemaKind 为准（尊重活动工作区的路由表）。
 *
 * 带简单 mtime 缓存：按活动工作区 gameDir + 相关目录/文件 mtime 指纹缓存抽取结果；
 * 指纹变化（编辑配置/切换工作区）即重算。后端校验逻辑零改动。
 */
import fs from 'node:fs'
import path from 'node:path'

import { Router } from 'express'
import type { Request, Response } from 'express'

import { routeSchemaKind } from '../services/configService.js'
import type { ConfigTreeNode } from '../types.js'
import { handleError, ok, servicesForRequest } from './helpers.js'

/** 引用索引结果（与 web ConfigIndexPayload 对齐）。 */
export interface ConfigIndex {
  items: string[]
  dialogues: string[]
  quests: string[]
  mapKeys: string[]
  archetypes: string[]
}

/** 读文件相对内容；不存在/读失败返回 null（抽取时跳过该文件）。 */
export interface ConfigIndexReader {
  readFile(rel: string): Promise<{ content: string } | null>
}

/** 复用的路径识别（本体 game/ 目录约定）。 */
const ITEMS_RE = /^items\/[^/]+\.json$/
const DIALOGUES_RE = /^dialogues\/[^/]+\.json$/
const QUESTS_RE = /^quests\/[^/]+\.json$/

function collectFiles(node: ConfigTreeNode, out: string[]): void {
  if (node.type === 'file') {
    out.push(node.path)
    return
  }
  for (const child of node.children ?? []) collectFiles(child, out)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function pickStringIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    const rec = asRecord(entry)
    const id = rec?.[field]
    if (typeof id === 'string' && id.length > 0) out.push(id)
  }
  return out
}

/**
 * 抽取引用索引（纯函数：注入 tree + readFile，便于冒烟直测）。
 * 结果各数组去重后按字典序排序，保证稳定输出。
 */
export async function extractConfigIndex(
  tree: ConfigTreeNode,
  readFile: ConfigIndexReader['readFile'],
  schemaKindOf: (rel: string) => string | null = () => null,
): Promise<ConfigIndex> {
  const files: string[] = []
  collectFiles(tree, files)

  const items = new Set<string>()
  const dialogues = new Set<string>()
  const quests = new Set<string>()
  const mapKeys = new Set<string>()
  const archetypes = new Set<string>()

  const readJson = async (rel: string): Promise<unknown | null> => {
    const file = await readFile(rel)
    if (!file) return null
    try {
      return JSON.parse(file.content)
    } catch (err) {
      console.error(`[config-index] JSON 解析失败，跳过 ${rel}:`, err)
      return null
    }
  }

  for (const rel of files) {
    const kind = schemaKindOf(rel)
    if (kind === 'MapRegistry') {
      const rec = asRecord(await readJson(rel))
      const maps = rec ? asRecord(rec.maps) : null
      if (maps) for (const key of Object.keys(maps)) mapKeys.add(key)
      continue
    }
    if (kind === 'Archetype') {
      const rec = asRecord(await readJson(rel))
      if (rec && typeof rec.kind === 'string' && rec.kind.length > 0) archetypes.add(rec.kind)
      continue
    }
    if (ITEMS_RE.test(rel)) {
      const rec = asRecord(await readJson(rel))
      const kindName = rec && typeof rec.kind === 'string' && rec.kind.length > 0 ? rec.kind : null
      if (kindName) items.add(kindName)
      else items.add(path.basename(rel, '.json'))
      continue
    }
    if (DIALOGUES_RE.test(rel)) {
      const rec = asRecord(await readJson(rel))
      if (rec) for (const id of pickStringIds(rec.trees, 'id')) dialogues.add(id)
      continue
    }
    if (QUESTS_RE.test(rel)) {
      const rec = asRecord(await readJson(rel))
      if (rec) for (const id of pickStringIds(rec.quests, 'id')) quests.add(id)
      continue
    }
  }

  const sorted = (set: Set<string>): string[] => [...set].sort((a, b) => a.localeCompare(b))
  return {
    items: sorted(items),
    dialogues: sorted(dialogues),
    quests: sorted(quests),
    mapKeys: sorted(mapKeys),
    archetypes: sorted(archetypes),
  }
}

// ---------------------------------------------------------------------------
// mtime 缓存
// ---------------------------------------------------------------------------

interface CacheSlot {
  fingerprint: string
  value: ConfigIndex
}

const CACHE = new Map<string, CacheSlot>()

/** 相关目录/文件指纹（含目录条目 mtime，覆盖增删与内容修改；切换工作区路径不同即失效）。 */
function fingerprintOf(gameDir: string): string {
  const roots = ['game.json', 'items', 'dialogues', 'quests', 'entities', 'maps/registry.json']
  const parts: string[] = [gameDir]
  for (const rel of roots) {
    const abs = path.join(gameDir, rel)
    try {
      const st = fs.statSync(abs)
      if (st.isDirectory()) {
        const names = fs.readdirSync(abs).sort()
        const entries = names.map((name) => {
          try {
            const child = fs.statSync(path.join(abs, name))
            return `${name}@${child.mtimeMs}:${child.size}`
          } catch {
            return name
          }
        })
        parts.push(`${rel}:${st.mtimeMs}:${entries.join(',')}`)
      } else {
        parts.push(`${rel}:${st.mtimeMs}:${st.size}`)
      }
    } catch {
      parts.push(`${rel}:-`)
    }
  }
  return parts.join('|')
}

export const configIndexRouter = Router()

configIndexRouter.get('/', async (req: Request, res: Response) => {
  try {
    const services = servicesForRequest(req)
    const { gameDir } = await services.workspace.requireActiveGameDir()
    const fingerprint = fingerprintOf(gameDir)
    const cached = CACHE.get(req.gameId)
    if (cached && cached.fingerprint === fingerprint) {
      ok(res, cached.value)
      return
    }
    const { tree } = await services.config.tree()
    const value = await extractConfigIndex(
      tree,
      async (rel) => {
        try {
          const file = await services.config.readFile(rel)
          return { content: file.content }
        } catch {
          return null
        }
      },
      (rel) => routeSchemaKind(rel, services.context),
    )
    CACHE.set(req.gameId, { fingerprint, value })
    ok(res, value)
  } catch (err) {
    handleError(res, err)
  }
})
