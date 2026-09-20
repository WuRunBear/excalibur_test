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

        <!-- 右：Monaco 编辑器 + 校验错误面板 -->
        <section class="cfg-editor">
          <div
            ref="editorHost"
            class="cfg-editor__host"
          ></div>

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

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ElMessageBox } from 'element-plus'

import monaco from '@/utils/monaco'
import { useConfigStore } from '@/stores/config'
import { useWorkspaceStore } from '@/stores/workspace'
import type { ConfigTreeNode, ValidationError } from '@/api/admin'

const workspaceStore = useWorkspaceStore()
const configStore = useConfigStore()

const treeProps = { label: 'name', children: 'children' } as const

// ---------------------------------------------------------------------------
// 生命周期与数据装载
// ---------------------------------------------------------------------------

onMounted(() => {
  void workspaceStore.ensureLoaded().then(() => {
    // 每次进页强制刷新文件树（期间可能在别的页面切换过工作区）
    void configStore.loadTree()
  })
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
    }
  },
)

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

function jumpToError(err: ValidationError): void {
  const ed = editor
  if (!ed || typeof err.line !== 'number') return
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
  const action = await ed.getAction('editor.action.formatDocument')
  await action?.run()
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

.cfg-editor__host {
  flex: 1;
  min-height: 0;
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
