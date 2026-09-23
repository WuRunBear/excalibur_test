/**
 * 落盘与备份 store（S4-B）。
 *
 * - plan：拉取落盘计划（只读）+ valid 勾选管理；
 * - execute：写回本体，失败按 HTTP 状态分类（422 invalid / 422 整体校验 / 409 冲突），
 *   成功后联动刷新工作区列表（changes 归零）、配置上下文与备份列表；
 * - backups：备份列表 + 回滚（成功后同样联动刷新）。
 * 提示策略：plan/execute 失败由视图按 outcome 渲染（精确呈现），rollback 在 store 内轻提示。
 */
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'

import {
  AdminApiError,
  executeApply,
  extractApplyInvalidFiles,
  extractDetailMessage,
  fetchApplyPlan,
  fetchBackups,
  fetchConfigFile,
  rollbackBackup,
} from '@/api/admin'
import type { ApplyInvalidFile, ApplyPlanFile, ApplyReceipt, BackupMeta } from '@/api/admin'
import { useConfigContextStore } from '@/stores/configContext'
import { useGamesStore } from '@/stores/games'
import { useWorkspaceStore } from '@/stores/workspace'

export type ExecuteOutcome =
  | { kind: 'success'; receipt: ApplyReceipt }
  | { kind: 'invalid'; message: string; invalid: ApplyInvalidFile[] }
  | { kind: 'overall'; message: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'error'; message: string }

export const useApplyStore = defineStore('admin-apply', () => {
  const workspaceStore = useWorkspaceStore()
  const configContextStore = useConfigContextStore()

  // -- 落盘计划 -------------------------------------------------------------
  const plan = ref<ApplyPlanFile[]>([])
  const planLoading = ref(false)
  const planError = ref<string | null>(null)
  const planLoaded = ref(false)

  /** 已勾选待写回的文件路径（仅含 valid 文件）。 */
  const selected = ref<string[]>([])
  /** execute 422 invalid 场景标注（path → 校验错误）。 */
  const invalidMarks = ref<ApplyInvalidFile[]>([])

  const validFiles = computed(() => plan.value.filter((file) => file.valid))
  const selectedCount = computed(() => selected.value.length)
  const hasSelection = computed(() => selected.value.length > 0)
  const allSelected = computed(
    () => validFiles.value.length > 0 && selected.value.length === validFiles.value.length,
  )

  function isSelected(path: string): boolean {
    return selected.value.includes(path)
  }

  function toggleSelect(path: string): void {
    const index = selected.value.indexOf(path)
    if (index >= 0) selected.value.splice(index, 1)
    else selected.value.push(path)
  }

  /** 全选（只含可落盘文件）。 */
  function selectAllValid(): void {
    selected.value = validFiles.value.map((file) => file.path)
  }

  function clearSelection(): void {
    selected.value = []
  }

  async function loadPlan(): Promise<void> {
    if (planLoading.value) return
    planLoading.value = true
    planError.value = null
    try {
      plan.value = (await fetchApplyPlan()).files
      planLoaded.value = true
      selected.value = []
      invalidMarks.value = []
    } catch (err) {
      planError.value = err instanceof Error ? err.message : '获取落盘计划失败'
    } finally {
      planLoading.value = false
    }
  }

  /** 落盘成功 / 场景重置后清空计划态。 */
  function resetPlan(): void {
    plan.value = []
    planLoaded.value = false
    planError.value = null
    selected.value = []
    invalidMarks.value = []
  }

  /** 供 DiffEditor 拉取工作区侧内容（plan 只带本体侧 sourceContent）。 */
  async function loadWorkspaceContent(path: string): Promise<string> {
    const file = await fetchConfigFile(path)
    return file.content
  }

  // -- 执行落盘 -------------------------------------------------------------
  const receipt = ref<ApplyReceipt | null>(null)
  const executing = ref(false)

  async function execute(paths: string[]): Promise<ExecuteOutcome> {
    if (executing.value) return { kind: 'error', message: '落盘进行中，请稍候' }
    executing.value = true
    try {
      const receiptValue = await executeApply(paths)
      receipt.value = receiptValue
      resetPlan()
      // 落盘后工作区 changes 归零：联动刷新工作区列表、配置上下文与备份列表
      void workspaceStore.refresh()
      void configContextStore.load()
      void loadBackups()
      return { kind: 'success', receipt: receiptValue }
    } catch (err) {
      if (err instanceof AdminApiError) {
        if (err.status === 422) {
          const invalid = extractApplyInvalidFiles(err.detail)
          if (invalid) {
            invalidMarks.value = invalid
            return { kind: 'invalid', message: err.message, invalid }
          }
          return { kind: 'overall', message: extractDetailMessage(err.detail) ?? err.message }
        }
        if (err.status === 409) return { kind: 'conflict', message: err.message }
        return { kind: 'error', message: err.message }
      }
      return { kind: 'error', message: '落盘失败，请稍后重试' }
    } finally {
      executing.value = false
    }
  }

  function dismissReceipt(): void {
    receipt.value = null
  }

  // -- 备份与回滚 -----------------------------------------------------------
  const backups = ref<BackupMeta[]>([])
  const backupsLoading = ref(false)
  const backupsError = ref<string | null>(null)
  const backupsLoaded = ref(false)

  async function loadBackups(): Promise<void> {
    if (backupsLoading.value) return
    backupsLoading.value = true
    try {
      backups.value = (await fetchBackups()).items
      backupsError.value = null
      backupsLoaded.value = true
    } catch (err) {
      backupsError.value = err instanceof Error ? err.message : '获取备份列表失败'
    } finally {
      backupsLoading.value = false
    }
  }

  async function ensureBackupsLoaded(): Promise<void> {
    if (!backupsLoaded.value && !backupsLoading.value) await loadBackups()
  }

  /** 回滚（备份内容写回本体）；成功返回 true 并联动刷新。 */
  async function rollback(backupId: string): Promise<boolean> {
    try {
      const detail = await rollbackBackup(backupId)
      ElMessage.success(`已回滚 ${detail.restored.length} 个文件`)
      void workspaceStore.refresh()
      void configContextStore.load()
      void loadBackups()
      return true
    } catch (err) {
      ElMessage.error(err instanceof AdminApiError ? err.message : '回滚失败，请稍后重试')
      return false
    }
  }

  // T2.10：管理目标切换（games.epoch 自增）→ 清空落盘计划 / 备份列表 / 回执；
  // 落盘与备份面板随视图重挂载后以新 gameId 重取。
  const gamesStore = useGamesStore()
  watch(
    () => gamesStore.epoch,
    () => {
      resetPlan()
      receipt.value = null
      backups.value = []
      backupsLoading.value = false
      backupsError.value = null
      backupsLoaded.value = false
    },
  )

  return {
    plan,
    planLoading,
    planError,
    planLoaded,
    selected,
    invalidMarks,
    validFiles,
    selectedCount,
    hasSelection,
    allSelected,
    isSelected,
    toggleSelect,
    selectAllValid,
    clearSelection,
    loadPlan,
    resetPlan,
    loadWorkspaceContent,
    receipt,
    executing,
    execute,
    dismissReceipt,
    backups,
    backupsLoading,
    backupsError,
    loadBackups,
    ensureBackupsLoaded,
    rollback,
  }
})
