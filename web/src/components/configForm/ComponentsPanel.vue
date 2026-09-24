<template>
  <div class="cmppanel">
    <div class="cmppanel__hint">
      <span>组件 config 表单由注册表 configSchema 驱动</span>
      <DescriptionHelp
        text="组件键 = 组件注册名（componentRegistry）。注册时声明 configSchema 的组件可表单编辑；未注册或无 schema 的组件展示只读 JSON，请用源码模式编辑。"
      />
      <span class="cmppanel__count">{{ keys.length }} 个组件</span>
    </div>

    <div
      v-if="keys.length === 0"
      class="cmppanel__empty"
    >
      暂无组件配置，可在下方添加
    </div>

    <div class="cmppanel__list">
      <!-- draft 条目卡（数据源即草稿：未注册键也保留展示，不丢数据） -->
      <div
        v-for="(key, index) in keys"
        :key="key"
        class="cmppanel__card"
        :class="{
          'is-schema': metas[index]?.configSchema !== undefined,
          'is-error': cardError(key),
        }"
      >
        <div class="cmppanel__card-head">
          <!-- 键改名沿用 record 交互：blur/enter 提交 + 重名保护（本地草稿受控） -->
          <el-input
            class="cmppanel__key"
            :model-value="keyDraft(key)"
            :disabled="disabled"
            spellcheck="false"
            :aria-label="`组件名 ${key}`"
            @input="setKeyDraft(key, $event)"
            @change="commitKey(key, $event)"
          />
          <DescriptionHelp
            v-if="metas[index]?.description"
            :text="metas[index]?.description"
          />
          <span
            v-if="!metas[index]?.known"
            class="cmppanel__tag cmppanel__tag--warn"
            >未注册</span
          >
          <span
            v-else-if="metas[index]?.configSchema"
            class="cmppanel__tag cmppanel__tag--on"
            >有 schema</span
          >
          <span
            v-else
            class="cmppanel__tag"
            >无 schema</span
          >
          <span
            v-if="cardError(key)"
            class="cmppanel__card-error"
            >参数含校验错误</span
          >
          <div class="cmppanel__card-tools">
            <el-button
              type="danger"
              plain
              size="small"
              :disabled="disabled"
              :aria-label="`删除 ${key}`"
              @click="removeKey(key)"
            >
              删除
            </el-button>
            <button
              type="button"
              class="cmppanel__fold"
              :aria-expanded="isOpen(key)"
              @click="toggleFold(key)"
            >
              <span>参数</span>
              <i
                class="cmppanel__chevron"
                :class="{ 'is-open': isOpen(key) }"
                aria-hidden="true"
              ></i>
            </button>
          </div>
        </div>

        <div
          v-if="isOpen(key)"
          class="cmppanel__card-body"
        >
          <template v-if="metas[index]?.configSchema">
            <SchemaForm
              :schema="metas[index]?.configSchema"
              :model-value="valueOf(key)"
              :errors="errors"
              :disabled="disabled"
              :path="keyPointer(key)"
              :depth="3"
              bare
              inline
              @mutate="onConfigMutate"
            />
          </template>
          <template v-else>
            <span class="cmppanel__noschema">该组件无 schema，请用源码模式编辑</span>
            <pre class="cmppanel__config-json">{{ configJson(key) }}</pre>
          </template>
        </div>
      </div>

      <!-- 新增键：注册表 components id 下拉（allow-create 支持未注册组件名） -->
      <div class="cmppanel__add">
        <RefSelect
          v-model="addKey"
          class="cmppanel__add-select"
          source="components"
          :disabled="disabled"
          placeholder="选择或输入组件名"
        />
        <el-button
          size="small"
          :disabled="addDisabled"
          aria-label="添加组件"
          @click="addComponent"
        >
          添加
        </el-button>
        <span
          v-if="addExists"
          class="cmppanel__add-hint cmppanel__add-hint--warn"
          >组件已存在</span
        >
        <span
          v-else-if="addKey.trim() && addMeta && !addMeta.configSchema"
          class="cmppanel__add-hint"
          >该组件无 schema，将以空对象添加</span
        >
      </div>
    </div>

    <div
      v-if="state === 'loading'"
      class="cmppanel__state"
    >
      注册表加载中…
    </div>
    <div
      v-else-if="state === 'error'"
      class="cmppanel__state cmppanel__state--error"
    >
      注册表加载失败
      <el-button
        link
        type="primary"
        size="small"
        @click="retry"
        >重试</el-button
      >
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'ComponentsPanel' })

import { computed, ref } from 'vue'

import DescriptionHelp from './DescriptionHelp.vue'
import RefSelect from './RefSelect.vue'
import SchemaForm from './SchemaForm.vue'
import { useComponentEntries } from './refSources'
import type { ComponentEntryMeta } from './refSources'
import { buildDefault, errorInSubtree, isPlainObject, pointerJoin } from './schemaUtils'
import type { JsonSchemaNode } from './types'

/**
 * 实体文件 components record 专用编辑面板（§3.5 P5：components 表单化）。
 *
 * 本体 ArchetypeSchema.components 为 z.record(unknown)，文件 schema 无值结构，
 * 子表单由注册表 components 条目的 configSchema 驱动（registerBuiltin 元数据，
 * 复用 SchemaForm 递归，path=/components/<key>，mutate 冒泡 / errors 前缀命中）。
 *
 * 交互（沿用 record 语义）：逐键一张小卡——键改名（blur/enter 提交 + 重名保护）、
 * 删除键、参数折叠区（有 configSchema 默认展开 + 主色描边表达有效子表单；
 * 无 schema 展示只读 JSON +「该组件无 schema，请用源码模式编辑」，与
 * SystemsPanel 降级语言一致）。新增键经注册表 components id 下拉（RefSelect，
 * allow-create 允许未注册名），有 configSchema 按 buildDefault 生成最小骨架值，
 * 无则落空对象并提示。整组增删/改名经 change 写回，config 细粒度变更经 mutate
 * 冒泡——与 SystemsPanel 同协议。
 */
const props = withDefaults(
  defineProps<{
    /** components record 值（Record<string, unknown> 期望；容错非对象）。 */
    modelValue?: unknown
    /** 该 record 节点的 pointer（如 /components），供子表单定位与错误映射。 */
    path?: string
    errors?: Record<string, string>
    disabled?: boolean
  }>(),
  {
    modelValue: undefined,
    path: undefined,
    errors: undefined,
    disabled: false,
  },
)

const emit = defineEmits<{
  /** 整组写回（添加 / 删除 / 键改名，键序保持）。 */
  change: [value: Record<string, unknown>]
  /** config 子表单的细粒度变更冒泡（pointer 为文件内全路径）。 */
  mutate: [pointer: string, value: unknown]
}>()

const { entries, state, retry } = useComponentEntries()

// ---------------------------------------------------------------------------
// 草稿读取（容错：非对象按空 record 渲染，不丢数据）
// ---------------------------------------------------------------------------

const draft = computed<Record<string, unknown>>(() =>
  isPlainObject(props.modelValue) ? props.modelValue : {},
)
const keys = computed(() => Object.keys(draft.value))

function valueOf(key: string): unknown {
  return draft.value[key]
}

function keyPointer(key: string): string {
  return pointerJoin(props.path ?? '', key)
}

function configJson(key: string): string {
  return JSON.stringify(valueOf(key), null, 2)
}

function cardError(key: string): boolean {
  return errorInSubtree(props.errors, keyPointer(key))
}

// ---------------------------------------------------------------------------
// 注册表元数据：键 → description / configSchema；未注册键 → known=false
// ---------------------------------------------------------------------------

const metaById = computed<Map<string, ComponentEntryMeta>>(() => {
  const map = new Map<string, ComponentEntryMeta>()
  for (const entry of entries.value) map.set(entry.id, entry)
  return map
})

/** 与 keys 对齐的元数据数组（模板经 v-if 窄化取 configSchema）。 */
const metas = computed<
  Array<{ known: boolean; description?: string; configSchema?: JsonSchemaNode }>
>(() =>
  keys.value.map((key) => {
    const meta = metaById.value.get(key)
    if (!meta) return { known: false }
    return { known: true, description: meta.description, configSchema: meta.configSchema }
  }),
)

function configSchemaOf(key: string): JsonSchemaNode | undefined {
  return metaById.value.get(key)?.configSchema
}

function onConfigMutate(pointer: string, value: unknown): void {
  emit('mutate', pointer, value)
}

// ---------------------------------------------------------------------------
// 参数折叠区：有 configSchema 默认展开；用户 toggle 记 override（按键记，改名随迁）
// ---------------------------------------------------------------------------

const foldOverrides = ref(new Map<string, boolean>())

function isOpen(key: string): boolean {
  const override = foldOverrides.value.get(key)
  if (override !== undefined) return override
  return configSchemaOf(key) !== undefined
}

function toggleFold(key: string): void {
  const next = new Map(foldOverrides.value)
  next.set(key, !isOpen(key))
  foldOverrides.value = next
}

// ---------------------------------------------------------------------------
// 键改名：本地草稿受控（el-input 在受控不回写时会于 nextTick 强制还原 DOM），
// blur/enter 提交 + 重名保护；折叠态随键迁移
// ---------------------------------------------------------------------------

const keyDrafts = ref(new Map<string, string>())

function keyDraft(key: string): string {
  return keyDrafts.value.get(key) ?? key
}

function setKeyDraft(key: string, value: string | number): void {
  const next = new Map(keyDrafts.value)
  next.set(key, String(value))
  keyDrafts.value = next
}

function commitKey(key: string, value: unknown): void {
  const pending = typeof value === 'string' ? value : keyDraft(key)
  const next = new Map(keyDrafts.value)
  next.delete(key)
  keyDrafts.value = next
  renameKey(key, pending)
}

function renameKey(oldKey: string, raw: string): void {
  const newKey = raw.trim()
  if (!newKey || newKey === oldKey) return
  if (newKey in draft.value) return // 重名保护：保留既有值
  const nextFolds = new Map(foldOverrides.value)
  const moved = nextFolds.get(oldKey)
  nextFolds.delete(oldKey)
  if (moved !== undefined) nextFolds.set(newKey, moved)
  foldOverrides.value = nextFolds
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(draft.value)) {
    next[key === oldKey ? newKey : key] = value
  }
  emit('change', next)
}

// ---------------------------------------------------------------------------
// 删除 / 新增（追加尾部保序；新卡默认展开）
// ---------------------------------------------------------------------------

function removeKey(key: string): void {
  const next: Record<string, unknown> = {}
  for (const [entryKey, value] of Object.entries(draft.value)) {
    if (entryKey !== key) next[entryKey] = value
  }
  emit('change', next)
}

const addKey = ref('')

const addExists = computed(() => {
  const key = addKey.value.trim()
  return key.length > 0 && key in draft.value
})

const addMeta = computed(() => {
  const key = addKey.value.trim()
  return key.length > 0 ? metaById.value.get(key) : undefined
})

const addDisabled = computed(
  () => props.disabled || addKey.value.trim().length === 0 || addExists.value,
)

function addComponent(): void {
  const key = addKey.value.trim()
  if (!key || key in draft.value) return
  const configSchema = configSchemaOf(key)
  const value = configSchema ? buildDefault(configSchema) : {}
  const nextFolds = new Map(foldOverrides.value)
  nextFolds.set(key, true)
  foldOverrides.value = nextFolds
  addKey.value = ''
  emit('change', { ...draft.value, [key]: value })
}
</script>

<style scoped>
/* 面板容器：与 syspanel 同语言（#e2e5ea 边框、6px 圆角、紧凑密度） */
.cmppanel {
  overflow: hidden;
  margin-bottom: 10px;
  border: 1px solid #e2e5ea;
  border-radius: 6px;
  background: #ffffff;
  font-size: 12px;
  color: #3a4048;
}

.cmppanel__hint {
  display: flex;
  gap: 5px;
  align-items: center;
  padding: 7px 10px;
  background: #f7f8f9;
  border-bottom: 1px solid #eef0f2;
  font-size: 11px;
  color: #8a919c;
}

.cmppanel__count {
  margin-left: auto;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.cmppanel__empty {
  padding: 10px;
  font-size: 11px;
  color: #9aa3ad;
}

.cmppanel__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
}

/* 组件卡：有 configSchema（有效子表单）主色描边表达 */
.cmppanel__card {
  overflow: hidden;
  border: 1px solid #e2e5ea;
  border-radius: 6px;
}

.cmppanel__card.is-schema {
  border-color: var(--el-color-primary-light-5);
}

.cmppanel__card.is-schema .cmppanel__card-head {
  background: #f7f8f9;
}

.cmppanel__card.is-error {
  border-color: var(--el-color-danger-light-5);
}

.cmppanel__card-head {
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
  padding: 5px 10px;
}

.cmppanel__key {
  flex-shrink: 0;
  width: 160px;
}

.cmppanel__tag {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: 999px;
  background: #f2f4f6;
  font-size: 10px;
  line-height: 16px;
  color: #8a919c;
}

.cmppanel__tag--on {
  background: var(--el-color-primary-light-8);
  color: var(--el-color-primary);
}

.cmppanel__tag--warn {
  background: var(--el-color-warning-light-8);
  color: var(--el-color-warning);
}

.cmppanel__card-error {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--el-color-danger);
}

.cmppanel__card-tools {
  display: flex;
  gap: 4px;
  align-items: center;
  margin-left: auto;
  flex-shrink: 0;
}

.cmppanel__fold {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 2px 4px;
  border: none;
  background: transparent;
  font-size: 11px;
  color: #5f6670;
  cursor: pointer;
}

.cmppanel__fold:hover {
  color: var(--el-color-primary);
}

.cmppanel__fold:focus-visible {
  outline: 2px solid var(--el-color-primary-light-5);
  outline-offset: -1px;
  border-radius: 3px;
}

.cmppanel__chevron {
  flex-shrink: 0;
  width: 0;
  height: 0;
  border-top: 4px solid #8a919c;
  border-right: 3px solid transparent;
  border-left: 3px solid transparent;
  transform: rotate(-90deg);
  transition: transform 0.15s ease;
}

.cmppanel__chevron.is-open {
  transform: rotate(0deg);
}

.cmppanel__card-body {
  padding: 8px 10px 2px;
  border-top: 1px solid #eef0f2;
}

.cmppanel__noschema {
  font-size: 11px;
  color: #8a919c;
}

.cmppanel__config-json {
  max-height: 160px;
  margin: 6px 0 8px;
  overflow: auto;
  padding: 6px 8px;
  border: 1px dashed #d3d8de;
  border-radius: 4px;
  background: #fafbfc;
  font-family: var(--admin-font-mono, monospace);
  font-size: 11px;
  line-height: 1.6;
  color: #5f6670;
  white-space: pre-wrap;
  word-break: break-all;
}

/* 新增行：注册表下拉 + 添加 */
.cmppanel__add {
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 24px;
  padding: 2px 10px;
  border: 1px dashed #d3d8de;
  border-radius: 6px;
}

.cmppanel__add-select {
  flex: 1;
  min-width: 0;
  max-width: 260px;
}

.cmppanel__add-hint {
  font-size: 11px;
  color: #9aa3ad;
}

.cmppanel__add-hint--warn {
  color: var(--el-color-warning);
}

/* 清单状态 */
.cmppanel__state {
  padding: 0 10px 8px;
  font-size: 11px;
  color: #9aa3ad;
}

.cmppanel__state--error {
  color: var(--el-color-danger);
}
</style>
