/**
 * 配置编辑 store（S2-B，作用于活动工作区）。
 *
 * 文件树、当前文件与草稿（dirty 跟踪）、保存链（PUT 校验失败 → 错误面板 +
 * Monaco 标记）、当前文件校验与整体校验。切换文件 / 工作区前的 dirty 确认由视图负责。
 *
 * 3.3（draft 结构化）：
 * - `draft` 仍是字符串（PUT 传输与 Monaco 绑定零改动）；
 * - JSON 文件解析为 `draftObj`（表单绑定），draft 与 draftObj 双向同步；
 * - dirty 走规范化字符串对比：JSON 模式对结构做键序无关规范化，非 JSON /
 *   解析失败文件维持原串直比；
 * - save()/validateCurrent() 从 draftObj 规范化序列化后发送（接口形状不变）。
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

/**
 * JSON 规范化序列化：`JSON.parse` 保序重建 → 2 空格缩进 + 末尾换行。
 * 与仓库既有配置（game.json / rules / entities，均为 2 空格）保持一致；
 * 已有键不重排、新键按插入顺序追加尾部，从而天然最小 diff。
 */
function stringifyJson(value: object): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** 解析为 JSON 容器（对象 / 数组）；标量与解析失败均返回 null（回落字符串模式）。 */
function parseJsonObject(text: string): object | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * dirty 对比基线：对结构做键序无关的规范化（对象键排序、数组保序、紧凑输出）。
 * 使「仅重排键 / 仅改缩进」不产生 dirty，而值变化必然 dirty。
 * 注意：写回 / 保存用的是保序的 {@link stringifyJson}，二者职责分离。
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const body = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')
    return `{${body}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export const useConfigStore = defineStore('admin-config', () => {
  const workspaceStore = useWorkspaceStore()

  const tree = ref<ConfigTreeNode | null>(null)
  const treeLoading = ref(false)
  const treeError = ref<string | null>(null)

  const currentPath = ref<string | null>(null)
  const currentFile = ref<ConfigFile | null>(null)
  /** 编辑器 / 传输用草稿字符串；JSON 模式下与 draftObj 同步（规范化序列化）。 */
  const draft = ref('')
  /** 结构化草稿：当且仅当当前文件是 .json 且解析成功（对象 / 数组）时非空。 */
  const draftObj = ref<object | null>(null)
  /** dirty 基线：打开 / 保存时的原串（字符串模式用）。 */
  const baselineRaw = ref('')
  /** dirty 基线：打开 / 保存时结构的规范化串（JSON 模式用；无则回落原串直比）。 */
  const baselineCanonical = ref<string | null>(null)
  const fileLoading = ref(false)

  /** 保存 / 校验失败的错误列表（错误面板与 Monaco 标记共用）。 */
  const fileErrors = ref<ValidationError[]>([])
  const validateAllResult = ref<{ valid: boolean; message: string } | null>(null)
  const validatingAll = ref(false)

  const dirty = computed(() => {
    if (currentFile.value === null) return false
    if (draftObj.value !== null && baselineCanonical.value !== null) {
      return canonicalJson(draftObj.value) !== baselineCanonical.value
    }
    return draft.value !== baselineRaw.value
  })

  function isJsonFile(path: string | null): boolean {
    return path !== null && path.trim().toLowerCase().endsWith('.json')
  }

  /** 记录打开 / 保存后的 dirty 基线（原串 + 结构规范化串）。 */
  function setBaseline(parsed: object | null, raw: string): void {
    baselineRaw.value = raw
    baselineCanonical.value = parsed !== null ? canonicalJson(parsed) : null
  }

  function clearFile(): void {
    currentPath.value = null
    currentFile.value = null
    draft.value = ''
    draftObj.value = null
    baselineRaw.value = ''
    baselineCanonical.value = null
    fileErrors.value = []
  }

  // -------------------------------------------------------------------------
  // draft <-> draftObj 双向同步
  // draftObj 为表单数据源；外部字符串写入（Monaco / setDraft）反向解析回 draftObj。
  // -------------------------------------------------------------------------
  let applyingFromObject = false

  // draftObj 变更（表单编辑）→ 规范化序列化写回 draft。
  watch(
    draftObj,
    (obj) => {
      if (applyingFromObject || obj === null) return
      const next = stringifyJson(obj)
      if (next === draft.value) return
      applyingFromObject = true
      try {
        draft.value = next
      } finally {
        applyingFromObject = false
      }
    },
    { deep: true, flush: 'sync' },
  )

  // 外部 draft 赋值 / setDraft → 尝试解析进 draftObj；失败则回落字符串模式。
  watch(
    draft,
    (text) => {
      if (applyingFromObject) return
      draftObj.value = isJsonFile(currentPath.value) ? parseJsonObject(text) : null
    },
    { flush: 'sync' },
  )

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
      const parsed = isJsonFile(path) ? parseJsonObject(file.content) : null
      // 赋值 draft 触发同步 watcher 解析出 draftObj；非 JSON / 解析失败时为 null。
      draft.value = file.content
      draftObj.value = parsed
      setBaseline(parsed, file.content)
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

  /** 保存前序列化：JSON 模式走规范化序列化，字符串模式发原串（接口形状不变）。 */
  function serializeDraft(): string {
    return draftObj.value !== null ? stringifyJson(draftObj.value) : draft.value
  }

  /** 保存链：PUT；校验失败（code 1 + detail.errors）→ fileErrors 供面板与标记。 */
  async function save(): Promise<SaveOutcome> {
    const path = currentPath.value
    if (path === null || currentFile.value === null || fileLoading.value) return 'error'
    const content = serializeDraft()
    try {
      await saveConfigFile(path, content)
      currentFile.value = { ...currentFile.value, content }
      setBaseline(draftObj.value, content)
      if (draft.value !== content) draft.value = content
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
      const result = await validateConfigFile(path, serializeDraft())
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
    draftObj,
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
