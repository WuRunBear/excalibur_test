/**
 * 存档管理 store（S6-B）。
 *
 * 双 scope（official/preview）清单、详情抽屉、删除 / 恢复；
 * 删除与恢复在 store 内轻提示并刷新清单，confirm 由视图负责。
 */
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'

import { deleteSave, fetchSaveDetail, fetchSaves, restoreSave } from '@/api/admin'
import type { SaveDetailPayload, SaveEntry, SaveScope } from '@/api/admin'
import { useGamesStore } from '@/stores/games'

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

export const useSaveStore = defineStore('admin-save', () => {
  const scope = ref<SaveScope>('official')
  const dir = ref<string | null>(null)
  const saves = ref<SaveEntry[]>([])
  const loading = ref(false)
  const lastError = ref<string | null>(null)
  const loadedFor = ref<SaveScope | null>(null)

  const currentScopeSaves = computed(() => saves.value)
  const parsedCount = computed(() => saves.value.filter((save) => save.summary !== null).length)

  async function load(target: SaveScope = scope.value): Promise<void> {
    if (loading.value) return
    loading.value = true
    lastError.value = null
    try {
      const detail = await fetchSaves(target)
      scope.value = detail.scope
      dir.value = detail.dir
      saves.value = detail.saves
      loadedFor.value = detail.scope
    } catch (err) {
      lastError.value = errorText(err, '获取存档列表失败')
    } finally {
      loading.value = false
    }
  }

  // -- 详情抽屉 -------------------------------------------------------------
  const detailVisible = ref(false)
  const detail = ref<SaveDetailPayload | null>(null)
  const detailLoading = ref(false)

  async function openDetail(file: string): Promise<void> {
    detailVisible.value = true
    detailLoading.value = true
    detail.value = null
    try {
      detail.value = await fetchSaveDetail(file, scope.value)
    } catch (err) {
      ElMessage.error(errorText(err, '获取存档详情失败'))
      detailVisible.value = false
    } finally {
      detailLoading.value = false
    }
  }

  function closeDetail(): void {
    detailVisible.value = false
    detail.value = null
  }

  // T2.10：管理目标切换（games.epoch 自增）→ 清空清单与详情抽屉；
  // 存档视图重挂载后 load 以新 gameId 重取。
  const gamesStore = useGamesStore()
  watch(
    () => gamesStore.epoch,
    () => {
      dir.value = null
      saves.value = []
      lastError.value = null
      loadedFor.value = null
      closeDetail()
    },
  )

  // -- 删除 / 恢复 ----------------------------------------------------------
  async function remove(file: string): Promise<boolean> {
    try {
      await deleteSave(file, scope.value)
      ElMessage.success(`已删除存档 ${file}`)
      void load()
      return true
    } catch (err) {
      ElMessage.error(errorText(err, '删除存档失败'))
      return false
    }
  }

  async function restore(file: string): Promise<boolean> {
    try {
      const detail = await restoreSave(file, scope.value)
      if (detail.warnRestart) {
        ElMessage.warning({
          message: `已恢复为 ${detail.restoredTo}，需重启实例生效`,
          duration: 6000,
        })
      } else {
        ElMessage.success(`已恢复为 ${detail.restoredTo}`)
      }
      void load()
      return true
    } catch (err) {
      ElMessage.error(errorText(err, '恢复存档失败'))
      return false
    }
  }

  return {
    scope,
    dir,
    saves,
    loading,
    lastError,
    loadedFor,
    currentScopeSaves,
    parsedCount,
    load,
    detailVisible,
    detail,
    detailLoading,
    openDetail,
    closeDetail,
    remove,
    restore,
  }
})
