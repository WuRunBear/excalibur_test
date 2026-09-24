<template>
  <div class="syspanel">
    <div class="syspanel__hint">
      <span>启用的系统需配套 rules/&lt;同名&gt;.json</span>
      <DescriptionHelp
        text="命名约定：启用某系统后，框架按 rules/<系统 id>.json 查找其规则文件；未提供时按缺省行为运行，无强绑定校验。系统清单来自框架注册表（registerSystem）。"
      />
      <span class="syspanel__count">已启用 {{ enabledCount }} / 共 {{ items.length }}</span>
    </div>

    <!-- 仅就绪态且无任何条目/可添加项时展示空态；加载/失败由底部状态行表达 -->
    <div
      v-if="items.length === 0 && addableEntries.length === 0 && state === 'ready'"
      class="syspanel__empty"
    >
      注册表中暂无系统
    </div>

    <div class="syspanel__list">
      <!-- draft 条目卡（数据源即草稿：未注册条目也保留展示，不丢数据） -->
      <div
        v-for="(item, index) in items"
        :key="`${entryId(item)}-${index}`"
        class="syspanel__card"
        :class="{
          'is-on': entryEnabled(item) && metas[index]?.known,
          'is-off': !entryEnabled(item),
        }"
      >
        <div class="syspanel__card-head">
          <el-switch
            :model-value="entryEnabled(item)"
            size="small"
            :disabled="disabled"
            :aria-label="`启用 ${displayId(item, index)}`"
            @change="setEnabled(index, $event)"
          />
          <span class="syspanel__card-name">{{ displayId(item, index) }}</span>
          <DescriptionHelp
            v-if="metas[index]?.description"
            :text="metas[index]?.description"
          />
          <span
            v-if="!metas[index]?.known"
            class="syspanel__tag syspanel__tag--warn"
            >未注册</span
          >
          <span
            v-else-if="entryEnabled(item)"
            class="syspanel__tag syspanel__tag--on"
            >已启用</span
          >
          <span
            v-else
            class="syspanel__tag"
            >已停用</span
          >
          <span
            v-if="configError(index)"
            class="syspanel__card-error"
            >参数含校验错误</span
          >
          <div class="syspanel__card-tools">
            <el-button
              v-if="!metas[index]?.known"
              type="danger"
              plain
              size="small"
              :disabled="disabled"
              :aria-label="`移除 ${displayId(item, index)}`"
              @click="removeAt(index)"
            >
              移除
            </el-button>
            <button
              v-if="hasConfigArea(index)"
              type="button"
              class="syspanel__fold"
              :aria-expanded="expanded.has(index)"
              @click="toggleFold(index)"
            >
              <span>参数</span>
              <i
                class="syspanel__chevron"
                :class="{ 'is-open': expanded.has(index) }"
                aria-hidden="true"
              ></i>
            </button>
          </div>
        </div>

        <div
          v-if="hasConfigArea(index) && expanded.has(index)"
          class="syspanel__card-body"
        >
          <template v-if="metas[index]?.configSchema">
            <SchemaForm
              :schema="metas[index]?.configSchema"
              :model-value="entryConfig(item)"
              :errors="errors"
              :disabled="disabled"
              :path="configPointer(index)"
              :depth="3"
              bare
              inline
              @mutate="onConfigMutate"
            />
          </template>
          <template v-else>
            <span class="syspanel__noschema">该系统无 schema，请用源码模式编辑</span>
            <pre
              v-if="entryConfig(item) !== undefined"
              class="syspanel__config-json"
              >{{ configJson(item) }}</pre
            >
          </template>
        </div>
      </div>

      <!-- 可添加：注册表有、草稿未引用的系统 -->
      <div
        v-for="entry in addableEntries"
        :key="entry.id"
        class="syspanel__add"
      >
        <el-button
          size="small"
          :disabled="disabled"
          :aria-label="`添加系统 ${entry.id}`"
          @click="addSystem(entry.id)"
        >
          添加
        </el-button>
        <span class="syspanel__add-name">{{ entry.id }}</span>
        <DescriptionHelp
          v-if="entry.description"
          :text="entry.description"
        />
      </div>
    </div>

    <div
      v-if="state === 'loading'"
      class="syspanel__state"
    >
      系统清单加载中…
    </div>
    <div
      v-else-if="state === 'error'"
      class="syspanel__state syspanel__state--error"
    >
      系统清单加载失败
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
defineOptions({ name: 'SystemsPanel' })

import { computed, ref } from 'vue'

import DescriptionHelp from './DescriptionHelp.vue'
import SchemaForm from './SchemaForm.vue'
import { useSystemsEntries } from './refSources'
import type { SystemEntryMeta } from './refSources'
import { cloneJson, errorInSubtree, isPlainObject, pointerJoin } from './schemaUtils'
import type { JsonSchemaNode } from './types'

/**
 * game.json systems[] 专用编辑面板（§3.5 P4）。
 *
 * 数据源 = registries systems 条目（id + description，configSchema 可选）。
 * 交互：草稿条目逐系统一张小卡（启用开关 / 已启用高亮 / config 折叠区），
 * 注册表中有而草稿未引用的系统以「添加」行提供勾选添加；停用 = 写
 * `enabled: false`（保留条目与参数，可再启用），移除仅对未注册条目开放。
 * config 子表单由该系统注册的 configSchema 驱动（复用 SchemaForm 递归），
 * 缺 configSchema 时提示改用源码模式；细粒度变更经 mutate 冒泡，整组增删
 * 经 change 写回。顶部提示 rules/<同名>.json 命名约定（纯提示，无强绑定）。
 */
const props = withDefaults(
  defineProps<{
    /** systems 数组值（SystemEnableEntry[] 期望；容错非数组）。 */
    modelValue?: unknown
    /** 该数组节点的 pointer（如 /systems），供 config 子表单定位与错误映射。 */
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
  /** 整组写回（添加 / 启停 / 移除）。 */
  change: [value: unknown[]]
  /** config 子表单的细粒度变更冒泡（pointer 为文件内全路径）。 */
  mutate: [pointer: string, value: unknown]
}>()

const { entries, state, retry } = useSystemsEntries()

// ---------------------------------------------------------------------------
// 草稿条目读取（容错：形状不符按空值渲染，不丢数据）
// ---------------------------------------------------------------------------

const items = computed<unknown[]>(() => (Array.isArray(props.modelValue) ? props.modelValue : []))

function entryId(item: unknown): string {
  return isPlainObject(item) && typeof item['id'] === 'string' ? item['id'] : ''
}

function entryEnabled(item: unknown): boolean {
  return !(isPlainObject(item) && item['enabled'] === false)
}

function entryConfig(item: unknown): unknown {
  return isPlainObject(item) ? item['config'] : undefined
}

function displayId(item: unknown, index: number): string {
  return entryId(item) || `条目 ${index + 1}`
}

function configJson(item: unknown): string {
  return JSON.stringify(entryConfig(item), null, 2)
}

// ---------------------------------------------------------------------------
// 注册表元数据：按 id 挂 description / configSchema；草稿未注册 → known=false
// ---------------------------------------------------------------------------

const metaById = computed<Map<string, SystemEntryMeta>>(() => {
  const map = new Map<string, SystemEntryMeta>()
  for (const entry of entries.value) map.set(entry.id, entry)
  return map
})

const metas = computed<Array<{ known: boolean; description?: string; configSchema?: JsonSchemaNode }>>(
  () =>
    items.value.map((item) => {
      const meta = metaById.value.get(entryId(item))
      if (!meta) return { known: false }
      return {
        known: true,
        description: meta.description,
        configSchema: meta.configSchema,
      }
    }),
)

const addableEntries = computed<SystemEntryMeta[]>(() => {
  if (state.value !== 'ready') return []
  const usedIds = new Set(items.value.map((item) => entryId(item)))
  return entries.value.filter((entry) => !usedIds.has(entry.id))
})

const enabledCount = computed(() => items.value.filter((item) => entryEnabled(item)).length)

// ---------------------------------------------------------------------------
// config 折叠区
// ---------------------------------------------------------------------------

const expanded = ref(new Set<number>())

function toggleFold(index: number): void {
  const next = new Set(expanded.value)
  if (next.has(index)) next.delete(index)
  else next.add(index)
  expanded.value = next
}

function hasConfigArea(index: number): boolean {
  // 已注册系统始终有参数区（有 configSchema 出表单，无则出源码模式提示）；
  // 未注册条目仅当携带 config 值时展示只读区，避免噪音
  const meta = metas.value[index]
  return meta?.known === true || entryConfig(items.value[index]) !== undefined
}

function configPointer(index: number): string {
  return pointerJoin(pointerJoin(props.path ?? '', index), 'config')
}

function configError(index: number): boolean {
  return hasConfigArea(index) && errorInSubtree(props.errors, configPointer(index))
}

function onConfigMutate(pointer: string, value: unknown): void {
  emit('mutate', pointer, value)
}

// ---------------------------------------------------------------------------
// 整组写回：添加 / 启停 / 移除（不可变更新，保持既有键序）
// ---------------------------------------------------------------------------

function addSystem(id: string): void {
  const index = items.value.length
  emit('change', [...items.value, { id }])
  // 新条目的参数区默认展开，减少一次点击
  const next = new Set(expanded.value)
  next.add(index)
  expanded.value = next
}

function setEnabled(index: number, value: string | number | boolean): void {
  const next = cloneJson(items.value) as Record<string, unknown>[]
  const entry = next[index]
  if (!isPlainObject(entry)) return
  if (value === true) delete entry['enabled'] // 缺省启用
  else entry['enabled'] = false
  emit('change', next)
}

function removeAt(index: number): void {
  emit(
    'change',
    items.value.filter((_, itemIndex) => itemIndex !== index),
  )
}
</script>

<style scoped>
/* 面板容器：与 sform 分组卡片同语言（#e2e5ea 边框、6px 圆角、紧凑密度） */
.syspanel {
  overflow: hidden;
  margin-bottom: 10px;
  border: 1px solid #e2e5ea;
  border-radius: 6px;
  background: #ffffff;
  font-size: 12px;
  color: #3a4048;
}

.syspanel__hint {
  display: flex;
  gap: 5px;
  align-items: center;
  padding: 7px 10px;
  background: #f7f8f9;
  border-bottom: 1px solid #eef0f2;
  font-size: 11px;
  color: #8a919c;
}

.syspanel__count {
  margin-left: auto;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.syspanel__empty {
  padding: 10px;
  font-size: 11px;
  color: #9aa3ad;
}

.syspanel__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
}

/* 系统卡：已启用主色描边高亮，停用降灰 */
.syspanel__card {
  overflow: hidden;
  border: 1px solid #e2e5ea;
  border-radius: 6px;
}

.syspanel__card.is-on {
  border-color: var(--el-color-primary-light-5);
  background: var(--el-color-primary-light-9);
}

.syspanel__card.is-off {
  opacity: 0.75;
}

.syspanel__card-head {
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
  padding: 5px 10px;
}

.syspanel__card.is-on .syspanel__card-head {
  background: #f7f8f9;
}

.syspanel__card-name {
  overflow: hidden;
  font-size: 12px;
  font-weight: 600;
  color: #26292e;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.syspanel__card.is-on .syspanel__card-name {
  color: var(--el-color-primary);
}

.syspanel__tag {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: 999px;
  background: #f2f4f6;
  font-size: 10px;
  line-height: 16px;
  color: #8a919c;
}

.syspanel__tag--on {
  background: var(--el-color-primary-light-8);
  color: var(--el-color-primary);
}

.syspanel__tag--warn {
  background: var(--el-color-warning-light-8);
  color: var(--el-color-warning);
}

.syspanel__card-error {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--el-color-danger);
}

.syspanel__card-tools {
  display: flex;
  gap: 4px;
  align-items: center;
  margin-left: auto;
  flex-shrink: 0;
}

/* 参数折叠按钮（无参数区时不渲染） */
.syspanel__fold {
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

.syspanel__fold:hover {
  color: var(--el-color-primary);
}

.syspanel__fold:focus-visible {
  outline: 2px solid var(--el-color-primary-light-5);
  outline-offset: -1px;
  border-radius: 3px;
}

.syspanel__chevron {
  width: 0;
  height: 0;
  border-top: 4px solid #8a919c;
  border-right: 3px solid transparent;
  border-left: 3px solid transparent;
  transform: rotate(-90deg);
  transition: transform 0.15s ease;
}

.syspanel__chevron.is-open {
  transform: rotate(0deg);
}

.syspanel__card-body {
  padding: 8px 10px 2px;
  border-top: 1px solid #eef0f2;
}

.syspanel__noschema {
  font-size: 11px;
  color: #8a919c;
}

.syspanel__config-json {
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

/* 可添加行 */
.syspanel__add {
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 24px;
  padding: 2px 10px;
  border: 1px dashed #d3d8de;
  border-radius: 6px;
}

.syspanel__add-name {
  font-size: 12px;
  color: #3a4048;
}

/* 清单状态 */
.syspanel__state {
  padding: 0 10px 8px;
  font-size: 11px;
  color: #9aa3ad;
}

.syspanel__state--error {
  color: var(--el-color-danger);
}
</style>
