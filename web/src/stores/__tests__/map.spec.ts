import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  fetchMaps: vi.fn(),
  fetchEntityRules: vi.fn(),
}))

vi.mock('@/api/admin', () => ({
  fetchMaps: mocks.fetchMaps,
  fetchEntityRules: mocks.fetchEntityRules,
}))

import { useMapStore } from '@/stores/map'
import type { MapsPayload } from '@/api/admin'

function mapsPayload(overrides: Partial<MapsPayload> = {}): MapsPayload {
  return {
    source: 'official',
    maps: [
      { key: 'home', kind: 'pipeline', seed: 7, pipeline: [{ generator: 'noise-terrain' }] },
      { key: 'tiled-level', kind: 'tiled' },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.fetchMaps.mockReset()
  mocks.fetchEntityRules.mockReset()
})

describe('useMapStore', () => {
  it('loadMaps 拉取清单并选中第一张', async () => {
    mocks.fetchMaps.mockResolvedValue(mapsPayload())
    const store = useMapStore()
    await store.loadMaps()
    expect(store.maps).toHaveLength(2)
    expect(store.selectedKey).toBe('home')
    expect(store.mapsError).toBeNull()
  })

  it('选中图不在新清单时回退到第一张', async () => {
    mocks.fetchMaps.mockResolvedValue(mapsPayload())
    const store = useMapStore()
    await store.loadMaps()
    store.select('tiled-level')

    store.setSource('workspace')
    mocks.fetchMaps.mockResolvedValue(
      mapsPayload({ source: 'workspace', maps: [{ key: 'home', kind: 'pipeline' }] }),
    )
    await store.loadMaps()
    expect(store.selectedKey).toBe('home')
  })

  it('规则按源缓存：同源只拉一次', async () => {
    mocks.fetchEntityRules.mockResolvedValue({ source: 'official', rules: { entries: [] } })
    const store = useMapStore()
    await store.loadRules('official')
    await store.loadRules('official')
    expect(mocks.fetchEntityRules).toHaveBeenCalledTimes(1)
    expect(store.rules.official).toEqual({ entries: [] })
  })

  it('规则拉取失败静默降级为 null（不阻塞地图预览）', async () => {
    mocks.fetchEntityRules.mockRejectedValue(new Error('boom'))
    const store = useMapStore()
    await store.loadRules('official')
    await nextTick()
    expect(store.rules.official).toBeNull()
  })
})
