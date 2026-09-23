/**
 * 配置编辑 store（S2-B，作用于活动工作区）。
 *
 * 文件树、当前文件与草稿（dirty 跟踪）、保存链（PUT 校验失败 → 错误面板 +
 * Monaco 标记）、当前文件校验与整体校验。切换文件 / 工作区前的 dirty 确认由视图负责。
 */
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'

import {
  AdminApiError,
  extractValidationErrors,
  fetchConfigFile,
  fetchConfigTree,
  saveConfigFile,
  validateAllConfigs,
  validateConfigFile,
} from '@/api/admin'
import type { ConfigFile, ConfigTreeNode, ValidationError } from '@/api/admin'
import { useGamesStore } from '@/stores/games'
import { useWorkspaceStore } from '@/stores/workspace'

/** 保存结果：已保存 / 校验未通过（错误已入面板）/ 其他失败（已提示）。 */
export type SaveOutcome = 'saved' | 'invalid' | 'error'

function errorText(err: unknown, fallback: string): string {
  return err instanceof AdminApiError ? err.message : fallback
}

export const useConfigStore = defineStore('admin-config', () => {
  const workspaceStore = useWorkspaceStore()

  const tree = ref<ConfigTreeNode | null>(null)
  const treeLoading = ref(false)
  const treeError = ref<string | null>(null)

  const currentPath = ref<string | null>(null)
  const currentFile = ref<ConfigFile | null>(null)
  /** 编辑器草稿；与 currentFile.content 的差异即 dirty。 */
  const draft = ref('')
  const fileLoading = ref(false)

  /** 保存 / 校验失败的错误列表（错误面板与 Monaco 标记共用）。 */
  const fileErrors = ref<ValidationError[]>([])
  const validateAllResult = ref<{ valid: boolean; message: string } | null>(null)
  const validatingAll = ref(false)

  const dirty = computed(
    () => currentFile.value !== null && draft.value !== currentFile.value.content,
  )

  function isJsonFile(path: string | null): boolean {
    return path !== null && path.trim().toLowerCase().endsWith('.json')
  }

  function clearFile(): void {
    currentPath.value = null
    currentFile.value = null
    draft.value = ''
    fileErrors.value = []
  }

  /** 拉取活动工作区的配置树；无活动工作区时清空本地状态。 */
  async function loadTree(): Promise<void> {
    if (!workspaceStore.activeId) {
      tree.value = null
      treeError.value = null
      clearFile()
      return
    }
    treeLoading.value = true
    try {
      tree.value = (await fetchConfigTree()).tree
      treeError.value = null
    } catch (err) {
      treeError.value = errorText(err, '获取配置文件树失败')
    } finally {
      treeLoading.value = false
    }
  }

  /** 打开文件并加载内容（切换前的 dirty 确认由视图负责）。 */
  async function openFile(path: string): Promise<void> {
    if (fileLoading.value) return
    fileLoading.value = true
    const prevPath = currentPath.value
    currentPath.value = path
    try {
      const file = await fetchConfigFile(path)
      currentFile.value = file
      draft.value = file.content
      fileErrors.value = []
    } catch (err) {
      // 打开失败：回到上一个文件视角，提示后端 message。
      currentPath.value = prevPath
      ElMessage.error(errorText(err, '读取文件失败'))
    } finally {
      fileLoading.value = false
    }
  }

  function setDraft(content: string): void {
    draft.value = content
  }

  /** 保存链：PUT；校验失败（code 1 + detail.errors）→ fileErrors 供面板与标记。 */
  async function save(): Promise<SaveOutcome> {
    const path = currentPath.value
    if (path === null || currentFile.value === null || fileLoading.value) return 'error'
    try {
      await saveConfigFile(path, draft.value)
      currentFile.value = { ...currentFile.value, content: draft.value }
      fileErrors.value = []
      ElMessage.success('已保存')
      // 保存成功后静默刷新工作区列表，同步改动文件数。
      void workspaceStore.refresh()
      return 'saved'
    } catch (err) {
      if (err instanceof AdminApiError) {
        const errors = extractValidationErrors(err.detail)
        if (errors) {
          fileErrors.value = errors
          return 'invalid'
        }
      }
      ElMessage.error(errorText(err, '保存失败，请稍后重试'))
      return 'error'
    }
  }

  /** 当前文件校验（不落盘）：通过清错误并轻提示，不通过则填充错误面板。 */
  async function validateCurrent(): Promise<void> {
    const path = currentPath.value
    if (path === null || fileLoading.value) return
    try {
      const result = await validateConfigFile(path, draft.value)
      if (result.valid) {
        fileErrors.value = []
        ElMessage.success('校验通过')
      } else {
        fileErrors.value = result.errors
      }
    } catch (err) {
      ElMessage.error(errorText(err, '校验失败'))
    }
  }

  /** 整体校验活动工作区全部配置。 */
  async function validateAll(): Promise<void> {
    if (validatingAll.value) return
    validatingAll.value = true
    try {
      validateAllResult.value = await validateAllConfigs()
    } catch (err) {
      ElMessage.error(errorText(err, '整体校验失败'))
    } finally {
      validatingAll.value = false
    }
  }

  /** 切换工作区时清空编辑状态（文件树由 loadTree 重建）。 */
  function reset(): void {
    tree.value = null
    treeError.value = null
    clearFile()
    validateAllResult.value = null
  }

  // T2.10：管理目标切换（games.epoch 自增）→ 清空编辑状态（含未保存草稿，
  // 避免把 A 游戏的草稿落到 B 游戏）；配置视图重挂载后 loadTree 重建。
  const gamesStore = useGamesStore()
  watch(
    () => gamesStore.epoch,
    () => {
      reset()
    },
  )

  return {
    tree,
    treeLoading,
    treeError,
    currentPath,
    currentFile,
    draft,
    fileLoading,
    fileErrors,
    validateAllResult,
    validatingAll,
    dirty,
    isJsonFile,
    loadTree,
    openFile,
    setDraft,
    save,
    validateCurrent,
    validateAll,
    reset,
  }
})
