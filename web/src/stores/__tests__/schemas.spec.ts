import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  fetchSchemas: vi.fn(),
}))

vi.mock('@/api/admin', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/admin')>()
  return {
    ...original,
    fetchSchemas: mocks.fetchSchemas,
  }
})

import { useSchemasStore } from '@/stores/schemas'
import { useGamesStore } from '@/stores/games'
import type { JsonSchemaValue } from '@/api/admin'

function schemasPayload(): Record<string, JsonSchemaValue> {
  return {
    GameDefinition: {
      type: 'object',
      properties: { title: { type: 'string', description: '游戏标题' } },
    },
    Archetype: { type: 'object', properties: { hp: { type: 'number' } } },
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.fetchSchemas.mockReset()
})

describe('useSchemasStore', () => {
  it('load 拉取并按 kind 缓存：重复调用不重复请求', async () => {
    mocks.fetchSchemas.mockResolvedValue(schemasPayload())
    const store = useSchemasStore()

    await store.load()
    expect(store.loaded).toBe(true)
    expect(store.error).toBeNull()
    expect(store.byKind('GameDefinition')?.type).toBe('object')

    await store.load()
    expect(mocks.fetchSchemas).toHaveBeenCalledTimes(1)
  })

  it('并发 load 共享同一次请求', async () => {
    mocks.fetchSchemas.mockResolvedValue(schemasPayload())
    const store = useSchemasStore()

    const [a, b] = await Promise.all([store.load(), store.load()])
    expect(mocks.fetchSchemas).toHaveBeenCalledTimes(1)
    expect(a).toEqual(schemasPayload())
    expect(b).toEqual(schemasPayload())
  })

  it('byKind 未加载 / 未知 kind 返回 null', async () => {
    const store = useSchemasStore()
    expect(store.byKind('GameDefinition')).toBeNull()

    mocks.fetchSchemas.mockResolvedValue(schemasPayload())
    await store.load()
    expect(store.byKind('Archetype')?.type).toBe('object')
    expect(store.byKind('NotRegistered')).toBeNull()
  })

  it('加载失败记录错误态且不抛出，可重试', async () => {
    mocks.fetchSchemas.mockRejectedValue(new Error('sidecar 未就绪'))
    const store = useSchemasStore()

    const result = await store.load()
    expect(result).toEqual({})
    expect(store.error).toBe('sidecar 未就绪')
    expect(store.loaded).toBe(false)
    expect(store.byKind('GameDefinition')).toBeNull()

    mocks.fetchSchemas.mockResolvedValue(schemasPayload())
    await store.load()
    expect(mocks.fetchSchemas).toHaveBeenCalledTimes(2)
    expect(store.loaded).toBe(true)
    expect(store.error).toBeNull()
  })

  it('games.epoch 变更时 reset：清空缓存并按新 gameId 重取', async () => {
    mocks.fetchSchemas.mockResolvedValue(schemasPayload())
    const store = useSchemasStore()
    const gamesStore = useGamesStore()

    await store.load()
    expect(store.loaded).toBe(true)

    gamesStore.epoch += 1
    await nextTick()
    expect(store.schemas).toEqual({})
    expect(store.loaded).toBe(false)
    expect(store.byKind('GameDefinition')).toBeNull()

    await store.load()
    expect(mocks.fetchSchemas).toHaveBeenCalledTimes(2)
    expect(store.byKind('Archetype')?.type).toBe('object')
  })
})
