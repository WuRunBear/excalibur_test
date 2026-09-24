/**
 * 引用字段 / widget 映射层（§3.5 RefSelect + SystemsPanel）。
 *
 * - REF_SOURCES：JSON pointer 模式 → 引用数据源（下拉 widget 的口径表）。
 *   模式为段级通配：'*' 匹配一个段、'**' 匹配任意段（含零段）；指针为
 *   SchemaForm 的文件内相对指针（每个配置文件以文件根起渲染）。
 *   口径逐条对照本体 schema 确认（game_server_test/framework/config/schema/）。
 * - WIDGET_OVERRIDES：pointer 模式 → 专用编辑 widget（整节点接管默认渲染）。
 * - 数据解析：注册表类源走 stores/registry（既有 store）；配置索引类源直接调
 *   fetchConfigIndex（模块级缓存 + games.epoch 失效），不新建 store 文件。
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'

import { fetchConfigIndex } from '@/api/admin'
import type { ConfigIndexPayload, RegistriesPayload } from '@/api/admin'
import { useGamesStore } from '@/stores/games'
import { useRegistryStore } from '@/stores/registry'

import { isPlainObject } from './schemaUtils'
import type { JsonSchemaNode } from './types'

// ---------------------------------------------------------------------------
// 引用源口径表（RefSelect）
// ---------------------------------------------------------------------------

export type RefSourceId =
  | 'actions'
  | 'components'
  | 'systems'
  | 'items'
  | 'dialogues'
  | 'quests'
  | 'mapKeys'
  | 'archetypes'

/** 源展示名（RefSelect placeholder 等文案用）。 */
export const REF_SOURCE_META: Record<RefSourceId, { label: string }> = {
  actions: { label: '行为' },
  components: { label: '组件' },
  systems: { label: '系统' },
  items: { label: '物品' },
  dialogues: { label: '对话树' },
  quests: { label: '任务' },
  mapKeys: { label: '地图' },
  archetypes: { label: '原型' },
}

export interface RefSourceRule {
  /** JSON pointer 段级通配模式（'*' 一个段、'**' 任意段，示例见 REF_SOURCES 表）。 */
  pattern: string
  source: RefSourceId
  /** 命中目标：value 字段（默认）或 record 键（如实体 components 表键）。 */
  target?: 'value' | 'key'
}

// 引用型字段映射（路径均已对照本体 schema 确认；模式串见下表 code，注释内
// 不写通配串——`*`+`/` 会截断块注释）：
// - 实体原型 game/entities/*.json：文件根 = 单个 ArchetypeSchema（非数组）——
//   behavior → actions 注册表（ArchetypeSchema.behavior，沿用计划 §3.5 口径）、
//   components record 键 → componentRegistry（ArchetypeSchema.components）。
// - 物品 game/items/*.json：文件根 = 单个 ItemKindSpec——place.archetype →
//   实体原型 kind（ItemKindSchema PlaceEffect.archetype）。
// - 合成规则 rules/crafting.json：recipes 的 inputs/outputs[].kind → items
//   （RuleSchema CraftingRuleSchema 的 RecipeInput.kind，引用 item kind）。
// - 袭击规则 rules/raid.json：kinds[] → 实体原型 kind 池（RaidRuleSchema.kinds）。
// - 任务 quests/*.json：quests[].itemKind、quests[].submit.rewards[].kind →
//   items；quests[].victimKind → 实体原型（QuestSchema）。
// - 对话 dialogues/*.json：effect.questId → quests、effect.npcKind → 实体原型
//   （DialogueSchema DialogueEffect）；treeId 引用（如 DialogueSource 组件值）
//   → dialogues（宽松兜底）。
// - game.json：map.default → mapKeys（maps/registry.json 表键）、
//   netSync.fields[].component → 组件注册表（GameDefinitionSchema）。
//
// 未命中的路径不启用下拉；systems[].id 不入表——systems[] 整节点由
// WIDGET_OVERRIDES 的 SystemsPanel 管辖（清单勾选即引用编辑）。
export const REF_SOURCES: RefSourceRule[] = [
  { pattern: '**/behavior', source: 'actions' },
  { pattern: '**/components', source: 'components', target: 'key' },
  { pattern: '**/place/archetype', source: 'archetypes' },
  { pattern: '**/recipes/*/inputs/*/kind', source: 'items' },
  { pattern: '**/recipes/*/outputs/*/kind', source: 'items' },
  { pattern: '**/kinds/*', source: 'archetypes' },
  { pattern: '**/quests/*/itemKind', source: 'items' },
  { pattern: '**/quests/*/victimKind', source: 'archetypes' },
  { pattern: '**/quests/*/submit/rewards/*/kind', source: 'items' },
  { pattern: '**/trees/*/nodes/*/options/*/effect/questId', source: 'quests' },
  { pattern: '**/trees/*/nodes/*/options/*/effect/npcKind', source: 'archetypes' },
  { pattern: '**/treeId', source: 'dialogues' },
  { pattern: '**/map/default', source: 'mapKeys' },
  { pattern: '**/netSync/fields/*/component', source: 'components' },
]

/** 段级通配匹配：'*' 一个段，'**' 零或多个段。 */
function matchSegments(pattern: string[], segments: string[]): boolean {
  if (pattern.length === 0) return segments.length === 0
  const head = pattern[0] as string
  const rest = pattern.slice(1)
  if (head === '**') {
    for (let skip = 0; skip <= segments.length; skip += 1) {
      if (matchSegments(rest, segments.slice(skip))) return true
    }
    return false
  }
  const first = segments[0]
  if (first === undefined) return false
  if (head !== '*' && head !== first) return false
  return matchSegments(rest, segments.slice(1))
}

function matchPattern(pattern: string, pointer: string): boolean {
  const patternSegments = pattern.split('/').filter((segment) => segment.length > 0)
  const pointerSegments = pointer.split('/').filter((segment) => segment.length > 0)
  return matchSegments(patternSegments, pointerSegments)
}

function firstHit(pointer: string, target: 'value' | 'key'): RefSourceId | null {
  for (const rule of REF_SOURCES) {
    if ((rule.target ?? 'value') !== target) continue
    if (matchPattern(rule.pattern, pointer)) return rule.source
  }
  return null
}

/** value 字段命中的引用源；未命中返回 null（不启用下拉）。 */
export function matchRefSource(pointer: string): RefSourceId | null {
  return firstHit(pointer, 'value')
}

/** record 自身指针命中的「键引用源」（如组件表键）；未命中返回 null。 */
export function matchRefKeySource(pointer: string): RefSourceId | null {
  return firstHit(pointer, 'key')
}

// ---------------------------------------------------------------------------
// widget 接管表（SystemsPanel）
// ---------------------------------------------------------------------------

export interface WidgetOverrideRule {
  /** widget 标识（SchemaForm 按此分支挂载对应组件）。 */
  id: string
  /** 接管的数组节点 pointer 模式。 */
  pattern: string
}

/**
 * 专用 widget 接管表：命中的节点以 widget 替代默认渲染。
 * - systems-panel：game.json systems[]（SystemEnableEntrySchema：
 *   `{ id, enabled?, config? }`）→ SystemsPanel（注册表清单勾选 + config 子表单）。
 * - components-panel：实体文件的 components record（ArchetypeSchema.components，
 *   值为 z.unknown 无结构描述）→ ComponentsPanel（注册表 components 的
 *   configSchema 驱动子表单）。
 *
 * 两者仅当注册表 store 可达（pinia 环境）时启用；无注册表环境回落默认渲染。
 * 优先级：WIDGET_OVERRIDES > REF_SOURCES（record 键增强）> 默认渲染——同一
 * 节点只会走一条路径：接管生效时键选择收敛到面板内的注册表下拉，REF_SOURCES
 * 的键引用仅在回落渲染（无注册表环境）时作为降级增强，不出现双控件竞争。
 */
export const WIDGET_OVERRIDES: WidgetOverrideRule[] = [
  { id: 'systems-panel', pattern: '**/systems' },
  { id: 'components-panel', pattern: '**/components' },
]

/** 数组节点命中的 widget 接管规则；未命中返回 null。 */
export function matchWidgetOverride(pointer: string): WidgetOverrideRule | null {
  for (const rule of WIDGET_OVERRIDES) {
    if (matchPattern(rule.pattern, pointer)) return rule
  }
  return null
}

// ---------------------------------------------------------------------------
// store 探测（无 pinia 环境降级，供单测/脱离管理台的挂载兜底）
// ---------------------------------------------------------------------------

type RegistryStore = ReturnType<typeof useRegistryStore>
type GamesStore = ReturnType<typeof useGamesStore>

/** pinia 不可用时返回 null（调用方降级），可用时返回 store 实例。 */
export function tryUseRegistryStore(): RegistryStore | null {
  try {
    return useRegistryStore()
  } catch {
    return null
  }
}

function tryUseGamesStore(): GamesStore | null {
  try {
    return useGamesStore()
  } catch {
    return null
  }
}

/** 注册表 store 是否可达（SystemsPanel 接管 /systems 的门槛）。 */
export function hasRegistryAccess(): boolean {
  return tryUseRegistryStore() !== null
}

// ---------------------------------------------------------------------------
// 注册表 systems 清单（SystemsPanel 数据源）
// ---------------------------------------------------------------------------

/** 注册表条目元数据（systems / components 通用形状：id + description + configSchema）。 */
export interface RegistryEntryMeta {
  id: string
  description?: string
  configSchema?: JsonSchemaNode
}

/** 注册表 systems 条目（宽容归一化后）。 */
export type SystemEntryMeta = RegistryEntryMeta
/** 注册表 components 条目（宽容归一化后）。 */
export type ComponentEntryMeta = RegistryEntryMeta

/** configSchema 宽容校验：非对象（含缺省）视为无 schema。 */
export function normalizeConfigSchema(value: unknown): JsonSchemaNode | undefined {
  return isPlainObject(value) ? (value as JsonSchemaNode) : undefined
}

function normalizeEntry(id: string, entry: unknown): RegistryEntryMeta {
  const source = isPlainObject(entry) ? entry : {}
  return {
    id,
    description: typeof source['description'] === 'string' ? source['description'] : undefined,
    configSchema: normalizeConfigSchema(source['configSchema']),
  }
}

function normalizeSystemEntries(list: RegistriesPayload['systems']): SystemEntryMeta[] {
  if (!Array.isArray(list)) return []
  return list
    .filter((entry) => typeof entry.id === 'string' && entry.id.length > 0)
    .map((entry) => normalizeEntry(entry.id, entry))
}

function normalizeComponentEntries(map: RegistriesPayload['components']): ComponentEntryMeta[] {
  if (!isPlainObject(map)) return []
  return Object.entries(map)
    .filter(([id]) => typeof id === 'string' && id.length > 0)
    .map(([id, entry]) => normalizeEntry(id, entry))
}

/**
 * 注册表分节数据（systems / components 共用骨架）：挂载时 ensureLoaded 一次
 * （幂等、失败可重试）；games.epoch 切换由 registry store 自身 reset，
 * 经重试/重挂载重取。
 */
function useRegistrySection<T>(
  select: (payload: RegistriesPayload) => T,
  initial: T,
): {
  data: ComputedRef<T>
  state: Ref<'loading' | 'ready' | 'error'>
  retry: () => void
} {
  const store = tryUseRegistryStore()
  const state = ref<'loading' | 'ready' | 'error'>(store ? 'loading' : 'error')
  const data = computed<T>(() => (store?.data ? select(store.data) : initial))

  async function load(): Promise<void> {
    if (!store) return
    state.value = 'loading'
    try {
      await store.ensureLoaded()
      state.value = store.loaded ? 'ready' : 'error'
    } catch {
      state.value = 'error'
    }
  }

  if (store) {
    onMounted(() => {
      void load()
    })
  }

  return { data, state, retry: () => void load() }
}

/** 注册表 systems 清单（SystemsPanel 数据源）。 */
export function useSystemsEntries(): {
  entries: ComputedRef<SystemEntryMeta[]>
  state: Ref<'loading' | 'ready' | 'error'>
  retry: () => void
} {
  const { data, state, retry } = useRegistrySection(
    (payload) => normalizeSystemEntries(payload.systems),
    [],
  )
  return { entries: data, state, retry }
}

/** 注册表 components 清单（ComponentsPanel 数据源）。 */
export function useComponentEntries(): {
  entries: ComputedRef<ComponentEntryMeta[]>
  state: Ref<'loading' | 'ready' | 'error'>
  retry: () => void
} {
  const { data, state, retry } = useRegistrySection(
    (payload) => normalizeComponentEntries(payload.components),
    [],
  )
  return { entries: data, state, retry }
}

// ---------------------------------------------------------------------------
// config-index：无独立 store——组件内拉取 + 模块级缓存（games.epoch 失效）
// ---------------------------------------------------------------------------

let configIndexCache: ConfigIndexPayload | null = null
let configIndexEpoch = -1
let configIndexInflight: Promise<ConfigIndexPayload> | null = null

function currentGamesEpoch(): number {
  return tryUseGamesStore()?.epoch ?? 0
}

/** fetchConfigIndex 的模块级缓存版；失败不缓存（下次调用重取）。 */
export function fetchConfigIndexCached(): Promise<ConfigIndexPayload> {
  const epoch = currentGamesEpoch()
  if (configIndexCache && configIndexEpoch === epoch) return Promise.resolve(configIndexCache)
  if (!configIndexInflight) {
    const requestEpoch = epoch
    configIndexInflight = fetchConfigIndex()
      .then((data) => {
        configIndexCache = data
        configIndexEpoch = requestEpoch
        configIndexInflight = null
        return data
      })
      .catch((err: unknown) => {
        configIndexInflight = null
        throw err
      })
  }
  return configIndexInflight
}

// ---------------------------------------------------------------------------
// 引用源选项解析（RefSelect 数据源）
// ---------------------------------------------------------------------------

export interface RefOption {
  value: string
  description?: string
}

/** 注册表承载的源（条目含 description 元数据）；其余来自 config-index。 */
const REGISTRY_SOURCES = new Set<RefSourceId>(['actions', 'components', 'systems'])

function stringOptions(values: string[]): RefOption[] {
  return values.filter((value) => typeof value === 'string').map((value) => ({ value }))
}

function registryOptions(data: RegistriesPayload | null, source: RefSourceId): RefOption[] {
  if (!data) return []
  if (source === 'components') {
    return Object.entries(data.components).map(([id, entry]) => ({
      value: id,
      description: entry && typeof entry.description === 'string' ? entry.description : undefined,
    }))
  }
  if (source !== 'actions' && source !== 'systems') return []
  return data[source].map((entry) => ({
    value: entry.id,
    description: typeof entry.description === 'string' ? entry.description : undefined,
  }))
}

function indexOptions(data: ConfigIndexPayload, source: RefSourceId): RefOption[] {
  switch (source) {
    case 'items':
      return stringOptions(data.items)
    case 'dialogues':
      return stringOptions(data.dialogues)
    case 'quests':
      return stringOptions(data.quests)
    case 'mapKeys':
      return stringOptions(data.mapKeys)
    case 'archetypes':
      return stringOptions(data.archetypes)
    default:
      return []
  }
}

/**
 * 引用源选项（RefSelect 用）：注册表源走 registry store（ensureLoaded 幂等），
 * 索引源走 config-index 模块缓存；games.epoch 变化自动重取（跨游戏防串）。
 */
export function useRefOptions(source: RefSourceId): {
  options: Ref<RefOption[]>
  state: Ref<'loading' | 'ready' | 'error'>
  refresh: () => Promise<void>
} {
  const options = ref<RefOption[]>([])
  const state = ref<'loading' | 'ready' | 'error'>('loading')

  async function refresh(): Promise<void> {
    state.value = 'loading'
    try {
      if (REGISTRY_SOURCES.has(source)) {
        const store = tryUseRegistryStore()
        if (!store) throw new Error('注册表不可用')
        await store.ensureLoaded()
        if (!store.loaded) throw new Error('注册表加载失败')
        options.value = registryOptions(store.data, source)
      } else {
        options.value = indexOptions(await fetchConfigIndexCached(), source)
      }
      state.value = 'ready'
    } catch {
      options.value = []
      state.value = 'error'
    }
  }

  onMounted(() => {
    void refresh()
  })

  const games = tryUseGamesStore()
  if (games) {
    watch(
      () => games.epoch,
      () => {
        void refresh()
      },
    )
  }

  return { options, state, refresh }
}
