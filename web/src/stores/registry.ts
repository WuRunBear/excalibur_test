/**
 * 注册表 store（S6-B）。
 * 五类注册表一次拉取；条目形状宽容（归一化在 utils/registry.ts）。
 */
import { ref, watch } from 'vue'
import { defineStore } from 'pinia'

import { fetchRegistries } from '@/api/admin'
import type { RegistriesPayload } from '@/api/admin'
import { useGamesStore } from '@/stores/games'

export const useRegistryStore = defineStore('admin-registry', () => {
  const data = ref<RegistriesPayload | null>(null)
  const loading = ref(false)
  const lastError = ref<string | null>(null)
  const loaded = ref(false)

  async function load(): Promise<void> {
    if (loading.value) return
    loading.value = true
    lastError.value = null
    try {
      data.value = await fetchRegistries()
      loaded.value = true
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : '获取注册表失败'
    } finally {
      loading.value = false
    }
  }

  async function ensureLoaded(): Promise<void> {
    if (!loaded.value && !loading.value) await load()
  }

  // T2.10：管理目标切换（games.epoch 自增）→ 清空五类清单；
  // 注册表视图重挂载后 ensureLoaded 以新 gameId 重取。
  const gamesStore = useGamesStore()
  watch(
    () => gamesStore.epoch,
    () => {
      data.value = null
      loaded.value = false
      lastError.value = null
    },
  )

  return { data, loading, lastError, loaded, load, ensureLoaded }
})
