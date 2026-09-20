/**
 * 地图工具 store（S5-B）。
 *
 * 数据源（工作区/本体）切换、地图清单与演化规则的按源缓存；
 * geometry 拉取在视图层直接调 api（每次取最新生成结果，配合「重新生成」语义）。
 */
import { ref } from 'vue'
import { defineStore } from 'pinia'

import { fetchEntityRules, fetchMaps } from '@/api/admin'
import type { MapSource, MapSummary } from '@/api/admin'

export const useMapStore = defineStore('admin-map', () => {
  const source = ref<MapSource>('workspace')
  const maps = ref<MapSummary[]>([])
  const mapsLoading = ref(false)
  const mapsError = ref<string | null>(null)
  const mapsLoadedFor = ref<MapSource | null>(null)

  const selectedKey = ref<string | null>(null)

  /** 演化规则按源缓存（原样 JSON）。 */
  const rules = ref<Partial<Record<MapSource, unknown>>>({})
  const rulesLoading = ref<Partial<Record<MapSource, boolean>>>({})

  function errorText(err: unknown, fallback: string): string {
    return err instanceof Error ? err.message : fallback
  }

  async function loadMaps(): Promise<void> {
    if (mapsLoading.value) return
    mapsLoading.value = true
    mapsError.value = null
    try {
      const detail = await fetchMaps(source.value)
      maps.value = detail.maps
      mapsLoadedFor.value = source.value
      // 当前选中图不在新清单里时回退到第一张
      if (selectedKey.value && !detail.maps.some((map) => map.key === selectedKey.value)) {
        selectedKey.value = detail.maps[0]?.key ?? null
      }
      if (!selectedKey.value) {
        selectedKey.value = detail.maps[0]?.key ?? null
      }
    } catch (err) {
      mapsError.value = errorText(err, '获取地图清单失败')
    } finally {
      mapsLoading.value = false
    }
  }

  /** 首次进入加载（幂等）。 */
  async function ensureMapsLoaded(): Promise<void> {
    if (!mapsLoadedFor.value && !mapsLoading.value) await loadMaps()
  }

  async function loadRules(target: MapSource): Promise<void> {
    if (rulesLoading.value[target] || rules.value[target] !== undefined) return
    rulesLoading.value = { ...rulesLoading.value, [target]: true }
    try {
      rules.value = { ...rules.value, [target]: (await fetchEntityRules(target)).rules }
    } catch {
      // 规则点位是尽力而为的增强：失败静默，不阻塞地图预览
      rules.value = { ...rules.value, [target]: null }
    } finally {
      rulesLoading.value = { ...rulesLoading.value, [target]: false }
    }
  }

  function select(key: string): void {
    selectedKey.value = key
  }

  function setSource(next: MapSource): void {
    source.value = next
  }

  return {
    source,
    maps,
    mapsLoading,
    mapsError,
    mapsLoadedFor,
    selectedKey,
    rules,
    rulesLoading,
    loadMaps,
    ensureMapsLoaded,
    loadRules,
    select,
    setSource,
  }
})
