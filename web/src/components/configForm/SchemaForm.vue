<template>
  <div class="sform">
    <!-- unknown：$ref / allOf / 结构未知 / 超深递归 → 只读 JSON 兜底，不崩 -->
    <div
      v-if="info.kind === 'unknown' || depth > maxRenderDepth"
      class="sform-field"
      :class="{ 'sform-field--error': fieldError !== undefined }"
    >
      <div
        v-if="showLabel"
        class="sform-field__label"
      >
        <span
          v-if="required"
          class="sform-field__req"
          >*</span
        >
        <span class="sform-field__title">{{ label }}</span>
        <DescriptionHelp :text="helpText" />
      </div>
      <div class="sform-unknown">
        <span class="sform-unknown__hint">该节点结构暂不支持表单编辑，请切换「源码」模式修改</span>
        <pre class="sform-unknown__json">{{ unknownJson }}</pre>
      </div>
      <div
        v-if="fieldError !== undefined"
        class="sform-field__error"
      >
        {{ fieldError }}
      </div>
    </div>

    <!-- object：折叠分组（flat = 根/数组项/oneOf 分支/记录值，直接平铺属性） -->
    <div
      v-else-if="info.kind === 'object'"
      class="sform-group"
      :class="{
        'sform-group--flat': flat,
        'is-open': flat || groupExpanded,
        'is-error': subtreeError,
      }"
    >
      <button
        v-if="!flat"
        type="button"
        class="sform-group__head"
        :aria-expanded="flat || groupExpanded"
        @click="toggleGroup"
      >
        <i
          class="sform-group__chevron"
          aria-hidden="true"
        ></i>
        <span
          v-if="required"
          class="sform-field__req"
          >*</span
        >
        <span class="sform-group__title">{{ label }}</span>
        <span
          class="sform-group__help"
          @click.stop
        >
          <DescriptionHelp :text="helpText" />
        </span>
        <span
          v-if="subtreeError"
          class="sform-group__error-hint"
          >含校验错误</span
        >
      </button>
      <div
        v-show="flat || groupExpanded"
        class="sform-group__body"
        :class="{ 'sform-group__body--flush': flat }"
      >
        <div
          v-if="propertyEntries.length === 0"
          class="sform-empty"
        >
          无字段
        </div>
        <div class="sform-grid">
          <div
            v-for="entry in propertyEntries"
            :key="entry.key"
            class="sform-grid__item"
            :class="{ 'sform-grid__item--wide': entry.wide }"
          >
            <SchemaForm
              :schema="entry.schema"
              :model-value="objectValue[entry.key]"
              :errors="errors"
              :disabled="disabled"
              :path="entry.pointer"
              :depth="depth + 1"
              :required="entry.required"
              @mutate="onChildMutate"
            />
          </div>
        </div>
        <div
          v-if="fieldError !== undefined"
          class="sform-field__error"
        >
          {{ fieldError }}
        </div>
      </div>
    </div>

    <!-- record：无 properties 的 object → 键值行编辑（如 maps 注册表）；命中 override → 专用面板 -->
    <div
      v-else-if="info.kind === 'record'"
      class="sform-field"
      :class="{ 'sform-field--error': fieldError !== undefined }"
    >
      <div
        v-if="showLabel"
        class="sform-field__label"
      >
        <span
          v-if="required"
          class="sform-field__req"
          >*</span
        >
        <span class="sform-field__title">{{ label }}</span>
        <DescriptionHelp :text="helpText" />
        <span
          v-if="!widgetOverride"
          class="sform-record__count"
          >{{ recordKeys.length }} 项</span
        >
      </div>

      <!-- widget 接管：components record → 注册表 configSchema 驱动的组件面板 -->
      <ComponentsPanel
        v-if="widgetOverride?.id === 'components-panel'"
        :model-value="recordValue"
        :path="selfPointer"
        :errors="errors"
        :disabled="disabled"
        @change="onWidgetChange"
        @mutate="onChildMutate"
      />

      <div
        v-else
        class="sform-record"
      >
        <div
          v-for="key in recordKeys"
          :key="key"
          class="sform-record__row"
          :class="{
            'is-error':
              errorInSubtree(errors, pointerJoin(selfPointer, key)) ||
              errorAt(errors, pointerJoin(selfPointer, key)) !== undefined,
          }"
        >
          <!-- 键命中「键引用源」（如实体 components 表键）→ 可搜索下拉增强 -->
          <RefSelect
            v-if="recordKeySource"
            class="sform-record__key"
            :source="recordKeySource"
            :model-value="key"
            :disabled="disabled"
            @update:model-value="onRecordKeySelect(key, $event)"
          />
          <el-input
            v-else
            class="sform-record__key"
            :model-value="key"
            :disabled="disabled"
            spellcheck="false"
            @change="renameRecordKey(key, $event)"
          />
          <div class="sform-record__value">
            <SchemaForm
              :schema="recordValueSchema"
              :model-value="recordValue[key]"
              :errors="errors"
              :disabled="disabled"
              :path="pointerJoin(selfPointer, key)"
              :depth="depth + 1"
              bare
              inline
              @mutate="onChildMutate"
            />
          </div>
          <el-button
            type="danger"
            plain
            size="small"
            :disabled="disabled"
            :aria-label="`删除 ${key}`"
            @click="removeRecordRow(key)"
          >
            删除
          </el-button>
        </div>
        <div class="sform-record__tools">
          <el-button
            size="small"
            :disabled="disabled"
            @click="addRecordRow"
          >
            添加一项
          </el-button>
        </div>
      </div>
      <div
        v-if="fieldError !== undefined"
        class="sform-field__error"
      >
        {{ fieldError }}
      </div>
    </div>

    <!-- array：标量枚举 → 多选 select；对象项 → 嵌套卡片；标量项 → 行编辑 -->
    <div
      v-else-if="info.kind === 'array'"
      class="sform-field"
      :class="{ 'sform-field--error': fieldError !== undefined }"
    >
      <div
        v-if="showLabel"
        class="sform-field__label"
      >
        <span
          v-if="required"
          class="sform-field__req"
          >*</span
        >
        <span class="sform-field__title">{{ label }}</span>
        <DescriptionHelp :text="helpText" />
        <span
          v-if="!widgetOverride"
          class="sform-array__count"
          >{{ arrayValue.length }} 项</span
        >
      </div>

      <!-- widget 接管：指针命中 WIDGET_OVERRIDES 的节点以专用面板替代默认渲染 -->
      <SystemsPanel
        v-if="widgetOverride?.id === 'systems-panel'"
        :model-value="arrayValue"
        :path="selfPointer"
        :errors="errors"
        :disabled="disabled"
        @change="onWidgetChange"
        @mutate="onChildMutate"
      />

      <el-select
        v-else-if="arrayItemEnum"
        class="sform-array__multi"
        multiple
        :filterable="arrayItemEnum.length >= 8"
        :model-value="enumArrayList"
        :disabled="disabled"
        @update:model-value="onEnumArrayChange"
      >
        <el-option
          v-for="option in arrayItemEnum"
          :key="String(option.value)"
          :label="option.label"
          :value="option.value"
        />
      </el-select>

      <template v-else>
        <div class="sform-array">
          <!-- 对象项：嵌套卡片行 -->
          <template v-if="isObjectItemArray">
            <div
              v-for="(item, index) in arrayValue"
              :key="index"
              class="sform-array__card"
              :class="{
                'is-error': errorInSubtree(errors, pointerJoin(selfPointer, index)),
              }"
            >
              <div class="sform-array__card-head">
                <span class="sform-array__card-title">{{ itemLabel }} {{ index + 1 }}</span>
                <el-button
                  type="danger"
                  plain
                  size="small"
                  :disabled="disabled"
                  :aria-label="`删除${itemLabel} ${index + 1}`"
                  @click="removeArrayItem(index)"
                >
                  删除
                </el-button>
              </div>
              <div class="sform-array__card-body">
                <SchemaForm
                  :schema="arrayItemSchema"
                  :model-value="item"
                  :errors="errors"
                  :disabled="disabled"
                  :path="pointerJoin(selfPointer, index)"
                  :depth="depth"
                  bare
                  inline
                  @mutate="onChildMutate"
                />
              </div>
            </div>
          </template>

          <!-- 标量项：行编辑 -->
          <template v-else>
            <div
              v-for="(item, index) in arrayValue"
              :key="index"
              class="sform-array__row"
              :class="{
                'is-error': errorAt(errors, pointerJoin(selfPointer, index)) !== undefined,
              }"
            >
              <div class="sform-array__row-control">
                <SchemaForm
                  :schema="arrayItemSchema"
                  :model-value="item"
                  :errors="errors"
                  :disabled="disabled"
                  :path="pointerJoin(selfPointer, index)"
                  :depth="depth"
                  bare
                  @mutate="onChildMutate"
                />
              </div>
              <el-button
                type="danger"
                plain
                size="small"
                :disabled="disabled"
                :aria-label="`删除第 ${index + 1} 项`"
                @click="removeArrayItem(index)"
              >
                删除
              </el-button>
            </div>
          </template>

          <div class="sform-array__tools">
            <el-button
              size="small"
              :disabled="disabled"
              @click="addArrayItem"
            >
              添加一项
            </el-button>
          </div>
        </div>
      </template>
      <div
        v-if="fieldError !== undefined"
        class="sform-field__error"
      >
        {{ fieldError }}
      </div>
    </div>

    <!-- oneOf/anyOf + literal 判别：kind 选择器 + 子表单（如 map pipeline/tiled） -->
    <div
      v-else-if="info.kind === 'oneOf' && discriminator"
      class="sform-field"
      :class="{ 'sform-field--error': fieldError !== undefined }"
    >
      <div
        v-if="showLabel"
        class="sform-field__label"
      >
        <span
          v-if="required"
          class="sform-field__req"
          >*</span
        >
        <span class="sform-field__title">{{ label }}</span>
        <DescriptionHelp :text="helpText" />
      </div>
      <div class="sform-oneof">
        <div class="sform-oneof__kind">
          <span class="sform-oneof__kind-label">{{ discriminator.property }}</span>
          <el-select
            class="sform-oneof__kind-select"
            :model-value="currentKind"
            :disabled="disabled"
            @update:model-value="switchKind"
          >
            <el-option
              v-for="option in discriminator.options"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </div>
        <SchemaForm
          v-if="activeBranchSchema"
          :schema="activeBranchSchema"
          :model-value="objectValue"
          :errors="errors"
          :disabled="disabled"
          :path="selfPointer"
          :depth="depth"
          bare
          inline
          @mutate="onChildMutate"
        />
      </div>
      <div
        v-if="fieldError !== undefined"
        class="sform-field__error"
      >
        {{ fieldError }}
      </div>
    </div>

    <!-- enum → select（≥8 项可搜索） -->
    <div
      v-else-if="info.kind === 'enum'"
      class="sform-field"
      :class="{ 'sform-field--error': fieldError !== undefined }"
    >
      <div
        v-if="showLabel"
        class="sform-field__label"
      >
        <span
          v-if="required"
          class="sform-field__req"
          >*</span
        >
        <span class="sform-field__title">{{ label }}</span>
        <DescriptionHelp :text="helpText" />
      </div>
      <el-select
        :model-value="enumCurrentValue"
        :filterable="(info.enumOptions?.length ?? 0) >= 8"
        :disabled="disabled"
        @update:model-value="onScalarCommit"
      >
        <el-option
          v-for="option in info.enumOptions ?? []"
          :key="String(option.value)"
          :label="option.label"
          :value="option.value"
        />
      </el-select>
      <div
        v-if="fieldError !== undefined"
        class="sform-field__error"
      >
        {{ fieldError }}
      </div>
    </div>

    <!-- boolean → switch -->
    <div
      v-else-if="info.kind === 'boolean'"
      class="sform-field"
      :class="{ 'sform-field--error': fieldError !== undefined }"
    >
      <div
        v-if="showLabel"
        class="sform-field__label"
      >
        <span
          v-if="required"
          class="sform-field__req"
          >*</span
        >
        <span class="sform-field__title">{{ label }}</span>
        <DescriptionHelp :text="helpText" />
      </div>
      <el-switch
        :model-value="props.modelValue === true"
        :disabled="disabled"
        @change="onSwitchChange"
      />
      <div
        v-if="fieldError !== undefined"
        class="sform-field__error"
      >
        {{ fieldError }}
      </div>
    </div>

    <!-- number / integer → InputNumber -->
    <div
      v-else-if="info.kind === 'number' || info.kind === 'integer'"
      class="sform-field"
      :class="{ 'sform-field--error': fieldError !== undefined }"
    >
      <div
        v-if="showLabel"
        class="sform-field__label"
      >
        <span
          v-if="required"
          class="sform-field__req"
          >*</span
        >
        <span class="sform-field__title">{{ label }}</span>
        <DescriptionHelp :text="helpText" />
      </div>
      <el-input-number
        :model-value="numberValue"
        :min="numberMin"
        :max="numberMax"
        :precision="info.kind === 'integer' ? 0 : undefined"
        :step="info.kind === 'integer' ? 1 : 0.1"
        controls-position="right"
        :disabled="disabled"
        @update:model-value="onNumberCommit"
      />
      <div
        v-if="fieldError !== undefined"
        class="sform-field__error"
      >
        {{ fieldError }}
      </div>
    </div>

    <!-- const → 只读展示 -->
    <div
      v-else-if="info.kind === 'const'"
      class="sform-field"
      :class="{ 'sform-field--error': fieldError !== undefined }"
    >
      <div
        v-if="showLabel"
        class="sform-field__label"
      >
        <span
          v-if="required"
          class="sform-field__req"
          >*</span
        >
        <span class="sform-field__title">{{ label }}</span>
        <DescriptionHelp :text="helpText" />
      </div>
      <el-input
        :model-value="constDisplay"
        disabled
        spellcheck="false"
      />
      <div
        v-if="fieldError !== undefined"
        class="sform-field__error"
      >
        {{ fieldError }}
      </div>
    </div>

    <!-- string → 引用字段用 RefSelect（下拉增强），其余 input -->
    <div
      v-else
      class="sform-field"
      :class="{ 'sform-field--error': fieldError !== undefined }"
    >
      <div
        v-if="showLabel"
        class="sform-field__label"
      >
        <span
          v-if="required"
          class="sform-field__req"
          >*</span
        >
        <span class="sform-field__title">{{ label }}</span>
        <DescriptionHelp :text="helpText" />
      </div>
      <RefSelect
        v-if="refSource"
        :source="refSource"
        :model-value="stringValue"
        :placeholder="placeholder"
        :disabled="disabled"
        @update:model-value="onScalarCommit"
      />
      <el-input
        v-else
        :model-value="stringValue"
        :maxlength="stringMaxLength"
        :show-word-limit="stringMaxLength !== undefined"
        :placeholder="placeholder"
        :disabled="disabled"
        spellcheck="false"
        @update:model-value="onScalarCommit"
      />
      <div
        v-if="fieldError !== undefined"
        class="sform-field__error"
      >
        {{ fieldError }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'SchemaForm' })

import { computed, ref } from 'vue'

import DescriptionHelp from './DescriptionHelp.vue'
import ComponentsPanel from './ComponentsPanel.vue'
import RefSelect from './RefSelect.vue'
import SystemsPanel from './SystemsPanel.vue'
import {
  hasRegistryAccess,
  matchRefKeySource,
  matchRefSource,
  matchWidgetOverride,
} from './refSources'
import type { RefSourceId, WidgetOverrideRule } from './refSources'
import {
  MAX_RENDER_DEPTH,
  buildDefault,
  cloneJson,
  describeSchema,
  errorAt,
  errorInSubtree,
  isPlainObject,
  pointerJoin,
  pointerLeaf,
  setAtPath,
} from './schemaUtils'
import type { Discriminator, EnumOption, JsonSchemaNode, SchemaInfo } from './types'

/**
 * JSON Schema 驱动的递归表单渲染器（§3.5）。
 *
 * 渲染映射：string→input（命中 REF_SOURCES 的引用字段→RefSelect 下拉增强）、
 * number/integer→InputNumber、boolean→switch、enum→select（长枚举可搜索）、
 * array→可增删列表（对象项卡片/标量项行/枚举多选；命中 WIDGET_OVERRIDES 的
 * 节点→专用面板，如 game.json systems[]→SystemsPanel）、object→折叠分组
 * （默认展开第一层）、无 properties 的 object→键值行（键可被键引用源增强；
 * 命中 WIDGET_OVERRIDES 的 record→专用面板，如实体 components→ComponentsPanel）、
 * oneOf+literal 判别→kind 选择器+子表单；无法识别的节点→只读 JSON 提示。
 *
 * 事件协议：内部递归子节点 emit `mutate(pointer, value)`；根实例（无 path）
 * 汇总为整体草稿对象后 emit `update:modelValue`（不可变更新，保持键序）。
 */
const props = withDefaults(
  defineProps<{
    schema: JsonSchemaNode
    modelValue?: unknown
    /** JSON pointer 风格路径 → 错误文案（422 zod issue 映射，如 /systems/0/config/port）。 */
    errors?: Record<string, string>
    disabled?: boolean
    /** 内部递归用：当前节点 pointer（根实例缺省）。 */
    path?: string
    /** 内部递归用：分组层级（≤1 的分组默认展开）。 */
    depth?: number
    /** 内部递归用：在父对象中是否 required（必填标识）。 */
    required?: boolean
    /** 内部递归用：隐藏自身 label 行（数组行 / 记录值 / 分支子表单）。 */
    bare?: boolean
    /** 内部递归用：object 不渲染折叠卡片，直接平铺属性。 */
    inline?: boolean
  }>(),
  {
    modelValue: undefined,
    errors: undefined,
    disabled: false,
    path: undefined,
    depth: 0,
    required: false,
    bare: false,
    inline: false,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: Record<string, unknown>]
  mutate: [pointer: string, value: unknown]
}>()

const maxRenderDepth = MAX_RENDER_DEPTH
const EMPTY_SCHEMA: JsonSchemaNode = {}

const isRoot = computed(() => props.path === undefined)
const selfPointer = computed(() => props.path ?? '')
const flat = computed(() => props.inline || isRoot.value)
const showLabel = computed(() => !props.bare && !isRoot.value)

const info = computed<SchemaInfo>(() => describeSchema(props.schema))
const label = computed(() => props.schema.title ?? pointerLeaf(selfPointer.value) ?? '未命名字段')
const helpText = computed(() =>
  typeof props.schema.description === 'string' ? props.schema.description : '',
)
const fieldError = computed(() => errorAt(props.errors, selfPointer.value))
const subtreeError = computed(() => errorInSubtree(props.errors, selfPointer.value))
const placeholder = computed(() => {
  const examples = props.schema.examples
  return Array.isArray(examples) && typeof examples[0] === 'string' ? examples[0] : undefined
})

const unknownJson = computed(() => {
  const payload: Record<string, unknown> = { schema: props.schema }
  if (props.modelValue !== undefined) payload.value = props.modelValue
  return JSON.stringify(payload, null, 2)
})

// ---------------------------------------------------------------------------
// 值读取（容错：草稿类型与 schema 不符时按空值渲染，不抛错）
// ---------------------------------------------------------------------------

const objectValue = computed<Record<string, unknown>>(() =>
  isPlainObject(props.modelValue) ? props.modelValue : {},
)

const stringValue = computed(() => {
  const value = props.modelValue
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return String(value)
})

const numberValue = computed(() =>
  typeof props.modelValue === 'number' ? props.modelValue : undefined,
)

const constDisplay = computed(() => {
  const value = props.schema.const
  return value === undefined ? '' : String(value)
})

const stringMaxLength = computed(() =>
  typeof props.schema.maxLength === 'number' ? props.schema.maxLength : undefined,
)
const numberMin = computed(() =>
  typeof props.schema.minimum === 'number' ? props.schema.minimum : undefined,
)
const numberMax = computed(() =>
  typeof props.schema.maximum === 'number' ? props.schema.maximum : undefined,
)

const enumCurrentValue = computed<string | number | boolean | undefined>(() => {
  const value = props.modelValue
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  return undefined
})

// ---------------------------------------------------------------------------
// 事件协议：子节点 mutate 冒泡；根实例落盘为整体草稿
// ---------------------------------------------------------------------------

function commit(pointer: string, value: unknown): void {
  if (isRoot.value) {
    const next = pointer === '' ? value : setAtPath(props.modelValue, pointer, value)
    emit('update:modelValue', isPlainObject(next) ? next : {})
    return
  }
  emit('mutate', pointer, value)
}

function onChildMutate(pointer: string, value: unknown): void {
  commit(pointer, value)
}

function onScalarCommit(value: unknown): void {
  commit(selfPointer.value, value)
}

function onSwitchChange(value: string | number | boolean): void {
  commit(selfPointer.value, value === true)
}

function onNumberCommit(value: number | null | undefined): void {
  commit(selfPointer.value, typeof value === 'number' ? value : undefined)
}

// ---------------------------------------------------------------------------
// widget 挂载点（§3.5）：REF_SOURCES 引用下拉 + WIDGET_OVERRIDES 专用面板
// ---------------------------------------------------------------------------

/** string 字段命中的引用源（→ RefSelect 下拉增强）；未命中 null 保持普通 input。 */
const refSource = computed<RefSourceId | null>(() =>
  info.value.kind === 'string' ? matchRefSource(selfPointer.value) : null,
)

/** record 命中的「键引用源」（键渲染为 RefSelect）；未命中 null 保持普通键输入。 */
const recordKeySource = computed<RefSourceId | null>(() =>
  info.value.kind === 'record' ? matchRefKeySource(selfPointer.value) : null,
)

/**
 * widget 接管：array / record 节点命中 WIDGET_OVERRIDES 且注册表 store 可达时
 * 生效；无注册表环境（pinia 缺失）回落默认渲染，保证渲染器可独立挂载。
 */
const registryAccessible = hasRegistryAccess()
const widgetOverride = computed<WidgetOverrideRule | null>(() => {
  const kind = info.value.kind
  if ((kind !== 'array' && kind !== 'record') || !registryAccessible) return null
  return matchWidgetOverride(selfPointer.value)
})

function onWidgetChange(value: unknown): void {
  commit(selfPointer.value, value)
}

function onRecordKeySelect(oldKey: string, value: unknown): void {
  if (typeof value === 'string' && value.length > 0) renameRecordKey(oldKey, value)
}

// ---------------------------------------------------------------------------
// object：属性网格 + 折叠分组（默认展开第一层）
// ---------------------------------------------------------------------------

const WIDE_KINDS = new Set<SchemaInfo['kind']>(['object', 'record', 'array', 'oneOf', 'unknown'])

const groupExpanded = ref(props.depth <= 1)

function toggleGroup(): void {
  groupExpanded.value = !groupExpanded.value
}

const propertyEntries = computed(() => {
  const properties = isPlainObject(props.schema.properties)
    ? (props.schema.properties as Record<string, JsonSchemaNode>)
    : {}
  const requiredKeys = Array.isArray(props.schema.required)
    ? props.schema.required.filter((key): key is string => typeof key === 'string')
    : []
  return Object.entries(properties).map(([key, childSchema]) => {
    const childInfo = describeSchema(childSchema)
    return {
      key,
      schema: childSchema,
      pointer: pointerJoin(selfPointer.value, key),
      required: requiredKeys.includes(key),
      wide: WIDE_KINDS.has(childInfo.kind),
    }
  })
})

// ---------------------------------------------------------------------------
// record：键值行（键改 blur 提交避免逐键重建子表单）
// ---------------------------------------------------------------------------

const recordValue = computed<Record<string, unknown>>(() =>
  isPlainObject(props.modelValue) ? props.modelValue : {},
)
const recordKeys = computed(() => Object.keys(recordValue.value))
const recordValueSchema = computed<JsonSchemaNode>(() =>
  info.value.kind === 'record' && info.value.recordValue ? info.value.recordValue : EMPTY_SCHEMA,
)

function nextRecordKey(base: Record<string, unknown>): string {
  if (base['key'] === undefined) return 'key'
  let index = 2
  while (base[`key${index}`] !== undefined) index += 1
  return `key${index}`
}

function addRecordRow(): void {
  const next = cloneJson(recordValue.value)
  next[nextRecordKey(next)] = buildDefault(recordValueSchema.value)
  commit(selfPointer.value, next)
}

function removeRecordRow(key: string): void {
  const next = cloneJson(recordValue.value)
  delete next[key]
  commit(selfPointer.value, next)
}

function renameRecordKey(oldKey: string, newKeyRaw: string): void {
  const newKey = newKeyRaw.trim()
  if (!newKey || newKey === oldKey) return
  if (recordValue.value[newKey] !== undefined) return // 重名保护：保留既有值
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(recordValue.value)) {
    next[key === oldKey ? newKey : key] = value
  }
  commit(selfPointer.value, next)
}

// ---------------------------------------------------------------------------
// array：枚举多选 / 对象卡片 / 标量行
// ---------------------------------------------------------------------------

const arrayValue = computed<unknown[]>(() =>
  Array.isArray(props.modelValue) ? props.modelValue : [],
)
const arrayItemSchema = computed<JsonSchemaNode>(() =>
  info.value.kind === 'array' && info.value.items ? info.value.items : EMPTY_SCHEMA,
)
const arrayItemInfo = computed<SchemaInfo>(() =>
  info.value.kind === 'array' && info.value.itemInfo ? info.value.itemInfo : { kind: 'unknown' },
)
const arrayItemEnum = computed<EnumOption[] | null>(() =>
  arrayItemInfo.value.kind === 'enum' ? (arrayItemInfo.value.enumOptions ?? null) : null,
)
const isObjectItemArray = computed(() =>
  ['object', 'record', 'oneOf'].includes(arrayItemInfo.value.kind),
)
const itemLabel = computed(() => {
  const title = arrayItemSchema.value.title
  return typeof title === 'string' && title.length > 0 ? title : '条目'
})
const enumArrayList = computed(() => arrayValue.value)

function onEnumArrayChange(value: unknown): void {
  commit(selfPointer.value, Array.isArray(value) ? value : [])
}

function addArrayItem(): void {
  commit(selfPointer.value, [...arrayValue.value, buildDefault(arrayItemSchema.value)])
}

function removeArrayItem(index: number): void {
  commit(
    selfPointer.value,
    arrayValue.value.filter((_, itemIndex) => itemIndex !== index),
  )
}

// ---------------------------------------------------------------------------
// oneOf：kind 选择器 + 分支子表单（分支剔除判别字段，由选择器表达）
// ---------------------------------------------------------------------------

const discriminator = computed<Discriminator | null>(() =>
  info.value.kind === 'oneOf' ? (info.value.discriminator ?? null) : null,
)

const currentKind = computed<string | undefined>(() => {
  const disc = discriminator.value
  if (!disc) return undefined
  const value = objectValue.value[disc.property]
  return typeof value === 'string' && disc.options.some((option) => option.value === value)
    ? value
    : undefined
})

const activeBranchSchema = computed<JsonSchemaNode | null>(() => {
  const disc = discriminator.value
  if (!disc) return null
  const option = disc.options.find((candidate) => candidate.value === currentKind.value)
  if (!option) return null
  return stripDiscriminator(option.branch, disc.property)
})

function stripDiscriminator(branch: JsonSchemaNode, property: string): JsonSchemaNode {
  const properties = isPlainObject(branch.properties)
    ? (branch.properties as Record<string, JsonSchemaNode>)
    : undefined
  const stripped = properties
    ? Object.fromEntries(Object.entries(properties).filter(([key]) => key !== property))
    : undefined
  return {
    ...branch,
    // 兜底为空对象：无属性的分支按「无字段」object 渲染，而非 record
    properties: stripped ?? {},
    required: Array.isArray(branch.required)
      ? branch.required.filter((key) => key !== property)
      : undefined,
  }
}

function switchKind(value: unknown): void {
  const option = discriminator.value?.options.find((candidate) => candidate.value === value)
  if (!option) return
  commit(selfPointer.value, buildDefault(option.branch))
}
</script>

<style scoped>
/* 字段通用：紧凑密度（管理后台风格），label 上置、控件占满 */
.sform {
  min-width: 0;
  margin-bottom: 10px;
  font-size: 12px;
  color: #3a4048;
}

.sform:last-child {
  margin-bottom: 0;
}

.sform-field :deep(.el-select),
.sform-field :deep(.el-input-number) {
  width: 100%;
}

.sform-field :deep(.el-input-number .el-input__inner) {
  text-align: left;
}

.sform-field__label {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  margin-bottom: 4px;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  color: #5f6670;
}

.sform-field__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sform-field__req {
  flex-shrink: 0;
  color: var(--el-color-danger);
  font-style: normal;
}

.sform-field__error {
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--el-color-danger);
  word-break: break-all;
}

/* 命中错误：控件描红（input/select/input-number 通用 wrapper） */
.sform-field--error :deep(.el-input__wrapper),
.sform-field--error :deep(.el-select__wrapper),
.sform-field--error :deep(.el-textarea__inner) {
  box-shadow: 0 0 0 1px var(--el-color-danger) inset;
}

/* object 折叠分组 */
.sform-group {
  overflow: hidden;
  border: 1px solid #e2e5ea;
  border-radius: 6px;
  background: #ffffff;
}

.sform-group__head {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  background: #f7f8f9;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.sform-group__head:hover {
  background: #f2f4f6;
}

.sform-group__head:focus-visible {
  outline: 2px solid var(--el-color-primary-light-5);
  outline-offset: -2px;
}

.sform-group__chevron {
  flex-shrink: 0;
  width: 0;
  height: 0;
  border-top: 5px solid #8a919c;
  border-right: 4px solid transparent;
  border-left: 4px solid transparent;
  transform: rotate(-90deg);
  transition: transform 0.15s ease;
}

.sform-group.is-open .sform-group__chevron {
  transform: rotate(0deg);
}

.sform-group__title {
  font-size: 13px;
  font-weight: 600;
  color: #26292e;
  white-space: nowrap;
}

.sform-group__help {
  display: inline-flex;
}

.sform-group__error-hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--el-color-danger);
}

.sform-group.is-error .sform-group__title {
  color: var(--el-color-danger);
}

.sform-group__body {
  padding: 10px 10px 2px;
  border-top: 1px solid #eef0f2;
}

.sform-group--flat {
  overflow: visible;
  border: none;
  border-radius: 0;
  background: transparent;
}

.sform-group--flat .sform-group__body {
  padding: 0;
  border-top: none;
}

/* 属性网格：标量字段双列紧凑，容器字段整行 */
.sform-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 14px;
}

.sform-grid__item--wide {
  grid-column: 1 / -1;
}

.sform-empty {
  padding: 2px 0 8px;
  font-size: 11px;
  color: #9aa3ad;
}

/* record 键值行 */
.sform-record {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}

.sform-record__count,
.sform-array__count {
  margin-left: auto;
  flex-shrink: 0;
  font-weight: normal;
  font-size: 11px;
  color: #9aa3ad;
}

.sform-record__row {
  display: grid;
  grid-template-columns: minmax(90px, 160px) minmax(0, 1fr) auto;
  gap: 8px;
  align-items: start;
}

.sform-record__value {
  min-width: 0;
}

.sform-record__row.is-error :deep(.el-input__wrapper),
.sform-record__row.is-error :deep(.el-select__wrapper) {
  box-shadow: 0 0 0 1px var(--el-color-danger) inset;
}

.sform-record__tools,
.sform-array__tools {
  display: flex;
  justify-content: flex-start;
}

/* array */
.sform-array {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}

.sform-array__multi {
  margin-bottom: 10px;
}

.sform-array__card {
  overflow: hidden;
  border: 1px solid #e2e5ea;
  border-radius: 6px;
}

.sform-array__card.is-error {
  border-color: var(--el-color-danger-light-5);
}

.sform-array__card.is-error .sform-array__card-title {
  color: var(--el-color-danger);
}

.sform-array__card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 10px;
  background: #f7f8f9;
}

.sform-array__card-title {
  font-size: 12px;
  font-weight: 600;
  color: #3a4048;
}

.sform-array__card-body {
  padding: 10px 10px 2px;
}

.sform-array__row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.sform-array__row > .el-button {
  flex-shrink: 0;
}

.sform-array__row-control {
  flex: 1;
  min-width: 0;
}

.sform-array__row.is-error :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--el-color-danger) inset;
}

/* oneOf：左侧主色细条表达「kind 选择器 → 子表单」的从属关系 */
.sform-oneof {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 10px;
  padding-left: 10px;
  border-left: 2px solid var(--el-color-primary-light-7);
}

.sform-oneof__kind {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sform-oneof__kind-label {
  flex-shrink: 0;
  font-size: 12px;
  color: #5f6670;
}

.sform-oneof :deep(.sform-oneof__kind-select) {
  width: 220px;
}

/* unknown 只读兜底 */
.sform-unknown {
  padding: 8px 10px;
  border: 1px dashed #d3d8de;
  border-radius: 4px;
  background: #fafbfc;
  margin-bottom: 10px;
}

.sform-unknown__hint {
  font-size: 11px;
  color: #8a919c;
}

.sform-unknown__json {
  max-height: 180px;
  margin: 6px 0 0;
  overflow: auto;
  font-family: var(--admin-font-mono, monospace);
  font-size: 11px;
  line-height: 1.6;
  color: #5f6670;
  white-space: pre-wrap;
  word-break: break-all;
}

/* bare（数组行/记录值/分支子表单）内不留外边距，由行容器控制间距 */
.sform-array__row-control .sform,
.sform-record__value .sform {
  margin-bottom: 0;
}

/* 窄屏：属性网格降为单列 */
@media (max-width: 760px) {
  .sform-grid {
    grid-template-columns: 1fr;
  }
}
</style>
