import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'

import ComponentsPanel from '../ComponentsPanel.vue'
import RefSelect from '../RefSelect.vue'
import SchemaForm from '../SchemaForm.vue'
import type { JsonSchemaNode } from '../types'

// api/admin mock：registries components 含 有/无 configSchema 与 null 条目三类
const mocks = vi.hoisted(() => ({
  fetchRegistries: vi.fn(),
}))

vi.mock('@/api/admin', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/admin')>()
  return {
    ...original,
    fetchRegistries: mocks.fetchRegistries,
  }
})

// jsdom 无 ResizeObserver：Element Plus 依赖，需打桩
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub)

beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const HEALTH_SCHEMA = {
  type: 'object',
  title: '参数',
  properties: {
    current: { type: 'integer', title: '当前', default: 10 },
    max: { type: 'integer', title: '上限', default: 20 },
  },
}

const MANA_SCHEMA = {
  type: 'object',
  title: '参数',
  properties: { current: { type: 'integer', title: '当前值', default: 0 } },
}

const REGISTRIES = {
  systems: [],
  archetypes: [],
  actions: [],
  mapGenerators: [],
  components: {
    Transform: null,
    Health: { id: 'Health', description: '生命值组件', configSchema: HEALTH_SCHEMA },
    Mana: { id: 'Mana', description: '法力组件', configSchema: MANA_SCHEMA },
    Collider: { id: 'Collider', description: '碰撞体' },
  },
}

/** 实体文件风格 fixture：components 为 z.record(unknown) 的 record（值无结构）。 */
const GAME_SCHEMA: JsonSchemaNode = {
  type: 'object',
  title: 'archetype',
  properties: {
    kind: { type: 'string', title: 'kind' },
    components: { type: 'object', additionalProperties: true, title: '组件初值表' },
  },
}

const GAME_MODEL = {
  kind: 'boar',
  components: { Transform: {}, Health: { current: 30, max: 60 }, CustomFlag: true },
}

function mountForm(
  modelValue: unknown = GAME_MODEL,
  schema: JsonSchemaNode = GAME_SCHEMA,
  extraProps: Record<string, unknown> = {},
  withPinia = true,
): VueWrapper {
  const plugins: unknown[] = [ElementPlus]
  if (withPinia) plugins.push(createPinia())
  return mount(SchemaForm, {
    props: { schema, modelValue, ...extraProps },
    global: { plugins: plugins as never },
    attachTo: document.body,
  })
}

function lastPayload(wrapper: VueWrapper): Record<string, unknown> {
  const emitted = wrapper.emitted('update:modelValue')
  expect(emitted).toBeTruthy()
  const last = emitted?.at(-1)?.[0]
  expect(last).toBeTruthy()
  return last as Record<string, unknown>
}

async function componentsPayload(wrapper: VueWrapper): Promise<Record<string, unknown>> {
  const payload = lastPayload(wrapper)
  await wrapper.setProps({ modelValue: payload })
  return payload['components'] as Record<string, unknown>
}

/** 通过 add 行的 RefSelect 选中组件名（模拟下拉选择/allow-create）。 */
async function pickAddKey(wrapper: VueWrapper, key: string): Promise<void> {
  await wrapper.findComponent({ name: 'RefSelect' }).vm.$emit('update:modelValue', key)
}

beforeEach(() => {
  mocks.fetchRegistries.mockReset()
  mocks.fetchRegistries.mockResolvedValue(REGISTRIES)
})

describe('SchemaForm × ComponentsPanel（components record widget 接管）', () => {
  it('components record 被接管：有 schema 卡主色描边 + 子表单默认展开', async () => {
    const wrapper = mountForm()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'ComponentsPanel' }).exists()).toBe(true)
    // 默认键值行渲染被接管
    expect(wrapper.find('.sform-record__row').exists()).toBe(false)
    // 顶部提示 + 计数
    expect(wrapper.text()).toContain('组件 config 表单由注册表 configSchema 驱动')
    expect(wrapper.text()).toContain('3 个组件')
    // Health 有 schema → 高亮 + 默认展开（InputNumber 可见）；Transform 注册无 schema；CustomFlag 未注册
    expect(wrapper.findAll('.cmppanel__card.is-schema')).toHaveLength(1)
    expect(wrapper.findComponent({ name: 'ElInputNumber' }).exists()).toBe(true)
    expect(wrapper.text()).toContain('有 schema')
    expect(wrapper.text()).toContain('无 schema')
    expect(wrapper.text()).toContain('未注册')
    wrapper.unmount()
  })

  it('config 子表单 mutate 冒泡到根草稿：只改目标键、键序保持', async () => {
    const wrapper = mountForm()
    await flushPromises()

    const inputNumber = wrapper.findComponent({ name: 'ElInputNumber' })
    await inputNumber.vm.$emit('update:modelValue', 35)

    const components = await componentsPayload(wrapper)
    expect(components['Health']).toEqual({ current: 35, max: 60 })
    expect(components['Transform']).toEqual({})
    expect(Object.keys(components)).toEqual(['Transform', 'Health', 'CustomFlag'])
    wrapper.unmount()
  })

  it('errors 命中 /components/<key>/... → 卡片标红并提示', async () => {
    const wrapper = mountForm(GAME_MODEL, GAME_SCHEMA, {
      errors: { '/components/Health/current': '必须为整数' },
    })
    await flushPromises()

    expect(wrapper.findAll('.cmppanel__card.is-error')).toHaveLength(1)
    expect(wrapper.text()).toContain('参数含校验错误')
    wrapper.unmount()
  })

  it('新增键（有 schema）→ buildDefault 最小骨架 + 下拉清空', async () => {
    const wrapper = mountForm()
    await flushPromises()

    await pickAddKey(wrapper, 'Mana')
    expect(wrapper.text()).not.toContain('该组件无 schema，将以空对象添加')
    const addButton = wrapper
      .findAll('button')
      .find((b) => b.attributes('aria-label') === '添加组件')
    await addButton?.trigger('click')

    const components = await componentsPayload(wrapper)
    expect(components['Mana']).toEqual({ current: 0 }) // buildDefault 骨架（default 回填）
    expect(Object.keys(components)).toEqual(['Transform', 'Health', 'CustomFlag', 'Mana'])
    // 选区清空
    expect(wrapper.findComponent({ name: 'RefSelect' }).props('modelValue')).toBe('')
    // 新卡默认展开 → is-schema 高亮 +1
    expect(wrapper.findAll('.cmppanel__card.is-schema')).toHaveLength(2)
    wrapper.unmount()
  })

  it('新增键（无 schema）→ 空对象 + 源码模式提示', async () => {
    const wrapper = mountForm()
    await flushPromises()

    await pickAddKey(wrapper, 'Collider')
    expect(wrapper.text()).toContain('该组件无 schema，将以空对象添加')
    const addButton = wrapper
      .findAll('button')
      .find((b) => b.attributes('aria-label') === '添加组件')
    await addButton?.trigger('click')

    const components = await componentsPayload(wrapper)
    expect(components['Collider']).toEqual({})
    // 新卡默认展开 → 降级提示可见
    expect(wrapper.text()).toContain('该组件无 schema，请用源码模式编辑')
    wrapper.unmount()
  })

  it('新增已存在的键 → 添加按钮禁用', async () => {
    const wrapper = mountForm()
    await flushPromises()

    await pickAddKey(wrapper, 'Health')
    const addButton = wrapper
      .findAll('button')
      .find((b) => b.attributes('aria-label') === '添加组件')
    expect(addButton?.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('组件已存在')
    wrapper.unmount()
  })

  it('删除键：整组写回且其余键保留', async () => {
    const wrapper = mountForm()
    await flushPromises()

    const remove = wrapper
      .findAll('button')
      .find((b) => b.attributes('aria-label') === '删除 Transform')
    await remove?.trigger('click')

    const components = await componentsPayload(wrapper)
    expect(Object.keys(components)).toEqual(['Health', 'CustomFlag'])
    expect(components['Health']).toEqual({ current: 30, max: 60 })
    wrapper.unmount()
  })

  it('键改名：blur/enter 提交、保序、值随迁', async () => {
    const wrapper = mountForm()
    await flushPromises()

    const keyInput = wrapper.find('.cmppanel__key input')
    expect((keyInput.element as HTMLInputElement).value).toBe('Transform')
    await keyInput.setValue('Transform2')
    await keyInput.trigger('change')

    const components = await componentsPayload(wrapper)
    expect(Object.keys(components)).toEqual(['Transform2', 'Health', 'CustomFlag'])
    expect(components['Transform2']).toEqual({})
    wrapper.unmount()
  })

  it('键改名重名保护：目标键已存在时拒绝并回退输入', async () => {
    const wrapper = mountForm()
    await flushPromises()

    const inputs = wrapper.findAll('.cmppanel__key input')
    await inputs[1].setValue('Transform') // Health → Transform（已存在）
    await inputs[1].trigger('change')

    // 重名拒绝：无任何写回，草稿保持原状
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    // 输入框回退为原键名
    expect((inputs[1].element as HTMLInputElement).value).toBe('Health')
    wrapper.unmount()
  })

  it('注册表加载失败：提示 + 重试，草稿卡片不丢', async () => {
    mocks.fetchRegistries.mockRejectedValue(new Error('registry down'))
    const wrapper = mountForm()
    await flushPromises()

    expect(wrapper.text()).toContain('注册表加载失败')
    expect(wrapper.findAll('.cmppanel__card').length).toBe(3) // 草稿卡片仍在

    mocks.fetchRegistries.mockResolvedValue(REGISTRIES)
    const retry = wrapper.findAll('button').find((b) => b.text() === '重试')
    await retry?.trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('注册表加载失败')
    wrapper.unmount()
  })

  it('无 pinia 环境（注册表不可达）→ 回落默认键值行渲染', () => {
    setActivePinia(undefined)
    const wrapper = mountForm(GAME_MODEL, GAME_SCHEMA, {}, false)
    expect(wrapper.findComponent({ name: 'ComponentsPanel' }).exists()).toBe(false)
    expect(wrapper.find('.sform-record__row').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('ComponentsPanel 直挂（不经 SchemaForm）', () => {
  it('mutate 冒泡 pointer 为全路径、change 写回整组、错误标红', async () => {
    const wrapper = mount(ComponentsPanel, {
      props: {
        modelValue: { Health: { current: 1, max: 2 } },
        path: '/components',
        errors: { '/components/Health/current': '必须为整数' },
      },
      global: { plugins: [ElementPlus, createPinia()] },
      attachTo: document.body,
    })
    await flushPromises()

    expect(wrapper.find('.cmppanel__card.is-error').exists()).toBe(true)
    // Health 有 schema → 默认展开，子表单可寻址
    const child = wrapper.findComponent({ name: 'SchemaForm' })
    expect(child.exists()).toBe(true)
    await child.vm.$emit('mutate', '/components/Health/current', 5)
    expect(wrapper.emitted('mutate')?.at(-1)).toEqual(['/components/Health/current', 5])

    const remove = wrapper
      .findAll('button')
      .find((b) => b.attributes('aria-label') === '删除 Health')
    await remove?.trigger('click')
    expect(wrapper.emitted('change')?.at(-1)?.[0]).toEqual({})
    wrapper.unmount()
  })
})
