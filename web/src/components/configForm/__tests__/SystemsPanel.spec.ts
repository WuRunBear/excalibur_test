import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'

import SchemaForm from '../SchemaForm.vue'
import SystemsPanel from '../SystemsPanel.vue'
import type { JsonSchemaNode } from '../types'

// api/admin mock：registries 按契约形状（id + description + configSchema）
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

const REGISTRIES = {
  systems: [
    {
      id: 'interaction',
      description: '玩家交互（采集 / 放置）',
      configSchema: {
        type: 'object',
        title: '参数',
        properties: { range: { type: 'integer', title: '范围', default: 24 } },
      },
    },
    { id: 'ai', description: 'AI 行为调度' },
    {
      id: 'dayNight',
      description: '昼夜循环',
      configSchema: {
        type: 'object',
        properties: { cycleLengthSec: { type: 'number', title: '周期（秒）' } },
      },
    },
  ],
  archetypes: [],
  actions: [],
  components: {},
  mapGenerators: [],
}

/** game.json 风格 fixture：systems 条目 = SystemEnableEntrySchema（id / enabled? / config?）。 */
const GAME_SCHEMA: JsonSchemaNode = {
  type: 'object',
  title: 'game',
  properties: {
    id: { type: 'string', title: '游戏 ID' },
    systems: {
      type: 'array',
      title: '系统',
      items: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', title: '系统 ID' },
          enabled: { type: 'boolean', title: '启用' },
          config: { type: 'object', additionalProperties: true, title: '参数' },
        },
      },
    },
  },
}

const GAME_MODEL = {
  id: 'survival-island',
  systems: [{ id: 'interaction', config: { range: 24 } }, { id: 'mysterySystem' }],
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

async function systemsPayload(wrapper: VueWrapper): Promise<Array<Record<string, unknown>>> {
  const payload = lastPayload(wrapper)
  await wrapper.setProps({ modelValue: payload })
  return payload['systems'] as Array<Record<string, unknown>>
}

beforeEach(() => {
  mocks.fetchRegistries.mockReset()
  mocks.fetchRegistries.mockResolvedValue(REGISTRIES)
})

describe('SchemaForm × SystemsPanel（systems[] widget 接管）', () => {
  it('/systems 数组被 SystemsPanel 接管：已启用高亮、未注册标注、可添加行', async () => {
    const wrapper = mountForm()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'SystemsPanel' }).exists()).toBe(true)
    // 默认数组卡片渲染被接管
    expect(wrapper.find('.sform-array__card').exists()).toBe(false)
    // 顶部提示 + 计数（mysterySystem 无 enabled:false → 按缺省语义计为启用）
    expect(wrapper.text()).toContain('启用的系统需配套 rules/<同名>.json')
    expect(wrapper.text()).toContain('已启用 2 / 共 2')
    // 已启用卡高亮；未注册条目标注
    expect(wrapper.findAll('.syspanel__card.is-on')).toHaveLength(1)
    expect(wrapper.text()).toContain('interaction')
    expect(wrapper.text()).toContain('未注册')
    // 注册表有而草稿未引用的系统 → 可添加行
    expect(
      wrapper.findAll('button').some((button) => button.attributes('aria-label') === '添加系统 ai'),
    ).toBe(true)
    wrapper.unmount()
  })

  it('勾选添加：以 { id } 最小骨架整组写回', async () => {
    const wrapper = mountForm()
    await flushPromises()

    const addButton = wrapper
      .findAll('button')
      .find((button) => button.attributes('aria-label') === '添加系统 ai')
    await addButton?.trigger('click')

    const systems = await systemsPayload(wrapper)
    expect(systems).toHaveLength(3)
    expect(systems[2]).toEqual({ id: 'ai' })
    wrapper.unmount()
  })

  it('启停开关：停用写 enabled:false（保留参数），再启用移除该键', async () => {
    const wrapper = mountForm()
    await flushPromises()

    await wrapper.findComponent({ name: 'ElSwitch' }).vm.$emit('change', false)
    let systems = await systemsPayload(wrapper)
    expect(systems[0]).toEqual({ id: 'interaction', enabled: false, config: { range: 24 } })
    expect(wrapper.findAll('.syspanel__card.is-on')).toHaveLength(0)

    await wrapper.findComponent({ name: 'ElSwitch' }).vm.$emit('change', true)
    systems = await systemsPayload(wrapper)
    expect(systems[0]).toEqual({ id: 'interaction', config: { range: 24 } })
    wrapper.unmount()
  })

  it('config 子表单：注册表 configSchema 驱动，mutate 冒泡到根草稿', async () => {
    const wrapper = mountForm()
    await flushPromises()

    // 展开首张卡的参数折叠区
    const fold = wrapper.findAll('.syspanel__fold')[0]
    await fold?.trigger('click')

    const inputNumber = wrapper.findComponent({ name: 'ElInputNumber' })
    expect(inputNumber.exists()).toBe(true)
    await inputNumber.vm.$emit('update:modelValue', 30)

    const systems = await systemsPayload(wrapper)
    expect(systems[0]['config']).toEqual({ range: 30 })
    wrapper.unmount()
  })

  it('已注册但无 configSchema → 展开后提示源码模式编辑', async () => {
    const wrapper = mountForm({ id: 'x', systems: [{ id: 'ai' }] })
    await flushPromises()

    const fold = wrapper.findAll('.syspanel__fold')[0]
    await fold?.trigger('click')
    expect(wrapper.text()).toContain('该系统无 schema，请用源码模式编辑')
    wrapper.unmount()
  })

  it('422 错误映射：config 子树命中时卡片头标注「参数含校验错误」', async () => {
    const wrapper = mountForm(GAME_MODEL, GAME_SCHEMA, {
      errors: { '/systems/0/config/range': '必须为整数' },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('参数含校验错误')
    wrapper.unmount()
  })

  it('未注册条目：可移除（已注册条目不可移除，仅停用）', async () => {
    const wrapper = mountForm()
    await flushPromises()

    const remove = wrapper
      .findAll('button')
      .find((button) => button.attributes('aria-label') === '移除 mysterySystem')
    expect(remove).toBeTruthy()
    await remove?.trigger('click')

    const systems = await systemsPayload(wrapper)
    expect(systems).toEqual([{ id: 'interaction', config: { range: 24 } }])
    wrapper.unmount()
  })

  it('注册表加载失败：提示 + 重试，草稿条目不丢', async () => {
    mocks.fetchRegistries.mockRejectedValue(new Error('registry down'))
    const wrapper = mountForm()
    await flushPromises()

    expect(wrapper.text()).toContain('系统清单加载失败')
    expect(wrapper.text()).toContain('interaction') // 草稿条目仍展示

    mocks.fetchRegistries.mockResolvedValue(REGISTRIES)
    const retry = wrapper.findAll('button').find((button) => button.text() === '重试')
    await retry?.trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('系统清单加载失败')
    expect(
      wrapper.findAll('button').some((button) => button.attributes('aria-label') === '添加系统 ai'),
    ).toBe(true)
    wrapper.unmount()
  })

  it('无 pinia 环境（注册表不可达）→ 回落默认数组渲染，渲染器可独立挂载', () => {
    // 清除前序测试遗留的全局 active pinia，模拟无 provider 环境
    setActivePinia(undefined)
    const wrapper = mountForm(GAME_MODEL, GAME_SCHEMA, {}, false)
    expect(wrapper.findComponent({ name: 'SystemsPanel' }).exists()).toBe(false)
    expect(wrapper.find('.sform-array__card').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('SystemsPanel 直挂（不经 SchemaForm）', () => {
  it('change/mutate 协议与 config 指针', async () => {
    const wrapper = mount(SystemsPanel, {
      props: {
        modelValue: [{ id: 'interaction', config: { range: 24 } }],
        path: '/systems',
        errors: { '/systems/0/config/range': '必须为整数' },
      },
      global: { plugins: [ElementPlus, createPinia()] },
    })
    await flushPromises()

    // config 折叠区默认收起：展开后子表单才挂载
    await wrapper.find('.syspanel__fold').trigger('click')

    // mutate 透传：pointer 为文件内全路径
    await wrapper
      .findComponent({ name: 'SchemaForm' })
      .vm.$emit('mutate', '/systems/0/config/range', 48)
    expect(wrapper.emitted('mutate')?.at(-1)).toEqual(['/systems/0/config/range', 48])
    wrapper.unmount()
  })
})
