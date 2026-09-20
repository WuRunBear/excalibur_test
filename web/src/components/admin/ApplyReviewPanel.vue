<template>
  <div class="apply">
    <!-- 成功回执（置于顶部，关闭前常驻） -->
    <div
      v-if="applyStore.receipt"
      class="apply-receipt"
    >
      <div class="apply-receipt__main">
        <span class="apply-receipt__title">已写回本体</span>
        <span class="apply-receipt__meta">
          {{ applyStore.receipt.applied.length }} 个文件 · 耗时
          {{ formatSeconds(applyStore.receipt.durationMs) }}
        </span>
        <span class="apply-receipt__backup">
          备份 <code>{{ applyStore.receipt.backupId }}</code>
        </span>
        <el-button
          size="small"
          text
          @click="copyBackupId"
        >
          复制
        </el-button>
      </div>
      <div class="apply-receipt__actions">
        <el-button
          size="small"
          type="primary"
          :loading="instanceStore.isPending('official', 'restart')"
          :disabled="instanceStore.isBusy('official')"
          @click="onRestartOfficial"
        >
          重启正式实例
        </el-button>
        <el-button
          size="small"
          text
          @click="applyStore.dismissReceipt()"
        >
          关闭
        </el-button>
      </div>
    </div>

    <!-- 无活动工作区 -->
    <div
      v-if="!workspaceStore.activeWorkspace"
      class="apply-empty"
    >
      未设置活动工作区，请先在上方新建或切换工作区后再落盘。
    </div>

    <el-skeleton
      v-else-if="applyStore.planLoading"
      :rows="5"
      animated
    />

    <el-alert
      v-else-if="applyStore.planError"
      type="error"
      :closable="false"
    >
      <div class="apply-alert__body">
        <span>{{ applyStore.planError }}</span>
        <el-button
          size="small"
          @click="reloadPlan"
        >
          重试
        </el-button>
      </div>
    </el-alert>

    <!-- 计划已加载：列表 + diff + 执行 -->
    <template v-else-if="applyStore.planLoaded">
      <el-alert
        v-if="execNotice"
        class="apply-notice"
        :type="execNotice.type"
        :closable="true"
        @close="execNotice = null"
      >
        <div class="apply-alert__body">
          <span>{{ execNotice.text }}</span>
          <el-button
            v-if="execNotice.stale"
            size="small"
            @click="reloadPlan"
          >
            重新获取计划
          </el-button>
        </div>
      </el-alert>

      <div class="apply-review">
        <!-- 左：文件列表 -->
        <aside class="apply-list">
          <div class="apply-list__head">
            <el-checkbox
              :model-value="applyStore.allSelected"
              :indeterminate="applyStore.selectedCount > 0 && !applyStore.allSelected"
              @update:model-value="onSelectAll"
            >
              全选
            </el-checkbox>
            <el-button
              size="small"
              text
              @click="applyStore.clearSelection()"
            >
              清空
            </el-button>
          </div>
          <div class="apply-list__meta">
            已选 {{ applyStore.selectedCount }} / 可落盘 {{ applyStore.validFiles.length }} · 共
            {{ applyStore.plan.length }} 个文件
          </div>
          <ul class="apply-list__body">
            <li
              v-for="file in applyStore.plan"
              :key="file.path"
              class="apply-file"
              :class="{
                'is-current': currentFile?.path === file.path,
                'is-invalid': isInvalid(file.path) || !file.valid,
              }"
              @click="viewFile(file)"
            >
              <span
                class="apply-file__check"
                @click.stop
              >
                <el-checkbox
                  :model-value="applyStore.isSelected(file.path)"
                  :disabled="!file.valid"
                  @update:model-value="applyStore.toggleSelect(file.path)"
                />
              </span>
              <span class="apply-file__main">
                <span class="apply-file__path">{{ file.path }}</span>
                <span class="apply-file__tags">
                  <el-tag
                    size="small"
                    :type="workspaceChangeTagType(file.status)"
                  >
                    {{ WORKSPACE_CHANGE_TEXT[file.status] }}
                  </el-tag>
                  <span class="apply-file__stat"
                    >+{{ file.additions }} / -{{ file.deletions }}</span
                  >
                  <el-tooltip
                    v-if="errorsFor(file).length > 0"
                    placement="top"
                  >
                    <template #content>
                      <div
                        v-for="error in errorsFor(file).slice(0, 3)"
                        :key="error.jsonPath"
                      >
                        {{ error.jsonPath }}：{{ error.message }}
                      </div>
                      <div v-if="errorsFor(file).length > 3">
                        …共 {{ errorsFor(file).length }} 条
                      </div>
                    </template>
                    <el-tag
                      size="small"
                      type="danger"
                    >
                      未通过（{{ errorsFor(file).length }}）
                    </el-tag>
                  </el-tooltip>
                </span>
              </span>
            </li>
          </ul>
        </aside>

        <!-- 右：diff 查看 -->
        <section class="apply-diff">
          <div class="apply-diff__head">
            <span class="apply-diff__path">{{ currentFile?.path ?? '选择左侧文件查看差异' }}</span>
            <el-radio-group
              v-if="currentFile"
              v-model="diffMode"
              size="small"
            >
              <el-radio-button value="editor">对比视图</el-radio-button>
              <el-radio-button value="unified">unified diff</el-radio-button>
            </el-radio-group>
          </div>

          <!-- unified diff 文本（备选视图） -->
          <pre
            v-show="currentFile && diffMode === 'unified'"
            class="apply-unified"
            >{{ currentFile?.diff || '(无差异文本)' }}</pre
          >

          <!-- DiffEditor（original=本体，modified=工作区） -->
          <div
            v-show="!currentFile || diffMode === 'editor'"
            class="apply-diff__body"
          >
            <div
              ref="diffHost"
              class="apply-diff__host"
            ></div>
            <div
              v-if="viewLoading"
              class="apply-diff__overlay"
            >
              <el-skeleton
                :rows="6"
                animated
              />
            </div>
            <div
              v-else-if="!currentFile"
              class="apply-diff__overlay"
            >
              <el-empty
                description="在左侧选择文件查看落盘差异"
                :image-size="90"
              />
            </div>
          </div>

          <div
            v-if="currentFile"
            class="apply-diff__note"
          >
            <template v-if="currentFile.status === 'added'">该文件将新增到本体 game/。</template>
            <template v-else-if="currentFile.status === 'deleted'">
              该文件将从本体 game/ 删除，原内容可在备份中找回。
            </template>
            <template v-else-if="!currentFile.valid">
              该文件未通过校验，勾选已被禁用；请先到「配置编辑」修正后再落盘。
            </template>
            <template v-else>左侧为本体当前内容，右侧为工作区内容；写回后以工作区为准。</template>
          </div>
        </section>
      </div>

      <div class="apply-execute">
        <span class="apply-execute__hint">被覆盖或删除的文件将自动备份，可随时回滚。</span>
        <el-button
          type="danger"
          :disabled="!applyStore.hasSelection"
          :loading="applyStore.executing"
          @click="onExecute"
        >
          写回本体（{{ applyStore.selectedCount }}）
        </el-button>
      </div>
    </template>

    <!-- 有改动但未拉取计划：引导 -->
    <div
      v-else-if="pendingCount > 0"
      class="apply-intro"
    >
      <div class="apply-intro__row">
        <span>
          工作区有
          <b>{{ pendingCount }}</b>
          个文件待写回本体。
        </span>
        <el-button
          type="primary"
          :loading="applyStore.planLoading"
          @click="reloadPlan"
        >
          获取落盘计划
        </el-button>
      </div>
      <p class="apply-intro__hint">
        落盘会把工作区改动写回本体 game/，被覆盖或删除的文件会自动备份，可随时回滚。
      </p>
    </div>

    <!-- 一致空态 -->
    <div
      v-else
      class="apply-empty"
    >
      工作区与本体一致，无需落盘。
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'ApplyReviewPanel' })

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import monaco from '@/utils/monaco'
import { useApplyStore } from '@/stores/apply'
import { useInstanceStore } from '@/stores/instance'
import { useWorkspaceStore } from '@/stores/workspace'
import type { ApplyPlanFile, ValidationError } from '@/api/admin'
import { WORKSPACE_CHANGE_TEXT, workspaceChangeTagType } from '@/utils/workspace'

const applyStore = useApplyStore()
const workspaceStore = useWorkspaceStore()
const instanceStore = useInstanceStore()

/** 活动工作区相对本体的改动数（tab 徽标与空态判断共用）。 */
const pendingCount = computed(() => workspaceStore.activeWorkspace?.changedFiles ?? 0)

// ---------------------------------------------------------------------------
// DiffEditor：original=本体 sourceContent（added 为空文档），modified=工作区内容
// ---------------------------------------------------------------------------

const diffHost = ref<HTMLDivElement | null>(null)
let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null
let originalModel: monaco.editor.ITextModel | null = null
let modifiedModel: monaco.editor.ITextModel | null = null

watch(
  diffHost,
  (host) => {
    if (!host || diffEditor) return
    diffEditor = monaco.editor.createDiffEditor(host, {
      theme: 'admin-light',
      automaticLayout: true,
      readOnly: true,
      fontSize: 13,
      minimap: { enabled: false },
      renderSideBySide: true,
      renderOverviewRuler: false,
      scrollBeyondLastLine: false,
    })
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  originalModel?.dispose()
  modifiedModel?.dispose()
  diffEditor?.dispose()
  diffEditor = null
})

const currentFile = ref<ApplyPlanFile | null>(null)
const modifiedContent = ref('')
const viewLoading = ref(false)
const diffMode = ref<'editor' | 'unified'>('editor')

function isJsonPath(path: string): boolean {
  return path.trim().toLowerCase().endsWith('.json')
}

function setDiffModel(file: ApplyPlanFile, modified: string): void {
  const ed = diffEditor
  if (!ed) return
  const language = isJsonPath(file.path) ? 'json' : 'plaintext'
  originalModel?.dispose()
  modifiedModel?.dispose()
  // added → sourceContent 为 null，original 用空文档；deleted → modified 用空文档
  originalModel = monaco.editor.createModel(file.sourceContent ?? '', language)
  modifiedModel = monaco.editor.createModel(modified, language)
  ed.setModel({ original: originalModel, modified: modifiedModel })
}

async function viewFile(file: ApplyPlanFile): Promise<void> {
  if (currentFile.value?.path === file.path) return
  currentFile.value = file
  diffMode.value = 'editor'
  if (file.status === 'deleted') {
    modifiedContent.value = ''
    setDiffModel(file, '')
    return
  }
  viewLoading.value = true
  try {
    modifiedContent.value = await applyStore.loadWorkspaceContent(file.path)
  } catch (err) {
    modifiedContent.value = ''
    ElMessage.error(err instanceof Error ? err.message : '读取工作区文件内容失败')
  } finally {
    viewLoading.value = false
  }
  setDiffModel(file, modifiedContent.value)
}

onMounted(() => {
  // store 中的计划可能在别的会话里已加载：进来默认展示第一个文件
  const first = applyStore.plan[0]
  if (applyStore.planLoaded && first) {
    void viewFile(first)
  }
})

// ---------------------------------------------------------------------------
// 计划 / 勾选
// ---------------------------------------------------------------------------

async function reloadPlan(): Promise<void> {
  currentFile.value = null
  execNotice.value = null
  await applyStore.loadPlan()
  const first = applyStore.plan[0]
  if (applyStore.planLoaded && first) {
    void viewFile(first)
  }
}

function onSelectAll(value: string | number | boolean | undefined): void {
  if (value === true) applyStore.selectAllValid()
  else applyStore.clearSelection()
}

// ---------------------------------------------------------------------------
// 校验错误标注（计划内 invalid + execute 422 标注共用）
// ---------------------------------------------------------------------------

function invalidMarkFor(path: string): ValidationError[] {
  return applyStore.invalidMarks.find((mark) => mark.path === path)?.validationErrors ?? []
}

function isInvalid(path: string): boolean {
  return invalidMarkFor(path).length > 0
}

function errorsFor(file: ApplyPlanFile): ValidationError[] {
  if (isInvalid(file.path)) return invalidMarkFor(file.path)
  return file.valid ? [] : file.validationErrors
}

// ---------------------------------------------------------------------------
// 执行落盘
// ---------------------------------------------------------------------------

const execNotice = ref<{ type: 'error' | 'warning'; text: string; stale?: boolean } | null>(null)

async function onExecute(): Promise<void> {
  const paths = [...applyStore.selected]
  if (paths.length === 0) return
  try {
    await ElMessageBox.confirm(
      `将把 ${paths.length} 个文件写回本体 game/，被覆盖或删除的文件将自动备份。`,
      '确认落盘',
      {
        confirmButtonText: '写回本体',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
  } catch {
    return
  }

  const outcome = await applyStore.execute(paths)
  if (outcome.kind === 'success') {
    execNotice.value = null
    currentFile.value = null
    ElMessage.success('已写回本体')
    return
  }
  if (outcome.kind === 'invalid') {
    execNotice.value = { type: 'error', text: `${outcome.message}，已在列表中标注未通过校验的文件` }
    ElMessage.error('存在未通过校验的文件，已标注')
    // 定位到第一个被标注文件
    const first = outcome.invalid[0]
    const target = first ? applyStore.plan.find((file) => file.path === first.path) : undefined
    if (target) void viewFile(target)
    return
  }
  if (outcome.kind === 'overall') {
    execNotice.value = { type: 'error', text: outcome.message }
    return
  }
  if (outcome.kind === 'conflict') {
    // 计划过期提示可重取；busy 场景只提示等待
    execNotice.value = {
      type: 'warning',
      text: outcome.message,
      stale: !outcome.message.includes('进行中'),
    }
    return
  }
  execNotice.value = { type: 'error', text: outcome.message }
}

// ---------------------------------------------------------------------------
// 回执动作
// ---------------------------------------------------------------------------

function formatSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  return `${(ms / 1000).toFixed(1)} 秒`
}

async function copyBackupId(): Promise<void> {
  const id = applyStore.receipt?.backupId
  if (!id) return
  try {
    await navigator.clipboard.writeText(id)
    ElMessage.success('备份 ID 已复制')
  } catch {
    ElMessage.error('复制失败，请手动选择复制')
  }
}

async function onRestartOfficial(): Promise<void> {
  try {
    await ElMessageBox.confirm('正式实例需重启才能加载新配置。', '重启正式实例', {
      confirmButtonText: '重启',
      cancelButtonText: '稍后',
      type: 'warning',
    })
  } catch {
    return
  }
  await instanceStore.performAction('official', 'restart')
}
</script>

<style scoped>
.apply {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-family: var(--el-font-family);
}

/* 中性空态 */
.apply-empty {
  padding: 20px;
  border: 1px dashed #d3d8de;
  border-radius: 6px;
  background: #fafbfc;
  text-align: center;
  color: #6b7280;
  font-size: 13px;
}

.apply-intro__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  padding: 16px;
  border: 1px solid #eef0f2;
  border-radius: 6px;
  background: #ffffff;
  font-size: 14px;
  color: #26292e;
}

.apply-intro__hint {
  margin-top: 8px;
  font-size: 12px;
  color: #8a919c;
}

.apply-alert__body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

/* 成功回执 */
.apply-receipt {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px 16px;
  padding: 10px 14px;
  border: 1px solid var(--admin-status-running-border);
  border-radius: 6px;
  background: var(--admin-status-running-bg);
}

.apply-receipt__main {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
}

.apply-receipt__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--admin-status-running);
}

.apply-receipt__meta {
  font-size: 12px;
  color: #3a6b4d;
  font-variant-numeric: tabular-nums;
}

.apply-receipt__backup {
  font-size: 12px;
  color: #3a6b4d;
}

.apply-receipt__backup code {
  font-family: var(--admin-font-mono);
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(46, 158, 91, 0.12);
}

.apply-receipt__actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 审查区：左列表 + 右 diff */
.apply-review {
  display: grid;
  grid-template-columns: minmax(300px, 400px) minmax(0, 1fr);
  gap: 12px;
}

@media (max-width: 900px) {
  .apply-review {
    grid-template-columns: minmax(0, 1fr);
  }
}

.apply-list {
  display: flex;
  flex-direction: column;
  border: 1px solid #e2e5ea;
  border-radius: 6px;
  background: #ffffff;
  overflow: hidden;
}

.apply-list__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid #eef0f2;
  background: #f7f8f9;
}

.apply-list__meta {
  padding: 6px 12px;
  border-bottom: 1px solid #eef0f2;
  font-size: 12px;
  color: #8a919c;
  font-variant-numeric: tabular-nums;
}

.apply-list__body {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 420px;
  overflow-y: auto;
}

.apply-file {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid #f2f4f6;
  cursor: pointer;
}

.apply-file:last-child {
  border-bottom: none;
}

.apply-file:hover {
  background: #f7faf9;
}

.apply-file.is-current {
  background: var(--el-color-primary-light-9);
  box-shadow: 2px 0 0 0 var(--el-color-primary) inset;
}

.apply-file.is-invalid .apply-file__path {
  color: #b23838;
}

.apply-file__check {
  flex-shrink: 0;
  padding-top: 1px;
}

.apply-file__main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.apply-file__path {
  font-family: var(--admin-font-mono);
  font-size: 12px;
  color: #3a4048;
  word-break: break-all;
}

.apply-file__tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.apply-file__stat {
  font-family: var(--admin-font-mono);
  font-size: 11px;
  color: #6b7280;
  font-variant-numeric: tabular-nums;
}

/* diff 区 */
.apply-diff {
  display: flex;
  flex-direction: column;
  border: 1px solid #e2e5ea;
  border-radius: 6px;
  background: #ffffff;
  overflow: hidden;
}

.apply-diff__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid #eef0f2;
  background: #f7f8f9;
}

.apply-diff__path {
  font-family: var(--admin-font-mono);
  font-size: 12px;
  color: #3a4048;
  word-break: break-all;
  min-width: 0;
}

.apply-diff__body {
  position: relative;
  height: 420px;
}

.apply-diff__host {
  height: 100%;
}

.apply-diff__overlay {
  position: absolute;
  inset: 0;
  background: #ffffff;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 24px;
  z-index: 2;
}

.apply-unified {
  height: 420px;
  margin: 0;
  overflow: auto;
  padding: 12px;
  background: #101a18;
  color: #d9e5e1;
  font-family: var(--admin-font-mono);
  font-size: 12px;
  line-height: 1.7;
  white-space: pre;
}

.apply-diff__note {
  padding: 6px 12px;
  border-top: 1px solid #eef0f2;
  background: #fafbfc;
  font-size: 12px;
  color: #8a919c;
}

/* 执行栏 */
.apply-execute {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 12px;
}

.apply-execute__hint {
  font-size: 12px;
  color: #8a919c;
}
</style>
