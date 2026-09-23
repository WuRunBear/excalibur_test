<template>
  <el-dialog
    :model-value="modelValue"
    title="导入游戏"
    width="560px"
    :close-on-click-modal="false"
    :close-on-press-escape="phase !== 'running'"
    :show-close="phase !== 'running'"
    @update:model-value="onVisibleUpdate"
    @open="onOpen"
  >
    <!-- 表单态：源类型二选一 + 可选标识 -->
    <template v-if="phase === 'form' || phase === 'failed'">
      <div
        v-if="phase === 'failed'"
        class="imp-error"
      >
        <el-alert
          type="error"
          :closable="false"
          show-icon
          :title="errorMessage || '导入失败'"
        >
          <p class="imp-error__hint">可返回修改来源后重试；下方为失败阶段与服务端原始信息。</p>
        </el-alert>
        <ol class="imp-steps imp-steps--failed">
          <li
            v-for="(stage, index) in stages"
            :key="stage.key"
            class="imp-steps__row"
            :class="failedRowClass(index)"
          >
            <span class="imp-steps__icon">{{ failedIcon(index) }}</span>
            <span class="imp-steps__label">{{ stage.label }}</span>
            <span class="imp-steps__state">{{ failedStateText(index) }}</span>
          </li>
        </ol>
        <p
          v-if="stageAmbiguous"
          class="imp-steps__note"
        >
          服务端未返回足够信息，失败阶段未能精确判定（按首阶段呈现）。
        </p>
        <details
          v-if="errorTail"
          class="imp-error__tail"
        >
          <summary>服务端命令输出（stderr 尾部）</summary>
          <pre>{{ errorTail }}</pre>
        </details>
      </div>

      <el-form
        label-position="top"
        class="imp-form"
        @submit.prevent
      >
        <el-form-item label="来源类型">
          <el-radio-group
            v-model="mode"
            :disabled="submitting"
          >
            <el-radio-button value="local">本地路径</el-radio-button>
            <el-radio-button value="git">Git 仓库</el-radio-button>
          </el-radio-group>
        </el-form-item>

        <template v-if="mode === 'local'">
          <el-form-item label="游戏目录路径">
            <el-input
              v-model="localPath"
              :disabled="submitting"
              placeholder="如 ../game_server_test 或绝对路径"
              spellcheck="false"
            />
            <p class="imp-form__hint">
              服务端将校验目录存在且包含 framework/index.ts，错误会在此回显；local
              源跳过依赖安装（假定依赖已就绪）。
            </p>
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item label="仓库地址">
            <el-input
              v-model="gitUrl"
              :disabled="submitting"
              placeholder="https://github.com/org/repo.git"
              spellcheck="false"
            />
          </el-form-item>
          <el-form-item label="ref（分支 / 标签 / commit）">
            <el-input
              v-model="gitRef"
              :disabled="submitting"
              placeholder="main"
              spellcheck="false"
            />
          </el-form-item>
        </template>

        <div class="imp-form__row">
          <el-form-item label="游戏 ID（可选）">
            <el-input
              v-model="gameIdInput"
              :disabled="submitting"
              maxlength="64"
              placeholder="留空则从来源自动推导"
              spellcheck="false"
            />
          </el-form-item>
          <el-form-item label="显示名称（可选）">
            <el-input
              v-model="nameInput"
              :disabled="submitting"
              maxlength="40"
              placeholder="默认同游戏 ID"
            />
          </el-form-item>
        </div>
      </el-form>
    </template>

    <!-- 运行态 / 成功态：阶段清单 -->
    <template v-else>
      <div class="imp-running">
        <div class="imp-running__bar">
          <template v-if="phase === 'running'">
            <span
              class="imp-spinner"
              aria-hidden="true"
            ></span>
            <span class="imp-running__text"> 导入进行中… 已用时 {{ elapsedText }} </span>
          </template>
          <template v-else>
            <span class="imp-running__text imp-running__text--ok">✓ 导入成功</span>
          </template>
        </div>
        <ol class="imp-steps">
          <li
            v-for="(stage, index) in stages"
            :key="stage.key"
            class="imp-steps__row"
            :class="phase === 'running' ? 'is-wait' : 'is-done'"
          >
            <span class="imp-steps__icon">{{ phase === 'running' ? '○' : '✓' }}</span>
            <span class="imp-steps__label">{{ stage.label }}</span>
            <span class="imp-steps__state">
              {{ phase === 'running' ? '待执行' : '已完成' }}
            </span>
          </li>
        </ol>
        <p
          v-if="phase === 'running'"
          class="imp-steps__note"
        >
          服务端按以上顺序执行：克隆与依赖安装可能耗时数分钟。完成前无法细分实时阶段，
          请保持本窗口打开（关闭不会中断导入，但将看不到结果）。
        </p>

        <div
          v-if="phase === 'success' && result"
          class="imp-result"
        >
          <div class="imp-result__grid">
            <div class="imp-result__cell">
              <span class="imp-result__label">游戏 ID</span>
              <span class="imp-result__value imp-result__value--mono">{{ result.gameId }}</span>
            </div>
            <div class="imp-result__cell">
              <span class="imp-result__label">端口（正式 / 预览）</span>
              <span class="imp-result__value imp-result__value--mono">
                {{ result.ports?.official ?? '—' }} / {{ result.ports?.preview ?? '—' }}
              </span>
            </div>
            <div class="imp-result__cell">
              <span class="imp-result__label">commit</span>
              <span class="imp-result__value imp-result__value--mono">{{
                shortCommit(result.commit)
              }}</span>
            </div>
            <div class="imp-result__cell">
              <span class="imp-result__label">冒烟验证</span>
              <span class="imp-result__value">{{ smokeText }}</span>
            </div>
          </div>
          <ul
            v-if="result.notes.length > 0"
            class="imp-result__notes"
          >
            <li
              v-for="note in result.notes"
              :key="note"
            >
              {{ note }}
            </li>
          </ul>
        </div>
      </div>
    </template>

    <template #footer>
      <template v-if="phase === 'form' || phase === 'failed'">
        <el-button
          :disabled="submitting"
          @click="onVisibleUpdate(false)"
        >
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="submitting"
          :disabled="!canSubmit"
          @click="submit"
        >
          {{ phase === 'failed' ? '再次导入' : '开始导入' }}
        </el-button>
      </template>
      <template v-else-if="phase === 'running'">
        <span class="imp-footer__hint">导入仍在进行，请稍候…</span>
      </template>
      <template v-else>
        <el-button
          type="primary"
          @click="finish"
        >
          完成
        </el-button>
      </template>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
defineOptions({ name: 'ImportGameDialog' })

import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'

import { AdminApiError, extractStderrTail, importGame } from '@/api/admin'
import type { GameSyncResult } from '@/api/admin'
import {
  GIT_IMPORT_STAGES,
  inferFailedStageIndex,
  LOCAL_IMPORT_STAGES,
  shortCommit,
  type SyncStageDef,
} from '@/utils/games'

/**
 * 导入对话框（T2.10，Q2 双源）：local 路径 / git URL+ref 二选一。
 * POST /api/games/import 挂起至完成——服务端进度事件不外露，这里按
 * 「阶段清单（完成态）+ 失败阶段推断」呈现；失败错误就地回显（含 stderr 尾部）。
 */
const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'imported', gameId: string): void
}>()

type Phase = 'form' | 'running' | 'success' | 'failed'

const phase = ref<Phase>('form')
const mode = ref<'local' | 'git'>('local')
const localPath = ref('')
const gitUrl = ref('')
const gitRef = ref('main')
const gameIdInput = ref('')
const nameInput = ref('')

const submitting = ref(false)
const result = ref<GameSyncResult | null>(null)
const errorMessage = ref('')
const errorTail = ref('')
const failedIndex = ref(-1)
const stageAmbiguous = ref(false)

const elapsed = ref(0)
let elapsedTimer: number | null = null

const stages = computed<readonly SyncStageDef[]>(() =>
  mode.value === 'git' ? GIT_IMPORT_STAGES : LOCAL_IMPORT_STAGES,
)

const canSubmit = computed(() => {
  if (submitting.value) return false
  if (mode.value === 'local') return localPath.value.trim().length > 0
  return gitUrl.value.trim().length > 0 && gitRef.value.trim().length > 0
})

const elapsedText = computed(() =>
  elapsed.value < 60
    ? `${elapsed.value} 秒`
    : `${Math.floor(elapsed.value / 60)} 分 ${elapsed.value % 60} 秒`,
)

const smokeText = computed(() => {
  const smoke = result.value?.smoke
  if (!smoke) return '通过'
  return `通过（系统 ${smoke.systems} · 原型 ${smoke.archetypes} · 行为 ${smoke.actions} · 组件 ${smoke.components} · 地图生成器 ${smoke.mapGenerators}）`
})

/** 每次打开回归表单态（保留上次输入便于重试）。 */
function onOpen(): void {
  if (phase.value === 'running') return // 理论不可达：运行态禁止关闭
  phase.value = 'form'
  result.value = null
  errorMessage.value = ''
  errorTail.value = ''
  failedIndex.value = -1
  stageAmbiguous.value = false
  stopTimer()
  elapsed.value = 0
}

function onVisibleUpdate(value: boolean): void {
  if (submitting.value && !value) return
  emit('update:modelValue', value)
}

function stopTimer(): void {
  if (elapsedTimer !== null) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  const source =
    mode.value === 'local'
      ? ({ type: 'local', path: localPath.value.trim() } as const)
      : ({ type: 'git', url: gitUrl.value.trim(), ref: gitRef.value.trim() } as const)

  submitting.value = true
  phase.value = 'running'
  failedIndex.value = -1
  stageAmbiguous.value = false
  errorMessage.value = ''
  errorTail.value = ''
  elapsed.value = 0
  stopTimer()
  elapsedTimer = window.setInterval(() => {
    elapsed.value += 1
  }, 1000)

  try {
    result.value = await importGame({
      source,
      ...(gameIdInput.value.trim() ? { id: gameIdInput.value.trim() } : {}),
      ...(nameInput.value.trim() ? { name: nameInput.value.trim() } : {}),
    })
    phase.value = 'success'
    ElMessage.success(`游戏「${result.value.gameId}」导入成功`)
    emit('imported', result.value.gameId)
  } catch (err) {
    phase.value = 'failed'
    errorMessage.value = err instanceof AdminApiError ? err.message : '导入失败，请稍后重试'
    errorTail.value = err instanceof AdminApiError ? (extractStderrTail(err.detail) ?? '') : ''
    const inferred = inferFailedStageIndex(stages.value, errorMessage.value)
    stageAmbiguous.value = inferred < 0
    failedIndex.value = inferred >= 0 ? inferred : 0
  } finally {
    stopTimer()
    submitting.value = false
  }
}

function finish(): void {
  emit('update:modelValue', false)
}

// 失败态的阶段行渲染（失败前的阶段必然已完成——服务端顺序执行）
function failedRowClass(index: number): string {
  if (index < failedIndex.value) return 'is-done'
  if (index === failedIndex.value) return 'is-failed'
  return 'is-wait'
}

function failedIcon(index: number): string {
  if (index < failedIndex.value) return '✓'
  if (index === failedIndex.value) return '✕'
  return '○'
}

function failedStateText(index: number): string {
  if (index < failedIndex.value) return '已完成'
  if (index === failedIndex.value) return '失败'
  return '待执行'
}
</script>

<style scoped>
.imp-form :deep(.el-form-item) {
  margin-bottom: 14px;
}

.imp-form__hint {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: #8a919c;
}

.imp-form__row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

/* 阶段清单：诚实的完成态呈现 */
.imp-steps {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  border: 1px solid #e2e5ea;
  border-radius: 6px;
  overflow: hidden;
}

.imp-steps__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  background: #ffffff;
  font-size: 13px;
}

.imp-steps__row + .imp-steps__row {
  border-top: 1px solid #f2f4f6;
}

.imp-steps__icon {
  flex: none;
  width: 18px;
  text-align: center;
  color: #9aa0a8;
  font-size: 13px;
}

.imp-steps__row.is-done .imp-steps__icon {
  color: var(--el-color-success);
}

.imp-steps__row.is-failed {
  background: var(--admin-status-crashed-bg);
}

.imp-steps__row.is-failed .imp-steps__icon {
  color: var(--el-color-danger);
  font-weight: 700;
}

.imp-steps__label {
  flex: 1;
  color: #26292e;
}

.imp-steps__state {
  font-size: 12px;
  color: #9aa3ad;
}

.imp-steps__row.is-done .imp-steps__state {
  color: var(--el-color-success);
}

.imp-steps__row.is-failed .imp-steps__state {
  color: var(--el-color-danger);
  font-weight: 600;
}

.imp-steps__note {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: #8a919c;
}

/* 运行态 */
.imp-running__bar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.imp-running__text {
  font-size: 13px;
  color: #26292e;
}

.imp-running__text--ok {
  color: var(--el-color-success);
  font-weight: 600;
}

.imp-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--el-color-primary-light-7);
  border-top-color: var(--el-color-primary);
  border-radius: 999px;
  animation: imp-spin 0.8s linear infinite;
}

@keyframes imp-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .imp-spinner {
    animation: none;
  }
}

/* 失败回显 */
.imp-error {
  margin-bottom: 14px;
}

.imp-error__hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: #8a919c;
}

.imp-error__tail {
  margin-top: 10px;
  font-size: 12px;
  color: #8a919c;
}

.imp-error__tail summary {
  cursor: pointer;
  user-select: none;
}

.imp-error__tail pre {
  margin: 8px 0 0;
  padding: 10px;
  max-height: 180px;
  overflow: auto;
  border: 1px solid #f3c8c3;
  border-radius: 4px;
  background: #fdf6f5;
  font-family: var(--admin-font-mono);
  font-size: 11px;
  line-height: 1.6;
  color: #7c3a34;
  white-space: pre-wrap;
  word-break: break-all;
}

/* 成功结果 */
.imp-result {
  margin-top: 14px;
  border: 1px solid var(--el-color-success-light-7);
  border-radius: 6px;
  background: var(--el-color-success-light-9);
  padding: 12px 14px;
}

.imp-result__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 16px;
}

.imp-result__cell {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.imp-result__label {
  font-size: 12px;
  color: #8a919c;
}

.imp-result__value {
  font-size: 13px;
  color: #26292e;
}

.imp-result__value--mono {
  font-family: var(--admin-font-mono);
  font-variant-numeric: tabular-nums;
}

.imp-result__notes {
  list-style: none;
  margin: 10px 0 0;
  padding: 8px 0 0;
  border-top: 1px dashed var(--el-color-success-light-7);
  font-size: 12px;
  line-height: 1.7;
  color: #5f6670;
}

.imp-footer__hint {
  font-size: 12px;
  color: #8a919c;
}
</style>
