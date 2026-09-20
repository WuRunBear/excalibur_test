/**
 * 配置上下文 store（S3-B）。
 *
 * 持有 GET /api/config-context 的结果（本体 / 工作区清单指纹、inSync、逐文件对比），
 * 供仪表盘配置上下文卡消费。活动工作区变更后自动重取（仅在已被使用过时，
 * 避免无人消费时的后台请求）；保存配置后的最新化由视图挂载刷新兜底。
 */
import { ref, watch } from 'vue'
import { defineStore } from 'pinia'

import { AdminApiError, fetchConfigContext } from '@/api/admin'
import type { ConfigContext } from '@/api/admin'
import { useWorkspaceStore } from '@/stores/workspace'

function errorText(err: unknown, fallback: string): string {
  return err instanceof AdminApiError ? err.message : fallback
}

export const useConfigContextStore = defineStore('admin-config-context', () => {
  const context = ref<ConfigContext | null>(null)
  const loading = ref(false)
  const lastError = ref<string | null>(null)
  let loadCount = 0

  async function load(): Promise<void> {
    if (loading.value) return
    loading.value = true
    try {
      context.value = await fetchConfigContext()
      lastError.value = null
    } catch (err) {
      lastError.value = errorText(err, '获取配置上下文失败')
    } finally {
      loading.value = false
      loadCount += 1
    }
  }

  /** 首次使用时加载（幂等；已有数据不重复拉取，最新化走手动刷新 / activeId 联动）。 */
  async function ensureLoaded(): Promise<void> {
    if (context.value !== null || loading.value) return
    await load()
  }

  // 活动工作区变更（新建 / 切换 / 删除）后自动重取
  const workspaceStore = useWorkspaceStore()
  watch(
    () => workspaceStore.activeId,
    (id, prev) => {
      if (id !== prev && loadCount > 0) void load()
    },
  )

  return { context, loading, lastError, load, ensureLoaded }
})
