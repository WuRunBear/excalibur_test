/**
 * 配置 schema store（P1）。
 *
 * 一次拉取 GET games/:gameId/schemas（{ [schemaKind]: JSON Schema }），按 kind 缓存；
 * load() 幂等——已加载直接返回缓存、并发调用共享同一次请求。加载失败仅记录 error
 * 并保留 loaded=false（下次调用可重试），不抛出。
 *
 * 管理目标切换（games.epoch 自增）→ reset 清空缓存，避免跨游戏串 schema
 * （对齐 stores/config.ts:170-178、stores/map.ts 的防串模式）；视图重挂载后
 * 重新 load()。
 */
import { ref, watch } from 'vue'
import { defineStore } from 'pinia'

import { fetchSchemas } from '@/api/admin'
import type { JsonSchemaValue } from '@/api/admin'
import { useGamesStore } from '@/stores/games'

export const useSchemasStore = defineStore('admin-schemas', () => {
  /** 按 schemaKind 缓存的 JSON Schema。 */
  const schemas = ref<Record<string, JsonSchemaValue>>({})
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref<string | null>(null)

  /** 进行中的请求；并发 load() 共享，避免重复请求。 */
  let inflight: Promise<Record<string, JsonSchemaValue>> | null = null

  /** 拉取全部 schema；已有数据直接返回，不重复请求。失败时记录 error 且可重试。 */
  async function load(): Promise<Record<string, JsonSchemaValue>> {
    if (loaded.value) return schemas.value
    if (inflight) return inflight
    inflight = (async () => {
      loading.value = true
      error.value = null
      try {
        schemas.value = await fetchSchemas()
        loaded.value = true
      } catch (err) {
        error.value = err instanceof Error ? err.message : '获取配置 schema 失败'
      } finally {
        loading.value = false
        inflight = null
      }
      return schemas.value
    })()
    return inflight
  }

  /** 按 schemaKind 取用；未加载 / 无此 kind 时返回 null。 */
  function byKind(kind: string): JsonSchemaValue | null {
    return schemas.value[kind] ?? null
  }

  /** 切换管理目标时清空缓存（游戏间 schema 不通用）。 */
  function reset(): void {
    schemas.value = {}
    loading.value = false
    loaded.value = false
    error.value = null
    inflight = null
  }

  // T2.10：games.epoch 自增 → 清空 schema 缓存；视图重挂载后以新 gameId 重取。
  const gamesStore = useGamesStore()
  watch(
    () => gamesStore.epoch,
    () => {
      reset()
    },
  )

  return {
    schemas,
    loading,
    loaded,
    error,
    load,
    byKind,
    reset,
  }
})
