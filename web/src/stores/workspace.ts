/**
 * 工作区 store（S2-B）。
 *
 * 列表 / 活动工作区 / 新建（自动激活）/ 激活 / 重命名 / 删除（本体无痕）；
 * 反馈走 ElMessage，列表加载错误经 lastError 供视图渲染空态与重试。
 */
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'

import {
  activateWorkspace,
  AdminApiError,
  createWorkspace,
  deleteWorkspace,
  fetchWorkspaces,
  renameWorkspace,
} from '@/api/admin'
import type { WorkspaceMeta } from '@/api/admin'
import { useGamesStore } from '@/stores/games'

function errorText(err: unknown, fallback: string): string {
  return err instanceof AdminApiError ? err.message : fallback
}

export const useWorkspaceStore = defineStore('admin-workspace', () => {
  const items = ref<WorkspaceMeta[]>([])
  const activeId = ref<string | null>(null)
  const loading = ref(false)
  const loaded = ref(false)
  const lastError = ref<string | null>(null)
  /** 任一变更操作（新建 / 激活 / 重命名 / 删除）在途。 */
  const mutating = ref(false)

  const activeWorkspace = computed<WorkspaceMeta | null>(
    () => items.value.find((item) => item.id === activeId.value) ?? null,
  )

  function applyList(list: Awaited<ReturnType<typeof fetchWorkspaces>>): void {
    items.value = list.items
    activeId.value = list.activeId
    lastError.value = null
  }

  /** 拉取列表（带 loading 与错误记录，供空态 / 重试渲染）。 */
  async function load(): Promise<void> {
    loading.value = true
    try {
      applyList(await fetchWorkspaces())
      loaded.value = true
    } catch (err) {
      lastError.value = errorText(err, '获取工作区列表失败')
    } finally {
      loading.value = false
    }
  }

  /** 静默刷新（不打 loading / 错误态；保存后同步改动数等场景）。 */
  async function refresh(): Promise<void> {
    try {
      applyList(await fetchWorkspaces())
      loaded.value = true
    } catch {
      // 静默失败：保留现有列表，下次操作或手动刷新再试。
    }
  }

  /** 首次进入加载（幂等）。 */
  async function ensureLoaded(): Promise<void> {
    if (loaded.value || loading.value) return
    await load()
  }

  // T2.10：管理目标切换（games.epoch 自增）→ 清空列表与活动标记；
  // 工作区视图重挂载后 ensureLoaded 以新 gameId 重取。
  const gamesStore = useGamesStore()
  watch(
    () => gamesStore.epoch,
    () => {
      items.value = []
      activeId.value = null
      loaded.value = false
      lastError.value = null
    },
  )

  /** 新建工作区（后端自动激活）：本地同步 items 与 activeId。 */
  async function create(name: string): Promise<boolean> {
    if (mutating.value) return false
    mutating.value = true
    try {
      const meta = await createWorkspace(name)
      const index = items.value.findIndex((item) => item.id === meta.id)
      if (index >= 0) items.value[index] = meta
      else items.value = [meta, ...items.value]
      activeId.value = meta.id
      lastError.value = null
      ElMessage.success(`工作区「${name}」已创建并激活`)
      return true
    } catch (err) {
      ElMessage.error(errorText(err, '创建工作区失败'))
      return false
    } finally {
      mutating.value = false
    }
  }

  /** 激活（切换）工作区。 */
  async function activate(id: string): Promise<boolean> {
    if (mutating.value) return false
    mutating.value = true
    try {
      const meta = await activateWorkspace(id)
      const index = items.value.findIndex((item) => item.id === meta.id)
      if (index >= 0) items.value[index] = meta
      activeId.value = meta.id
      ElMessage.success(`已切换到「${meta.name}」`)
      return true
    } catch (err) {
      ElMessage.error(errorText(err, '切换工作区失败'))
      return false
    } finally {
      mutating.value = false
    }
  }

  /** 重命名工作区。 */
  async function rename(id: string, name: string): Promise<boolean> {
    if (mutating.value) return false
    mutating.value = true
    try {
      const meta = await renameWorkspace(id, name)
      const index = items.value.findIndex((item) => item.id === meta.id)
      if (index >= 0) items.value[index] = meta
      ElMessage.success(`已重命名为「${meta.name}」`)
      return true
    } catch (err) {
      ElMessage.error(errorText(err, '重命名失败'))
      return false
    } finally {
      mutating.value = false
    }
  }

  /** 删除工作区（仅隔离副本，本体无痕）；若删除的是活动工作区则清空活动标记。 */
  async function remove(id: string): Promise<boolean> {
    if (mutating.value) return false
    mutating.value = true
    try {
      const { id: removedId } = await deleteWorkspace(id)
      const removed = items.value.find((item) => item.id === removedId)
      items.value = items.value.filter((item) => item.id !== removedId)
      if (activeId.value === removedId) activeId.value = null
      ElMessage.success(`工作区「${removed?.name ?? removedId}」已删除`)
      return true
    } catch (err) {
      ElMessage.error(errorText(err, '删除工作区失败'))
      return false
    } finally {
      mutating.value = false
    }
  }

  return {
    items,
    activeId,
    loading,
    loaded,
    lastError,
    mutating,
    activeWorkspace,
    load,
    refresh,
    ensureLoaded,
    create,
    activate,
    rename,
    remove,
  }
})
