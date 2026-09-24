<template>
  <div class="refselect">
    <el-select
      v-if="mode === 'select'"
      class="refselect__select"
      :model-value="selectValue"
      filterable
      allow-create
      default-first-option
      :loading="state === 'loading'"
      :disabled="disabled"
      :placeholder="placeholderText"
      @update:model-value="onSelect"
    >
      <el-option
        v-for="option in options"
        :key="option.value"
        :label="option.value"
        :value="option.value"
      >
        <div class="refselect__option">
          <span class="refselect__option-id">{{ option.value }}</span>
          <span
            v-if="option.description"
            class="refselect__option-desc"
            >{{ option.description }}</span
          >
        </div>
      </el-option>
      <template #footer>
        <div class="refselect__footer">
          <span
            class="refselect__meta"
            :class="{ 'is-error': state === 'error' }"
            >{{ footerMeta }}</span
          >
          <el-button
            link
            type="primary"
            size="small"
            :disabled="disabled"
            @click="mode = 'custom'"
            >使用自定义值</el-button
          >
        </div>
      </template>
    </el-select>

    <!-- 自定义值态：自由输入，保留手输内容，可随时切回列表 -->
    <div
      v-else
      class="refselect__custom"
    >
      <el-input
        v-model="customDraft"
        class="refselect__custom-input"
        :placeholder="placeholderText"
        :disabled="disabled"
        spellcheck="false"
        @change="onCustom"
      />
      <el-button
        link
        type="primary"
        size="small"
        :disabled="disabled"
        @click="mode = 'select'"
        >从列表选择</el-button
      >
    </div>

    <div
      v-if="state === 'error'"
      class="refselect__status"
    >
      引用索引加载失败，可直接输入自定义值
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'RefSelect' })

import { computed, ref, watch } from 'vue'

import { REF_SOURCE_META, useRefOptions } from './refSources'
import type { RefSourceId } from './refSources'

/**
 * 引用型字段的下拉 widget（§3.5）：数据源由 REF_SOURCES 按 JSON pointer 配置
 * （registries / config-index），组件只认 source id。
 *
 * 可搜索（filterable）；索引外的值允许自定义——下拉 footer 提供「使用自定义值」
 * 切换到自由输入（不清空手输内容），输入 + 回车经 allow-create 也能直接建值。
 */
const props = withDefaults(
  defineProps<{
    /** 引用源（matchRefSource 命中的 source id）。 */
    source: RefSourceId
    modelValue?: unknown
    disabled?: boolean
    placeholder?: string
  }>(),
  {
    modelValue: undefined,
    disabled: false,
    placeholder: undefined,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const mode = ref<'select' | 'custom'>('select')
const { options, state } = useRefOptions(props.source)

/**
 * 自定义值态的受控草稿：进入时以当前值初始化（不清空已有手输内容）。
 * 不直接绑 prop——el-input 在受控但不回写时会于 nextTick 强制还原 DOM 值。
 */
const customDraft = ref('')
watch(mode, (value) => {
  if (value === 'custom') customDraft.value = stringValue.value
})

const stringValue = computed(() => {
  const value = props.modelValue
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return String(value)
})

/** 未选值时给 placeholder 位（空串 → placeholder），已选值原样展示（含索引外值）。 */
const selectValue = computed(() => (stringValue.value === '' ? undefined : stringValue.value))

const placeholderText = computed(
  () => props.placeholder ?? `选择或输入${REF_SOURCE_META[props.source].label}`,
)

const footerMeta = computed(() => {
  if (state.value === 'loading') return '加载中…'
  if (state.value === 'error') return '索引加载失败'
  return `${options.value.length} 个可用值`
})

function onSelect(value: unknown): void {
  if (typeof value === 'string') emit('update:modelValue', value)
}

function onCustom(value: string): void {
  emit('update:modelValue', typeof value === 'string' ? value : '')
}
</script>

<style scoped>
.refselect {
  min-width: 0;
}

.refselect__select {
  width: 100%;
}

/* 下拉选项：id 为主行，description 为次要行（来源 registries 元数据） */
.refselect__option {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 2px 0;
  line-height: 1.35;
}

.refselect__option-id {
  overflow: hidden;
  font-size: 12px;
  color: #3a4048;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.refselect__option-desc {
  overflow: hidden;
  max-width: 320px;
  font-size: 11px;
  color: #9aa3ad;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 下拉 footer：索引状态 + 自定义值入口 */
.refselect__footer {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  padding: 2px 4px;
  border-top: 1px solid #eef0f2;
}

.refselect__meta {
  font-size: 11px;
  color: #9aa3ad;
}

.refselect__meta.is-error {
  color: var(--el-color-danger);
}

/* 自定义值态：自由输入 + 切回列表 */
.refselect__custom {
  display: flex;
  gap: 6px;
  align-items: center;
}

.refselect__custom-input {
  flex: 1;
  min-width: 0;
}

.refselect__status {
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--el-color-warning);
}
</style>
