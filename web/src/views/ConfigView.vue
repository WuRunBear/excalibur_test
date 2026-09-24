<template>
  <div class="cfg">
    <!-- 页内顶栏：工作区切换 / 改动数 / dirty / 操作 -->
    <header class="cfg-bar">
      <div class="cfg-bar__left">
        <h1 class="cfg-title">配置编辑</h1>
        <el-select
          class="cfg-switcher"
          :model-value="workspaceStore.activeId ?? undefined"
          placeholder="选择活动工作区"
          size="small"
          :loading="workspaceStore.loading"
          @update:model-value="onSwitchWorkspace"
        >
          <el-option
            v-for="ws in workspaceStore.items"
            :key="ws.id"
            :label="ws.name"
            :value="ws.id"
          >
            <span class="cfg-option">
              <span>{{ ws.name }}</span>
              <span
                v-if="ws.id === workspaceStore.activeId"
                class="cfg-option__hint"
                >活动中</span
              >
            </span>
          </el-option>
        </el-select>
        <span
          v-if="workspaceStore.activeWorkspace"
          class="cfg-changes"
          title="相对本体的改动文件数"
        >
          改动 {{ workspaceStore.activeWorkspace.changedFiles }}
        </span>
        <span
          v-if="configStore.dirty"
          class="cfg-dirty"
        >
          <i class="cfg-dirty__dot"></i>未保存
        </span>
      </div>

      <div class="cfg-bar__right">
        <!-- S3-B：预览实例 chip（状态点语义色，点击去仪表盘看日志） -->
        <el-tooltip
          :content="previewTooltip"
          placement="top"
        >
          <span
            class="cfg-preview"
            :class="preview ? `cfg-preview--${preview.status}` : 'cfg-preview--unknown'"
            role="link"
            tabindex="0"
            @click="goDashboard"
            @keydown.enter="goDashboard"
          >
            <i class="cfg-preview__dot"></i>预览 :{{ preview?.port ?? 3200 }}
          </span>
        </el-tooltip>
        <!-- S3-B：重启预览（同步等待退出+重启，可达 10s+）；stopped 时切为启动 -->
        <el-button
          size="small"
          :disabled="!preview || instanceStore.isBusy('preview')"
          :loading="preview !== null && instanceStore.isPending('preview', previewAction)"
          @click="onPreviewAction"
        >
          {{ previewAction === 'start' ? '启动预览' : '重启预览' }}
        </el-button>
        <span
          v-if="configStore.currentPath"
          class="cfg-path"
          >{{ configStore.currentPath }}</span
        >
        <template v-if="configStore.currentFile">
          <el-tag
            v-if="configStore.currentFile.schemaKind"
            size="small"
            effect="plain"
          >
            {{ configStore.currentFile.schemaKind }}
          </el-tag>
          <el-tag
            v-else
            size="small"
            type="info"
            effect="plain"
          >
            未校验
          </el-tag>
        </template>
        <!-- §3.4 表单/源码切换：仅带 schema 且草稿为结构化对象的文件出现 -->
        <div
          v-if="formCapable"
          class="cfg-mode"
          role="group"
          aria-label="编辑模式"
        >
          <button
            type="button"
            class="cfg-mode__btn"
            :class="{ 'is-active': viewMode === 'form' }"
            @click="setMode('form')"
          >
            表单
          </button>
          <button
            type="button"
            class="cfg-mode__btn"
            :class="{ 'is-active': viewMode === 'source' }"
            @click="setMode('source')"
          >
            源码
          </button>
        </div>
        <el-button
          size="small"
          text
          :disabled="!canEdit"
          @click="onValidateCurrent"
        >
          校验
        </el-button>
        <el-button
          size="small"
          :disabled="!canFormat"
          @click="onFormat"
        >
          格式化
        </el-button>
        <el-button
          size="small"
          :loading="configStore.validatingAll"
          @click="configStore.validateAll()"
        >
          整体校验
        </el-button>
        <el-button
          size="small"
          type="primary"
          :loading="saving"
          :disabled="!configStore.dirty || configStore.fileLoading"
          @click="onSave"
        >
          保存
        </el-button>
      </div>
    </header>

    <el-alert
      v-if="workspaceStore.lastError"
      class="cfg-alert"
      type="error"
      :closable="false"
    >
      <div class="cfg-alert__body">
        <span>加载工作区失败：{{ workspaceStore.lastError }}</span>
        <el-button
          size="small"
          @click="retryWorkspaces"
        >
          重试
        </el-button>
      </div>
    </el-alert>

    <el-alert
      v-if="configStore.validateAllResult"
      class="cfg-alert"
      :type="configStore.validateAllResult.valid ? 'success' : 'error'"
      :title="configStore.validateAllResult.message"
      :closable="true"
      @close="configStore.validateAllResult = null"
    />

    <!-- §3.4：schema 拉取失败 → 静默回落源码模式，这里给出可重试的轻提示 -->
    <el-alert
      v-if="schemaLoadFailed"
      class="cfg-alert"
      type="warning"
      :closable="false"
    >
      <div class="cfg-alert__body">
        <span>配置 schema 加载失败，已回落源码模式：{{ schemasStore.error }}</span>
        <el-button
          size="small"
          @click="retrySchemaLoad"
        >
          重试
        </el-button>
      </div>
    </el-alert>

    <!-- 无活动工作区：引导去工作区页 -->
    <el-empty
      v-if="!workspaceStore.activeId"
      class="cfg-empty"
      description="未设置活动工作区，无法编辑配置"
    >
      <RouterLink to="/workspace">
        <el-button type="primary">去工作区新建或切换</el-button>
      </RouterLink>
    </el-empty>

    <template v-else>
      <div class="cfg-body">
        <!-- 左：配置文件树 -->
        <aside class="cfg-tree">
          <div class="cfg-tree__head">
            <span>配置文件</span>
            <span class="cfg-tree__hint">非 JSON 只读</span>
          </div>
          <div
            v-if="configStore.treeLoading"
            class="cfg-tree__scroll"
          >
            <el-skeleton
              :rows="5"
              animated
            />
          </div>
          <el-alert
            v-else-if="configStore.treeError"
            type="error"
            :closable="false"
          >
            <div class="cfg-alert__body">
              <span>{{ configStore.treeError }}</span>
              <el-button
                size="small"
                @click="configStore.loadTree()"
              >
                重试
              </el-button>
            </div>
          </el-alert>
          <el-empty
            v-else-if="!configStore.tree"
            description="暂无配置文件"
            :image-size="80"
          />
          <el-tree
            v-else
            class="cfg-tree__scroll"
            :data="[configStore.tree]"
            :props="treeProps"
            node-key="path"
            default-expand-all
            :expand-on-click-node="false"
            highlight-current
            :current-node-key="configStore.currentPath ?? undefined"
            @node-click="onNodeClick"
          >
            <template #default="{ data }">
              <span
                class="cfg-node"
                :class="{ 'is-dir': data.type === 'dir' }"
              >
                <span class="cfg-node__name">{{ data.name }}</span>
                <span
                  v-if="data.type === 'file' && !configStore.isJsonFile(data.path)"
                  class="cfg-node__tag"
                  >只读</span
                >
              </span>
            </template>
          </el-tree>
        </aside>

        <!-- 右：表单 / Monaco 编辑器 + 校验错误面板 -->
        <section class="cfg-editor">
          <div class="cfg-editor__stage">
            <div
              ref="editorHost"
              class="cfg-editor__host"
            ></div>

            <!-- §3.4 表单模式：SchemaForm 覆盖编辑区（Monaco 常驻挂载，随时切回） -->
            <div
              v-if="formPaneVisible"
              class="cfg-formpane"
            >
              <SchemaForm
                v-if="activeSchema"
                :schema="activeSchema"
                :model-value="configStore.draftObj"
                :errors="formErrors"
                @update:model-value="onFormUpdate"
              />
              <!-- schema 拉取中：轻量骨架占位，避免闪现源码 -->
              <div
                v-else
                class="cfg-formpane__pending"
              >
                <el-skeleton
                  :rows="5"
                  animated
                />
                <span class="cfg-formpane__pending-hint">正在加载配置 schema，表单即将可用…</span>
              </div>
            </div>

            <div
              v-if="configStore.fileLoading"
              class="cfg-editor__overlay"
            >
              <el-skeleton
                :rows="6"
                animated
              />
            </div>
            <div
              v-else-if="!configStore.currentPath"
              class="cfg-editor__overlay"
            >
              <el-empty
                description="在左侧选择一个配置文件开始编辑"
                :image-size="100"
              />
            </div>
          </div>

          <div
            v-if="configStore.fileErrors.length > 0"
            class="cfg-errors"
          >
            <div class="cfg-errors__head">
              <span class="cfg-errors__title">校验错误（{{ configStore.fileErrors.length }}）</span>
              <el-button
                size="small"
                text
                @click="configStore.fileErrors = []"
              >
                关闭
              </el-button>
            </div>
            <ul class="cfg-errors__list">
              <li
                v-for="(err, index) in configStore.fileErrors"
                :key="`${err.jsonPath}-${index}`"
                class="cfg-errors__item"
                @click="jumpToError(err)"
              >
                <span class="cfg-errors__path">{{ err.jsonPath }}</span>
                <span class="cfg-errors__msg">{{ err.message }}</span>
                <span
                  v-if="err.line"
                  class="cfg-errors__line"
                  >第 {{ err.line }} 行</span
                >
              </li>
            </ul>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'ConfigView' })

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import monaco from '@/utils/monaco'
import { INSTANCE_STATUS_TEXT } from '@/api/admin'
import type { ConfigTreeNode, ValidationError } from '@/api/admin'
import { SchemaForm, pointerJoin } from '@/components/configForm'
import type { JsonSchemaNode } from '@/components/configForm'
import { useConfigStore } from '@/stores/config'
import { useInstanceStore } from '@/stores/instance'
import { useSchemasStore } from '@/stores/schemas'
import { useWorkspaceStore } from '@/stores/workspace'

const workspaceStore = useWorkspaceStore()
const configStore = useConfigStore()
const instanceStore = useInstanceStore()
const schemasStore = useSchemasStore()
const router = useRouter()

const treeProps = { label: 'name', children: 'children' } as const

// ---------------------------------------------------------------------------
// 生命周期与数据装载
// ---------------------------------------------------------------------------

onMounted(() => {
  void workspaceStore.ensureLoaded().then(() => {
    // 每次进页强制刷新文件树（期间可能在别的页面切换过工作区）
    void configStore.loadTree()
    // 工作区就绪后拉取 schema（幂等；失败静默，错误条可重试）
    ensureSchemasLoaded()
  })
  // 已有活动工作区时直接拉取（store 内部缓存 + 并发去重）
  ensureSchemasLoaded()
  // 预览联调入口依赖实例快照（复用 instance store 的 WS 订阅）
  void instanceStore.ensureLoaded()
  window.addEventListener('keydown', onGlobalKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  editor?.getModel()?.dispose()
  editor?.dispose()
  editor = null
})

async function retryWorkspaces(): Promise<void> {
  await workspaceStore.load()
}

/** 活动工作区变化（本页内切换）：清空编辑状态并重建文件树。 */
watch(
  () => workspaceStore.activeId,
  (id) => {
    if (id) {
      configStore.reset()
      void configStore.loadTree()
      // 跨游戏切换会经 games.epoch 重置 schema 缓存，这里重新拉取
      ensureSchemasLoaded()
    }
  },
)

// ---------------------------------------------------------------------------
// §3.4 表单 / 源码双模式
//
// 模式判定：当前文件带 schemaKind、schemas store 已加载对应 schema 且草稿为
// 结构化对象（draftObj 非空）→ 默认表单模式；其余情况（无 schema 的 JSON、
// 非 JSON 文件、schema 加载中/失败/无此 kind、根为标量）维持 Monaco 源码模式。
// 两种模式共享 store 的 draftObj/draft 数据源，切换不丢未保存内容；
// Monaco 永远可达（顶栏切换 + 错误项点击跳行）。
// ---------------------------------------------------------------------------

/** 当前视图模式；用户显式选择后（pinned）schema 异步就绪不再抢占。 */
const viewMode = ref<'form' | 'source'>('source')
const modePinned = ref(false)
/** 模式归属的文件路径：打开新文件恢复默认；保存引发的 currentFile 替换不重置。 */
const modeFilePath = ref<string | null>(null)

const currentSchemaKind = computed(() => configStore.currentFile?.schemaKind ?? null)

/** 表单模式前提：带 schemaKind 的 JSON 文件且草稿已解析为结构化对象。 */
const formCapable = computed(() => {
  const file = configStore.currentFile
  if (file === null || file.schemaKind === null) return false
  if (configStore.currentPath === null || !configStore.isJsonFile(configStore.currentPath)) {
    return false
  }
  return configStore.draftObj !== null
})

/**
 * 当前文件的 JSON Schema。store 的 JsonSchemaValue 与 SchemaForm 的
 * JsonSchemaNode 是同一份数据的宽容/收敛两侧视图（关键字段结构一致，仅
 * enum/items 的类型声明宽窄不同），此处收敛为组件入参类型。
 */
const currentSchema = computed<JsonSchemaNode | null>(() => {
  const kind = currentSchemaKind.value
  if (kind === null) return null
  const schema = schemasStore.byKind(kind)
  return schema ? (schema as JsonSchemaNode) : null
})

/** schema 就绪：表单可渲染。 */
const formReady = computed(() => formCapable.value && currentSchema.value !== null)

/** schema 拉取中（未就绪也无失败）：表单区给骨架占位而非闪现源码。 */
const schemaPending = computed(
  () =>
    formCapable.value &&
    currentSchema.value === null &&
    !schemasStore.loaded &&
    schemasStore.error === null,
)

const formPaneVisible = computed(() => viewMode.value === 'form' && formCapable.value)

/** 模板 v-if 收窄用：formReady 时必为非空 schema。 */
const activeSchema = computed<JsonSchemaNode | null>(() =>
  formReady.value ? currentSchema.value : null,
)

/** 当前文件带 schemaKind 且 schema 拉取失败（已回落源码模式）。 */
const schemaLoadFailed = computed(
  () => currentSchemaKind.value !== null && schemasStore.error !== null,
)

/** 幂等拉取 schema：无活动工作区时跳过；store 内部缓存 + 并发去重 + 失败可重试。 */
function ensureSchemasLoaded(): void {
  if (!workspaceStore.activeId) return
  if (schemasStore.loaded || schemasStore.loading) return
  void schemasStore.load()
}

function retrySchemaLoad(): void {
  if (schemasStore.loading) return
  void schemasStore.load()
}

// 首个带 schemaKind 的文件打开时兜底拉取：进页时失败（静默）后，
// 打开 schema 文件即自动重试一次，成功则直接回到默认表单模式。
watch(currentSchemaKind, (kind) => {
  if (kind !== null) ensureSchemasLoaded()
})

// 打开新文件：恢复默认模式（表单可用 → 表单，否则源码）。
// 保存成功只替换 currentFile 引用、路径不变，不会走到这里（用户模式保留）。
watch(
  () => configStore.currentPath,
  (path) => {
    if (path === modeFilePath.value) return
    modeFilePath.value = path
    modePinned.value = false
    viewMode.value = formCapable.value ? 'form' : 'source'
  },
)

// schema 就绪 / 失效跟随：就绪或拉取中且用户未显式选择 → 表单；
// 表单被迫失效（加载失败、无此 kind、草稿不再是对象）→ 清掉表单侧选择并回落源码。
watch([formReady, schemaPending], ([ready, pending]) => {
  if (ready || pending) {
    if (!modePinned.value) viewMode.value = 'form'
    return
  }
  if (viewMode.value === 'form') modePinned.value = false
  viewMode.value = 'source'
})

function setMode(mode: 'form' | 'source'): void {
  if (mode === 'form' && !formCapable.value) return
  modePinned.value = true
  if (viewMode.value === mode) return
  viewMode.value = mode
}

// 切回源码：表单编辑只更新了 store 草稿，Monaco 模型需补一次同步，
// 否则源码区显示的是打开时的旧内容。
watch(viewMode, (mode) => {
  if (mode !== 'source') return
  const ed = editor
  const model = ed?.getModel()
  if (!ed || !model) return
  if (ed.getValue() !== configStore.draft) ed.setValue(configStore.draft)
})

/** 表单编辑 → 写回 store 结构化草稿（store 内部同步 draft 字符串与 dirty）。 */
function onFormUpdate(value: Record<string, unknown>): void {
  configStore.draftObj = value
}

/**
 * 服务端校验错误 jsonPath（属性点连 + 数组 [i]，如 `components[0].kind`，
 * 根为 `$`）→ RFC 6901 JSON pointer（`/components/0/kind`），供 SchemaForm
 * 字段命中。根级错误与无法解析的形态返回 null：只留错误面板，不进表单映射。
 */
function serverJsonPathToPointer(jsonPath: string): string | null {
  const text = jsonPath.trim()
  if (text === '' || text === '$') return null
  const tokens: string[] = []
  for (const part of text.split('.')) {
    const bracket = part.indexOf('[')
    if (bracket === -1) {
      if (part !== '') tokens.push(part)
      continue
    }
    const head = part.slice(0, bracket)
    if (head !== '') tokens.push(head)
    let rest = part.slice(bracket)
    while (rest.length > 0) {
      const match = /^\[(\d+)\]/.exec(rest)
      if (match === null) return null
      tokens.push(match[1] as string)
      rest = rest.slice(match[0].length)
    }
  }
  if (tokens.length === 0) return null
  let pointer = ''
  for (const token of tokens) pointer = pointerJoin(pointer, token)
  return pointer
}

/** 表单字段错误：JSON pointer → 首条错误文案（无字段级错误时为 undefined）。 */
const formErrors = computed<Record<string, string> | undefined>(() => {
  if (configStore.fileErrors.length === 0) return undefined
  const map: Record<string, string> = {}
  for (const err of configStore.fileErrors) {
    const pointer = serverJsonPathToPointer(err.jsonPath)
    if (pointer === null) continue
    if (map[pointer] === undefined) map[pointer] = err.message
  }
  return Object.keys(map).length > 0 ? map : undefined
})

// ---------------------------------------------------------------------------
// Monaco 编辑器
// ---------------------------------------------------------------------------

const editorHost = ref<HTMLDivElement | null>(null)
let editor: monaco.editor.IStandaloneCodeEditor | null = null
let loadedPath: string | null = null

/**
 * 惰性创建编辑器：host 在「有活动工作区」的分支内渲染，
 * 进页时可能尚未挂载，因此 watch host 出现后再创建。
 */
watch(
  editorHost,
  (host) => {
    if (!host || editor) return
    editor = monaco.editor.create(host, {
      value: '',
      language: 'plaintext',
      theme: 'admin-light',
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
      glyphMargin: true,
      scrollBeyondLastLine: false,
      tabSize: 2,
      readOnly: true,
    })
    editor.onDidChangeModelContent(() => {
      if (editor) configStore.setDraft(editor.getValue())
    })
    // Ctrl/Cmd+S 保存（编辑器聚焦时）
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void onSave()
    })
  },
  { immediate: true },
)

/** 打开 / 保存后同步模型：换文件重建模型（重置撤销栈），保存只保基线一致。 */
watch(
  () => configStore.currentFile,
  (file) => {
    const ed = editor
    if (!ed) return
    if (!file) {
      ed.getModel()?.dispose()
      ed.setModel(null)
      loadedPath = null
      return
    }
    const isJson = configStore.isJsonFile(file.path)
    if (configStore.currentPath !== loadedPath) {
      const model = monaco.editor.createModel(file.content, isJson ? 'json' : 'plaintext')
      ed.setModel(model)
      loadedPath = configStore.currentPath
    } else {
      const model = ed.getModel()
      if (model && ed.getValue() !== file.content) ed.setValue(file.content)
    }
    ed.updateOptions({ readOnly: !isJson })
    applyMarkers()
  },
)

watch(() => configStore.fileErrors, applyMarkers)

/** 后端校验错误 → Monaco 标记（有行号的错误打点，无行号仅进面板）。 */
function applyMarkers(): void {
  const model = editor?.getModel()
  if (!model) return
  const markers: monaco.editor.IMarkerData[] = configStore.fileErrors
    .filter((err) => typeof err.line === 'number')
    .map((err) => {
      const line = Math.min(Math.max(err.line as number, 1), model.getLineCount())
      return {
        severity: monaco.MarkerSeverity.Error,
        message: `${err.jsonPath}：${err.message}`,
        startLineNumber: line,
        endLineNumber: line,
        startColumn: 1,
        endColumn: model.getLineMaxColumn(line),
      }
    })
  monaco.editor.setModelMarkers(model, 'admin-config', markers)
}

async function jumpToError(err: ValidationError): Promise<void> {
  if (typeof err.line !== 'number') return
  // 表单模式下点错误项：先切源码（Monaco 重新可见），再跳行聚焦
  if (viewMode.value === 'form') {
    setMode('source')
    await nextTick()
  }
  const ed = editor
  if (!ed) return
  ed.revealLineInCenter(err.line)
  ed.setPosition({ lineNumber: err.line, column: 1 })
  ed.focus()
}

// ---------------------------------------------------------------------------
// 操作：打开 / 保存链 / 校验 / 格式化 / 工作区切换
// ---------------------------------------------------------------------------

const canFormat = computed(
  () =>
    configStore.currentPath !== null &&
    configStore.isJsonFile(configStore.currentPath) &&
    !configStore.fileLoading,
)

const canEdit = computed(() => configStore.currentPath !== null && !configStore.fileLoading)

const saving = ref(false)

// ---------------------------------------------------------------------------
// S3-B：预览联调入口（chip + 重启/启动）
// ---------------------------------------------------------------------------

const preview = computed(() => instanceStore.snapshots.preview)

/** 状态机不允许 restart（stopped/crashed）时切为 start，与 instance store 语义一致。 */
const previewAction = computed<'start' | 'restart'>(() => {
  const status = preview.value?.status
  return status === 'stopped' || status === 'crashed' ? 'start' : 'restart'
})

const previewTooltip = computed(() => {
  const snap = preview.value
  if (!snap) return '预览实例状态未知'
  const config = snap.configPath ? `配置：${snap.configPath}` : '配置：本体配置'
  return `预览实例：${INSTANCE_STATUS_TEXT[snap.status]} · ${config}`
})

function goDashboard(): void {
  void router.push('/dashboard')
}

function onPreviewAction(): void {
  void instanceStore.performAction('preview', previewAction.value)
}

function onNodeClick(data: ConfigTreeNode): void {
  if (data.type !== 'file') return
  if (data.path === configStore.currentPath) return
  void openFileWithGuard(data.path)
}

async function openFileWithGuard(path: string): Promise<void> {
  if (!(await confirmLeaveDirty())) return
  await configStore.openFile(path)
}

async function onSwitchWorkspace(
  value: string | number | boolean | object | undefined,
): Promise<void> {
  const id = value === undefined || value === null ? null : String(value)
  if (id === null || id === workspaceStore.activeId) return
  if (!(await confirmLeaveDirty())) return
  // 激活成功后由 activeId watch 清空状态并重建文件树
  await workspaceStore.activate(id)
}

async function confirmLeaveDirty(): Promise<boolean> {
  if (!configStore.dirty) return true
  try {
    await ElMessageBox.confirm('当前文件有未保存的修改，离开将丢失这些修改。', '未保存的修改', {
      confirmButtonText: '放弃修改并离开',
      cancelButtonText: '继续编辑',
      type: 'warning',
    })
    return true
  } catch {
    return false
  }
}

async function onSave(): Promise<void> {
  if (saving.value || !configStore.dirty || configStore.fileLoading) return
  saving.value = true
  try {
    await configStore.save()
  } finally {
    saving.value = false
  }
}

function onValidateCurrent(): void {
  void configStore.validateCurrent()
}

async function onFormat(): Promise<void> {
  const ed = editor
  if (!ed || !canFormat.value) return
  const model = ed.getModel()
  if (!model) return

  // 表单模式下 Monaco 内容可能滞后于草稿：先同步再走格式化链，
  // 否则会拿旧内容格式化后反向覆盖表单编辑。
  if (ed.getValue() !== configStore.draft) ed.setValue(configStore.draft)
  const before = ed.getValue()

  // 优先走 monaco 动作链（JSON worker 格式化）。
  // 注意：formatDocument 动作带前置条件（editorHasDocumentFormattingProvider 等），
  // 条件不满足时 run() 会被静默拦截——内容不变、无报错，因此不能只依赖它。
  const action = ed.getAction('editor.action.formatDocument')
  if (action) await action.run()

  // 动作不存在或被静默拦截（内容未变）→ 本地 JSON 格式化兜底
  if (ed.getValue() !== before) return
  let formatted: string
  try {
    formatted = JSON.stringify(JSON.parse(before), null, 2)
  } catch {
    // 语法错误时本地无法解析：明确提示（worker 的语法波浪线仍可用）
    ElMessage.warning('JSON 解析失败，无法格式化（请先修复语法错误）')
    return
  }
  if (formatted === before) return
  // executeEdits 走编辑器操作栈：内容变更、dirty 生效、Ctrl+Z 可撤销
  ed.executeEdits('admin-format', [{ range: model.getFullModelRange(), text: formatted }])
  ed.pushUndoStop()
}

/** 全局 Ctrl/Cmd+S（焦点不在编辑器时也能保存）。 */
function onGlobalKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    if (!configStore.dirty) return
    event.preventDefault()
    void onSave()
  }
}
</script>

<style scoped>
/* 固定高度：页头 3.5rem + 页内边距 2rem，其余交给内部滚动 */
.cfg {
  height: calc(100vh - 5.5rem);
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-family: var(--el-font-family);
}

.cfg-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}

.cfg-bar__left,
.cfg-bar__right {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.cfg-title {
  font-family: var(--font-pixel);
  font-size: 18px;
  letter-spacing: 2px;
  color: #26292e;
  margin-right: 4px;
}

.cfg-switcher {
  width: 200px;
}

.cfg-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.cfg-option__hint {
  font-size: 12px;
  color: var(--el-color-primary);
}

.cfg-changes {
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--el-color-primary-light-7);
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}

/* dirty 标记：琥珀色圆点 + 文案 */
.cfg-dirty {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #d9860c;
  font-size: 12px;
  white-space: nowrap;
}

.cfg-dirty__dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: #d9860c;
}

.cfg-path {
  font-family: var(--admin-font-mono);
  font-size: 12px;
  color: #6b7280;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 预览实例 chip：状态点复用全局语义色（running 绿 / starting 蓝 / stopped 灰 / crashed 红） */
.cfg-preview {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 10px;
  border-radius: 999px;
  border: 1px solid var(--admin-status-stopped-border);
  background: var(--admin-status-stopped-bg);
  color: var(--admin-status-stopped);
  font-size: 12px;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
}

.cfg-preview__dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--admin-dot-stopped);
}

.cfg-preview--running {
  color: var(--admin-status-running);
  background: var(--admin-status-running-bg);
  border-color: var(--admin-status-running-border);
}

.cfg-preview--running .cfg-preview__dot {
  background: var(--admin-dot-running);
}

.cfg-preview--starting {
  color: var(--admin-status-starting);
  background: var(--admin-status-starting-bg);
  border-color: var(--admin-status-starting-border);
}

.cfg-preview--starting .cfg-preview__dot {
  background: var(--admin-dot-starting);
  animation: admin-status-blink 1.2s ease-in-out infinite;
}

.cfg-preview--crashed {
  color: var(--admin-status-crashed);
  background: var(--admin-status-crashed-bg);
  border-color: var(--admin-status-crashed-border);
}

.cfg-preview--crashed .cfg-preview__dot {
  background: var(--admin-dot-crashed);
  animation: admin-status-blink 0.9s steps(2, start) infinite;
}

@media (prefers-reduced-motion: reduce) {
  .cfg-preview__dot {
    animation: none !important;
  }
}

.cfg-alert__body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.cfg-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

/* 左树右编辑器 */
.cfg-body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
}

.cfg-tree {
  width: 280px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid #e2e5ea;
  border-radius: 6px;
  background: #ffffff;
  overflow: hidden;
}

.cfg-tree__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid #eef0f2;
  background: #f7f8f9;
  font-size: 13px;
  font-weight: 600;
  color: #2b2f36;
}

.cfg-tree__hint {
  font-size: 11px;
  font-weight: normal;
  color: #9aa3ad;
}

.cfg-tree__scroll {
  flex: 1;
  overflow: auto;
  padding: 8px;
}

.cfg-tree :deep(.el-alert) {
  margin: 8px;
}

.cfg-node {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
  padding-right: 4px;
}

.cfg-node__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: #3a4048;
}

.cfg-node.is-dir .cfg-node__name {
  color: #26292e;
  font-weight: 600;
}

.cfg-node__tag {
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: 3px;
  border: 1px solid #e2e5ea;
  background: #f7f8f9;
  font-size: 10px;
  line-height: 16px;
  color: #8a919c;
}

.cfg-editor {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid #e2e5ea;
  border-radius: 6px;
  overflow: hidden;
  position: relative;
}

/* 表单/源码共用舞台：Monaco 常驻挂载，表单模式以覆盖层呈现（随时切回） */
.cfg-editor__stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.cfg-editor__host {
  flex: 1;
  min-height: 0;
}

/* 表单模式容器：与左树同语言的白底卡片内页，可滚动 */
.cfg-formpane {
  position: absolute;
  inset: 0;
  z-index: 1;
  overflow-y: auto;
  padding: 14px 16px 28px;
  background: #ffffff;
  animation: cfg-pane-in 0.18s ease;
}

@keyframes cfg-pane-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .cfg-formpane {
    animation: none;
  }
}

/* schema 加载中：轻量骨架占位 */
.cfg-formpane__pending {
  max-width: 560px;
  margin: 0 auto;
  padding-top: 56px;
}

.cfg-formpane__pending-hint {
  display: block;
  margin-top: 10px;
  text-align: center;
  font-size: 12px;
  color: #9aa3ad;
}

/* 顶栏「表单 / 源码」分段切换：与小号按钮同高，贴合描边卡片语言 */
.cfg-mode {
  display: inline-flex;
  flex-shrink: 0;
  overflow: hidden;
  border: 1px solid #e2e5ea;
  border-radius: 6px;
  background: #ffffff;
}

.cfg-mode__btn {
  padding: 0 12px;
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: 12px;
  line-height: 22px;
  color: #6b7280;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.cfg-mode__btn + .cfg-mode__btn {
  border-left: 1px solid #eef0f2;
}

.cfg-mode__btn:hover {
  background: #f7f8f9;
  color: #26292e;
}

.cfg-mode__btn:focus-visible {
  outline: 2px solid var(--el-color-primary-light-5);
  outline-offset: -2px;
}

.cfg-mode__btn.is-active {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-weight: 600;
}

.cfg-editor__overlay {
  position: absolute;
  inset: 0;
  background: #ffffff;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 24px;
  z-index: 2;
}

/* 校验错误面板：可点击跳转行号 */
.cfg-errors {
  flex-shrink: 0;
  max-height: 200px;
  display: flex;
  flex-direction: column;
  border-top: 1px solid #f3c8c3;
  background: #fdf1f1;
}

.cfg-errors__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
}

.cfg-errors__title {
  font-size: 12px;
  font-weight: 600;
  color: #b23838;
}

.cfg-errors__list {
  list-style: none;
  margin: 0;
  padding: 0 8px 8px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cfg-errors__item {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 6px 8px;
  border: 1px solid #f3c8c3;
  border-radius: 4px;
  background: #ffffff;
  cursor: pointer;
  font-size: 12px;
}

.cfg-errors__item:hover {
  border-color: var(--el-color-danger);
}

.cfg-errors__path {
  font-family: var(--admin-font-mono);
  color: #b23838;
  flex-shrink: 0;
}

.cfg-errors__msg {
  color: #3a4048;
  min-width: 0;
  word-break: break-all;
}

.cfg-errors__line {
  margin-left: auto;
  flex-shrink: 0;
  color: #8a919c;
}

/* 窄屏：树与编辑器纵排 */
@media (max-width: 900px) {
  .cfg-body {
    flex-direction: column;
    overflow: auto;
  }

  .cfg-tree {
    width: auto;
    max-height: 240px;
  }

  .cfg-editor {
    min-height: 320px;
  }
}
</style>
