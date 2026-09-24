import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'

import SchemaForm from '../SchemaForm.vue'
import {
  buildDefault,
  describeSchema,
  errorInSubtree,
  getDiscriminator,
  pointerJoin,
  setAtPath,
} from '../schemaUtils'
import type { JsonSchemaNode } from '../types'

// jsdom 无 ResizeObserver / matchItem 观察器：Element Plus select 依赖，需打桩
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

/**
 * game.json 风格 fixture：嵌套 object、数组（对象项/枚举标量项）、enum、
 * boolean、integer、record（additionalProperties）、oneOf 判别（pipeline/tiled）。
 */
const GAME_SCHEMA: JsonSchemaNode = {
  type: 'object',
  title: 'game',
  properties: {
    id: { type: 'string', title: '游戏 ID', description: '全档唯一的游戏标识。' },
    name: { type: 'string', title: '名称' },
    tickRate: { type: 'integer', title: '逻辑帧率', default: 20, minimum: 1, maximum: 120 },
    debug: { type: 'boolean', title: '调试模式', default: false },
    worldview: {
      type: 'object',
      title: '世界观',
      properties: { theme: { type: 'string', title: '主题' } },
    },
    systems: {
      type: 'array',
      title: '系统',
      description: '启用的框架系统列表，需配 rules/<同名>.json。',
      items: {
        type: 'object',
        title: '条目',
        required: ['id'],
        properties: {
          id: { type: 'string', title: '系统 ID' },
          config: {
            type: 'object',
            title: '参数',
            properties: { range: { type: 'integer', title: '范围', default: 24 } },
          },
        },
      },
    },
    netTags: {
      type: 'array',
      title: '同步标签',
      items: { type: 'string', enum: ['Player', 'NPC', 'Item', 'Resource'] },
    },
    mode: { type: 'string', title: '难度', enum: ['easy', 'normal', 'hard'] },
    flags: {
      type: 'object',
      title: '扩展参数',
      additionalProperties: { type: 'string', title: '值' },
    },
    map: {
      type: 'object',
      title: '默认地图',
      oneOf: [
        {
          type: 'object',
          title: '生成管道',
          required: ['kind', 'initialAgeTicks', 'pipeline'],
          properties: {
            kind: { const: 'pipeline' },
            seed: { type: 'integer', title: '种子' },
            initialAgeTicks: { type: 'integer', title: '初始演化跨度', default: 0 },
            pipeline: {
              type: 'array',
              title: '积木管道',
              minItems: 1,
              items: {
                type: 'object',
                required: ['generator'],
                properties: { generator: { type: 'string', title: '积木' } },
              },
            },
          },
        },
        {
          type: 'object',
          title: 'Tiled 地图',
          required: ['kind', 'path'],
          properties: {
            kind: { const: 'tiled' },
            path: { type: 'string', title: 'Tiled JSON 路径' },
            initialAgeTicks: { type: 'integer', title: '初始演化跨度', default: 0 },
          },
        },
      ],
    },
  },
  required: ['id', 'name'],
}

const GAME_MODEL = {
  id: 'survival-island',
  name: '荒岛求生',
  tickRate: 20,
  debug: false,
  worldview: { theme: 'survival' },
  systems: [{ id: 'interaction', config: { range: 24 } }],
  netTags: ['Player'],
  mode: 'normal',
  flags: { hardcore: 'off' },
  map: { kind: 'tiled', path: './maps/tiled-demo.json', initialAgeTicks: 0 },
}

function mountForm(
  modelValue: unknown = GAME_MODEL,
  schema: JsonSchemaNode = GAME_SCHEMA,
  extraProps: Record<string, unknown> = {},
): VueWrapper {
  return mount(SchemaForm, {
    props: { schema, modelValue, ...extraProps },
    global: { plugins: [ElementPlus] },
  })
}

function lastPayload(wrapper: VueWrapper): Record<string, unknown> {
  const emitted = wrapper.emitted('update:modelValue')
  expect(emitted).toBeTruthy()
  const last = emitted?.at(-1)?.[0]
  expect(last).toBeTruthy()
  return last as Record<string, unknown>
}

describe('SchemaForm 基础渲染', () => {
  it('按渲染映射产出各控件并保留 label/description/必填标识', () => {
    const wrapper = mountForm()

    // label 与必填标识（id / name required）
    expect(wrapper.text()).toContain('游戏 ID')
    expect(wrapper.text()).toContain('逻辑帧率')
    expect(wrapper.findAll('.sform-field__req').length).toBeGreaterThanOrEqual(2)

    // description → 问号 help tooltip 触发器
    expect(wrapper.find('.cf-help').exists()).toBe(true)

    // 控件映射：input / InputNumber / switch / select
    expect(wrapper.find('input').element as HTMLInputElement).toBeTruthy()
    expect(wrapper.findComponent({ name: 'ElInputNumber' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'ElSwitch' }).exists()).toBe(true)
    expect(wrapper.findAllComponents({ name: 'ElSelect' }).length).toBeGreaterThanOrEqual(2)
  })

  it('object 分组默认展开第一层，嵌套分组默认折叠', () => {
    const wrapper = mountForm()
    // worldview 为第一层分组 → 展开；其内无嵌套分组，systems 项 config 亦为第一层
    const groups = wrapper.findAll('.sform-group:not(.sform-group--flat)')
    expect(groups.length).toBeGreaterThanOrEqual(1)
    expect(groups[0].classes()).toContain('is-open')
  })

  it('对象数组渲染嵌套卡片行并带条目序号', () => {
    const wrapper = mountForm()
    expect(wrapper.find('.sform-array__card').exists()).toBe(true)
    expect(wrapper.text()).toContain('条目 1')
    // 条目内容在 input 值中（text() 不含 input value）
    const cardInput = wrapper.find('.sform-array__card input')
    expect((cardInput.element as HTMLInputElement).value).toBe('interaction')
  })

  it('标量枚举数组渲染为可增删的多选 select', () => {
    const wrapper = mountForm()
    const selects = wrapper.findAllComponents({ name: 'ElSelect' })
    const multi = selects.find((select) => select.props('multiple') === true)
    expect(multi).toBeTruthy()
    expect(multi?.props('modelValue')).toEqual(['Player'])
  })

  it('record（additionalProperties）渲染键值行', () => {
    const wrapper = mountForm()
    expect(wrapper.find('.sform-record__row').exists()).toBe(true)
    const keyInput = wrapper.find('.sform-record__key input')
    expect((keyInput.element as HTMLInputElement).value).toBe('hardcore')
  })

  it('oneOf 判别：按当前 kind 渲染对应分支子表单', () => {
    const wrapper = mountForm()
    // tiled 分支：path 字段可见
    const inputs = wrapper.findAll('input').map((input) => input.element as HTMLInputElement)
    expect(inputs.some((input) => input.value === './maps/tiled-demo.json')).toBe(true)
    // pipeline 分支字段不应出现（generator 无值，仅无 placeholder 差异，用 label 判断）
    expect(wrapper.text()).not.toContain('积木管道')
  })

  it('disabled 透传：控件与操作按钮均禁用', () => {
    const wrapper = mountForm(GAME_MODEL, GAME_SCHEMA, { disabled: true })
    expect(wrapper.find('input').attributes('disabled')).toBeDefined()
    const addButtons = wrapper.findAll('button').filter((button) => button.text() === '添加一项')
    expect(addButtons.length).toBeGreaterThan(0)
    for (const button of addButtons) expect(button.attributes('disabled')).toBeDefined()
  })
})

describe('SchemaForm 编辑与事件', () => {
  it('编辑叶子字段 → emit update:modelValue 且只改动目标键', async () => {
    const wrapper = mountForm()
    const inputs = wrapper.findAll('input').map((input) => input.element as HTMLInputElement)
    const idInput = wrapper
      .findAll('input')
      .find((input) => (input.element as HTMLInputElement).value === 'survival-island')
    expect(idInput).toBeTruthy()
    await idInput.setValue('new-island')

    const payload = lastPayload(wrapper)
    expect(payload['id']).toBe('new-island')
    expect(payload['name']).toBe('荒岛求生')
    expect(inputs.length).toBeGreaterThan(0)
  })

  it('switch 切换 → boolean 写回', async () => {
    const wrapper = mountForm()
    const sw = wrapper.findComponent({ name: 'ElSwitch' })
    await sw.vm.$emit('change', true)
    expect(lastPayload(wrapper)['debug']).toBe(true)
  })

  it('数组添加 → 以 buildDefault 骨架追加；删除 → 移除对应项', async () => {
    const wrapper = mountForm()
    const addButton = wrapper.findAll('button').find((button) => button.text() === '添加一项')
    expect(addButton).toBeTruthy()
    await addButton.trigger('click')

    const afterAdd = lastPayload(wrapper)
    const systemsAfterAdd = afterAdd['systems'] as Array<Record<string, unknown>>
    expect(systemsAfterAdd).toHaveLength(2)
    expect(systemsAfterAdd[1]['id']).toBe('') // required 骨架

    await wrapper.setProps({ modelValue: afterAdd })
    const removeButton = wrapper
      .findAll('button')
      .find((button) => button.attributes('aria-label') === '删除条目 2')
    expect(removeButton).toBeTruthy()
    await removeButton.trigger('click')

    const afterRemove = lastPayload(wrapper)
    expect(afterRemove['systems'] as unknown[]).toHaveLength(1)
  })

  it('oneOf kind 切换 → 按新分支骨架整体替换（pipeline 预置 minItems 一项）', async () => {
    const wrapper = mountForm()
    const selects = wrapper.findAllComponents({ name: 'ElSelect' })
    const kindSelect = selects.at(-1)
    expect(kindSelect).toBeTruthy()
    await kindSelect.vm.$emit('update:modelValue', 'pipeline')

    const map = lastPayload(wrapper)['map'] as Record<string, unknown>
    expect(map['kind']).toBe('pipeline')
    expect(map['initialAgeTicks']).toBe(0)
    const pipeline = map['pipeline'] as Array<Record<string, unknown>>
    expect(pipeline).toHaveLength(1)
    expect(pipeline[0]['generator']).toBe('')
  })

  it('枚举多选变更 → 整组写回', async () => {
    const wrapper = mountForm()
    const multi = wrapper
      .findAllComponents({ name: 'ElSelect' })
      .find((select) => select.props('multiple') === true)
    await multi.vm.$emit('update:modelValue', ['Player', 'NPC'])
    expect(lastPayload(wrapper)['netTags']).toEqual(['Player', 'NPC'])
  })

  it('record：添加行 / 改键（blur 提交）/ 删行', async () => {
    const wrapper = mountForm()
    const addButtons = wrapper.findAll('button').filter((button) => button.text() === '添加一项')
    // systems 与 flags 各有一个添加按钮，flags 的在 record 区
    const recordTools = wrapper.find('.sform-record__tools')
    await recordTools.find('button').trigger('click')

    const afterAdd = lastPayload(wrapper)
    expect(afterAdd['flags']).toEqual({ hardcore: 'off', key: '' })

    await wrapper.setProps({ modelValue: afterAdd })
    const rows = wrapper.findAll('.sform-record__row')
    expect(rows).toHaveLength(2)
    const newKeyInput = rows[1].find('.sform-record__key input')
    await newKeyInput.setValue('permadeath')
    await newKeyInput.trigger('change')

    const afterRename = lastPayload(wrapper)
    expect(afterRename['flags']).toEqual({ hardcore: 'off', permadeath: '' })

    const deleteButton = rows[1].find('button')
    await deleteButton.trigger('click')
    expect(lastPayload(wrapper)['flags']).toEqual({ hardcore: 'off' })
  })
})

describe('SchemaForm errors prop（422 zod issue 映射）', () => {
  it('命中字段标红并显示错误文案，容器子树标记错误', () => {
    const wrapper = mountForm(GAME_MODEL, GAME_SCHEMA, {
      errors: {
        '/tickRate': '必须为整数',
        '/systems/0/id': '系统 ID 不能为空',
      },
    })

    expect(wrapper.text()).toContain('必须为整数')
    expect(wrapper.text()).toContain('系统 ID 不能为空')
    expect(wrapper.findAll('.sform-field--error').length).toBeGreaterThanOrEqual(2)
    // systems 数组卡片 + 根分组? systems 是数组容器 → 卡片标红
    expect(wrapper.find('.sform-array__card.is-error').exists()).toBe(true)
  })
})

describe('SchemaForm 兜底（不认识的节点不崩）', () => {
  it('$ref / allOf / 未知结构渲染为只读 JSON 提示', () => {
    const wrapper = mountForm(
      { weird: { a: 1 } },
      {
        type: 'object',
        properties: {
          weird: { $ref: '#/definitions/nope' },
          combo: { allOf: [{ type: 'string' }] },
        },
      },
    )
    expect(wrapper.text()).toContain('该节点结构暂不支持表单编辑')
    expect(wrapper.findAll('.sform-unknown').length).toBe(2)
    expect(wrapper.text()).toContain('definitions')
  })
})

describe('schemaUtils 纯逻辑', () => {
  it('describeSchema 渲染映射', () => {
    expect(describeSchema({ type: 'string' }).kind).toBe('string')
    expect(describeSchema({ type: 'integer' }).kind).toBe('integer')
    expect(describeSchema({ type: 'boolean' }).kind).toBe('boolean')
    expect(describeSchema({ type: 'string', enum: ['a', 'b'] }).kind).toBe('enum')
    expect(describeSchema({ const: 'tiled' }).kind).toBe('const')
    expect(describeSchema({ type: 'array', items: { type: 'string' } }).kind).toBe('array')
    expect(describeSchema({ type: 'object', properties: { a: { type: 'string' } } }).kind).toBe(
      'object',
    )
    expect(describeSchema({ type: 'object', additionalProperties: { type: 'string' } }).kind).toBe(
      'record',
    )
    expect(describeSchema({ $ref: '#/x' }).kind).toBe('unknown')
    expect(describeSchema({ type: 'object', properties: {} }).kind).toBe('object')
  })

  it('getDiscriminator 识别 pipeline/tiled 判别字段', () => {
    const info = describeSchema(GAME_SCHEMA['properties']!['map']!)
    expect(info.kind).toBe('oneOf')
    expect(info.discriminator?.property).toBe('kind')
    expect(info.discriminator?.options.map((option) => option.value)).toEqual(['pipeline', 'tiled'])
    expect(getDiscriminator([])).toBeNull()
  })

  it('buildDefault 骨架：required + default，minItems≥1 预置一项', () => {
    const systemsItem = GAME_SCHEMA['properties']!['systems']!['items']!
    expect(buildDefault(systemsItem)).toEqual({ id: '' })
    const mapPipeline = GAME_SCHEMA['properties']!['map']!['oneOf']![0]!
    const skeleton = buildDefault(mapPipeline) as Record<string, unknown>
    expect(skeleton['kind']).toBe('pipeline')
    expect(skeleton['initialAgeTicks']).toBe(0)
    expect(skeleton['pipeline']).toEqual([{ generator: '' }])
  })

  it('setAtPath 不可变写值且保序', () => {
    const source = { a: 1, systems: [{ config: { range: 1 } }] }
    const next = setAtPath(source, '/systems/0/config/range', 24) as typeof source
    expect(next['systems'][0]['config']['range']).toBe(24)
    expect(source['systems'][0]['config']['range']).toBe(1) // 原对象不被改动
    expect(Object.keys(next)).toEqual(['a', 'systems'])
    expect((setAtPath(null, '/a/b', 1) as Record<string, unknown>)['a']).toEqual({ b: 1 })
  })

  it('pointerJoin 与 errorInSubtree', () => {
    expect(pointerJoin('', 'systems')).toBe('/systems')
    expect(pointerJoin('/systems', 0)).toBe('/systems/0')
    const errors = { '/systems/0/id': 'x' }
    expect(errorInSubtree(errors, '/systems')).toBe(true)
    expect(errorInSubtree(errors, '/worldview')).toBe(false)
    expect(errorInSubtree(undefined, '/systems')).toBe(false)
  })
})
