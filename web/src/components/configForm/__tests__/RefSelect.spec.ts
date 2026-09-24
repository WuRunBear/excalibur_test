import { beforeAll, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia } from 'pinia'

import RefSelect from '../RefSelect.vue'
import {
  matchRefKeySource,
  matchRefSource,
  matchWidgetOverride,
} from '../refSources'

// api/admin 整体 mock（保留原模块其余导出），registries/config-index 均走 mock 数据
const mocks = vi.hoisted(() => ({
  fetchConfigIndex: vi.fn(),
  fetchRegistries: vi.fn(),
}))

vi.mock('@/api/admin', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/admin')>()
  return {
    ...original,
    fetchConfigIndex: mocks.fetchConfigIndex,
    fetchRegistries: mocks.fetchRegistries,
  }
})

// jsdom 无 ResizeObserver：Element Plus select 依赖，需打桩
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub)

beforeAll(() => {
  // Element Plus 弹层在 jsdom 缺少部分布局 API，静默避免噪音
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

/** config-index mock 载荷（五类 id 列表）。 */
const CONFIG_INDEX = {
  items: ['berry', 'wood', 'stone'],
  dialogues: ['greet-tree'],
  quests: ['quest-wood'],
  mapKeys: ['island', 'cave'],
  archetypes: ['boar', 'berry_bush'],
}

function mountSelect(
  props: Record<string, unknown>,
): VueWrapper {
  return mount(RefSelect, {
    props,
    global: { plugins: [ElementPlus, createPinia()] },
    attachTo: document.body,
  })
}

describe('refSources：REF_SOURCES / WIDGET_OVERRIDES 口径（对照本体 schema 确认）', () => {
  it('实体原型文件（文件根 = 单个 ArchetypeSchema）：behavior / components 键', () => {
    expect(matchRefSource('/behavior')).toBe('actions')
    expect(matchRefKeySource('/components')).toBe('components')
    // components 是「键引用」：value 不启用下拉
    expect(matchRefSource('/components')).toBeNull()
  })

  it('物品文件（文件根 = 单个 ItemKindSpec）：place.archetype', () => {
    expect(matchRefSource('/place/archetype')).toBe('archetypes')
  })

  it('crafting 规则：recipes 的 inputs/outputs[].kind → items', () => {
    expect(matchRefSource('/recipes/0/inputs/1/kind')).toBe('items')
    expect(matchRefSource('/recipes/2/outputs/0/kind')).toBe('items')
  })

  it('raid 规则：kinds[] 原型 kind 池 → archetypes', () => {
    expect(matchRefSource('/kinds/2')).toBe('archetypes')
  })

  it('任务文件：itemKind / rewards[].kind → items，victimKind → archetypes', () => {
    expect(matchRefSource('/quests/0/itemKind')).toBe('items')
    expect(matchRefSource('/quests/1/victimKind')).toBe('archetypes')
    expect(matchRefSource('/quests/0/submit/rewards/1/kind')).toBe('items')
  })

  it('对话文件：effect.questId → quests、effect.npcKind → archetypes', () => {
    expect(matchRefSource('/trees/0/nodes/greet/options/0/effect/questId')).toBe('quests')
    expect(matchRefSource('/trees/1/nodes/leave/options/2/effect/npcKind')).toBe('archetypes')
  })

  it('treeId 引用宽松兜底（如 DialogueSource 组件值）→ dialogues', () => {
    expect(matchRefSource('/components/DialogueSource/treeId')).toBe('dialogues')
    expect(matchRefSource('/treeId')).toBe('dialogues')
  })

  it('game.json：map.default → mapKeys、netSync.fields[].component → components', () => {
    expect(matchRefSource('/map/default')).toBe('mapKeys')
    expect(matchRefSource('/netSync/fields/0/component')).toBe('components')
  })

  it('未命中路径不启用下拉；systems 由 widget 接管不挂下拉', () => {
    expect(matchRefSource('/name')).toBeNull()
    expect(matchRefSource('/worldview/theme')).toBeNull()
    expect(matchRefSource('/systems/0/id')).toBeNull()
    expect(matchRefSource('/mode')).toBeNull()
  })

  it('WIDGET_OVERRIDES：/systems → systems-panel，其余不接管', () => {
    expect(matchWidgetOverride('/systems')?.id).toBe('systems-panel')
    expect(matchWidgetOverride('/systems/0')).toBeNull()
    expect(matchWidgetOverride('/flags')).toBeNull()
    expect(matchWidgetOverride('')).toBeNull()
  })
})

describe('RefSelect 组件', () => {
  it('注册表源加载失败 → 错误态提示，仍可切自定义值', async () => {
    mocks.fetchRegistries.mockRejectedValue(new Error('registry down'))
    const wrapper = mountSelect({ source: 'actions' })
    await flushPromises()

    expect(wrapper.text()).toContain('引用索引加载失败')
    // footer（teleport 到 body，persistent 常驻渲染）显示索引失败 + 自定义值入口
    const footer = document.body.querySelector('.refselect__footer')
    expect(footer?.textContent).toContain('索引加载失败')
    expect(footer?.textContent).toContain('使用自定义值')
    wrapper.unmount()
  })

  it('config-index 源：拉取后产出选项并展示当前值（含索引外值）', async () => {
    mocks.fetchConfigIndex.mockResolvedValue(CONFIG_INDEX)
    const wrapper = mountSelect({ source: 'items', modelValue: 'berry' })
    await flushPromises()

    const options = wrapper.findAllComponents({ name: 'ElOption' })
    expect(options.map((option) => option.props('value'))).toEqual(['berry', 'wood', 'stone'])
    expect(wrapper.findComponent({ name: 'ElSelect' }).props('modelValue')).toBe('berry')
    wrapper.unmount()
  })

  it('当前值不在索引内 → 原样展示，不清空', async () => {
    mocks.fetchConfigIndex.mockResolvedValue(CONFIG_INDEX)
    const wrapper = mountSelect({ source: 'items', modelValue: 'modded_extra_item' })
    await flushPromises()

    expect(wrapper.findComponent({ name: 'ElSelect' }).props('modelValue')).toBe(
      'modded_extra_item',
    )
    wrapper.unmount()
  })

  it('config-index 模块级缓存：换源不重复请求', async () => {
    const wrapper = mountSelect({ source: 'mapKeys', modelValue: 'island' })
    await flushPromises()
    expect(wrapper.findAllComponents({ name: 'ElOption' }).map((o) => o.props('value'))).toEqual([
      'island',
      'cave',
    ])
    expect(mocks.fetchConfigIndex).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('选中/创建值 → emit update:modelValue', async () => {
    const wrapper = mountSelect({ source: 'items', modelValue: '' })
    await flushPromises()

    await wrapper.findComponent({ name: 'ElSelect' }).vm.$emit('update:modelValue', 'wood')
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted?.at(-1)?.[0]).toBe('wood')
    wrapper.unmount()
  })

  it('footer「使用自定义值」→ 自由输入态提交，不清空手输', async () => {
    const wrapper = mountSelect({ source: 'items', modelValue: 'berry' })
    await flushPromises()

    const modeButton = Array.from(
      document.body.querySelectorAll('.refselect__footer button'),
    ).find((button) => button.textContent?.includes('使用自定义值'))
    expect(modeButton).toBeTruthy()
    modeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    // 切到自定义态：输入框保留当前值
    const customInput = wrapper.find('.refselect__custom-input input')
    expect((customInput.element as HTMLInputElement).value).toBe('berry')
    await customInput.setValue('my_custom_kind')
    await customInput.trigger('change')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toBe('my_custom_kind')

    // 可切回列表态
    const back = wrapper.findAll('.refselect__custom button')
    expect(back.map((button) => button.text())).toContain('从列表选择')
    wrapper.unmount()
  })
})
