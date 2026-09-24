import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  wsState: { activeId: 'ws-1' as string | null },
  wsLoad: vi.fn(),
  wsRefresh: vi.fn(),
  fetchConfigTree: vi.fn(),
  fetchConfigFile: vi.fn(),
  saveConfigFile: vi.fn(),
  validateConfigFile: vi.fn(),
  validateAllConfigs: vi.fn(),
  messageSuccess: vi.fn(),
  messageError: vi.fn(),
}))

vi.mock('@/api/admin', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/admin')>()
  return {
    ...original,
    AdminApiError: class AdminApiError extends Error {
      readonly code: number
      readonly detail: unknown
      constructor(message: string, code = 1, detail?: unknown) {
        super(message)
        this.name = 'AdminApiError'
        this.code = code
        this.detail = detail
      }
    },
    extractValidationErrors: (detail: unknown) => {
      if (typeof detail !== 'object' || detail === null) return null
      const errors = (detail as { errors?: unknown }).errors
      return Array.isArray(errors) ? (errors as never[]) : null
    },
    fetchConfigTree: mocks.fetchConfigTree,
    fetchConfigFile: mocks.fetchConfigFile,
    saveConfigFile: mocks.saveConfigFile,
    validateConfigFile: mocks.validateConfigFile,
    validateAllConfigs: mocks.validateAllConfigs,
  }
})

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: () => ({
    get activeId() {
      return mocks.wsState.activeId
    },
    load: mocks.wsLoad,
    refresh: mocks.wsRefresh,
  }),
}))

vi.mock('element-plus', () => ({
  ElMessage: { success: mocks.messageSuccess, error: mocks.messageError },
}))

import { AdminApiError } from '@/api/admin'
import type { ConfigTreeNode } from '@/api/admin'
import { useConfigStore } from '@/stores/config'
import { useGamesStore } from '@/stores/games'

const TREE: ConfigTreeNode = {
  name: 'game',
  path: 'game',
  type: 'dir',
  children: [
    { name: 'hero.json', path: 'game/hero.json', type: 'file' },
    { name: 'map.json', path: 'game/map.json', type: 'file' },
  ],
}

/** 规范化序列化口径：2 空格缩进 + 末尾换行。 */
const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** 便捷：让 fetchConfigFile 返回指定文件。 */
function stubFile(path: string, content: string, schemaKind: string | null = null): void {
  mocks.fetchConfigFile.mockResolvedValue({ path, content, schemaKind })
}

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.wsState.activeId = 'ws-1'
  mocks.fetchConfigTree.mockReset()
  mocks.fetchConfigFile.mockReset()
  mocks.saveConfigFile.mockReset()
  mocks.validateConfigFile.mockReset()
  mocks.validateAllConfigs.mockReset()
  mocks.wsRefresh.mockReset()
  mocks.messageSuccess.mockReset()
  mocks.messageError.mockReset()
})

describe('useConfigStore', () => {
  it('loadTree 无活动工作区时清空本地状态', async () => {
    mocks.wsState.activeId = null
    const store = useConfigStore()
    await store.loadTree()
    expect(store.tree).toBeNull()
    expect(store.currentPath).toBeNull()
  })

  it('loadTree 拉取活动工作区文件树', async () => {
    mocks.fetchConfigTree.mockResolvedValue({ tree: TREE })
    const store = useConfigStore()
    await store.loadTree()
    expect(store.tree?.name).toBe('game')
    expect(store.tree?.children).toHaveLength(2)
    expect(store.treeError).toBeNull()
  })

  it('openFile 载入文件并跟踪 dirty', async () => {
    stubFile('game/hero.json', '{"a":1}', 'GameDefinition')
    const store = useConfigStore()
    await store.openFile('game/hero.json')
    expect(store.currentFile?.schemaKind).toBe('GameDefinition')
    // JSON 模式：draft 与 draftObj 同步为规范化序列化结果。
    expect(store.draftObj).toEqual({ a: 1 })
    expect(store.draft).toBe(pretty({ a: 1 }))
    expect(store.dirty).toBe(false)
    expect(store.isJsonFile(store.currentPath)).toBe(true)

    store.setDraft('{"a":2}')
    expect(store.dirty).toBe(true)
  })

  it('save 成功后同步基线并刷新工作区改动数', async () => {
    stubFile('game/hero.json', '{"a":1}', null)
    mocks.saveConfigFile.mockResolvedValue({ path: 'game/hero.json', valid: true })
    const store = useConfigStore()
    await store.openFile('game/hero.json')
    store.setDraft('{"a":2}')

    const outcome = await store.save()
    expect(outcome).toBe('saved')
    expect(store.dirty).toBe(false)
    expect(mocks.wsRefresh).toHaveBeenCalledTimes(1)
    expect(mocks.messageSuccess).toHaveBeenCalled()
  })

  it('save 校验失败返回 invalid 并填充错误面板（不弹错误提示）', async () => {
    stubFile('game/hero.json', '{"a":1}', 'GameDefinition')
    mocks.saveConfigFile.mockRejectedValue(
      new AdminApiError('配置校验未通过', 1, {
        errors: [{ jsonPath: '$.a', message: '缺少必需字段 hp', line: 2 }],
      }),
    )
    const store = useConfigStore()
    await store.openFile('game/hero.json')
    store.setDraft('{"a":"oops"}')

    const outcome = await store.save()
    expect(outcome).toBe('invalid')
    expect(store.fileErrors).toEqual([{ jsonPath: '$.a', message: '缺少必需字段 hp', line: 2 }])
    expect(mocks.messageError).not.toHaveBeenCalled()
  })

  it('save 其他错误提示后端 message', async () => {
    stubFile('game/hero.json', '{}', null)
    mocks.saveConfigFile.mockRejectedValue(new AdminApiError('未设置活动工作区', 1))
    const store = useConfigStore()
    await store.openFile('game/hero.json')
    store.setDraft('{"a":1}')

    const outcome = await store.save()
    expect(outcome).toBe('error')
    expect(mocks.messageError).toHaveBeenCalledWith('未设置活动工作区')
  })

  it('validateAll 存储整体校验结果', async () => {
    mocks.validateAllConfigs.mockResolvedValue({ valid: false, message: '2 个文件未通过校验' })
    const store = useConfigStore()
    await store.validateAll()
    expect(store.validateAllResult).toEqual({ valid: false, message: '2 个文件未通过校验' })
  })

  // -------------------------------------------------------------------------
  // 3.3 draft 结构化模型
  // -------------------------------------------------------------------------

  it('dirty 未变不 dirty、改值 dirty、键序与缩进不敏感', async () => {
    stubFile('game/hero.json', '{"a":1,"b":2}', 'GameDefinition')
    const store = useConfigStore()
    await store.openFile('game/hero.json')
    expect(store.dirty).toBe(false)

    // 仅重排键 + 改缩进 → 规范化后键序无关，不 dirty。
    store.setDraft('{\n  "b": 2,\n  "a": 1\n}\n')
    expect(store.dirty).toBe(false)

    // 改值 → dirty。
    store.setDraft('{"b":2,"a":9}')
    expect(store.dirty).toBe(true)

    // 值还原 → 不 dirty。
    store.setDraft('{"a":1,"b":2}')
    expect(store.dirty).toBe(false)
  })

  it('规范化序列化：2 空格缩进 + 末尾换行，已有键保序、新键追加尾部', async () => {
    stubFile('game/hero.json', '{"a":1,"b":2}', 'GameDefinition')
    const store = useConfigStore()
    await store.openFile('game/hero.json')
    expect(store.draft).toBe('{\n  "a": 1,\n  "b": 2\n}\n')

    // 表单直接改结构化对象：新键追加尾部，已有键保持原顺序。
    ;(store.draftObj as Record<string, unknown>).c = 3
    expect(store.draft).toBe('{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n')

    // 整体替换对象同样保序。
    store.draftObj = { z: 1, a: 2 }
    await nextTick()
    expect(store.draft).toBe('{\n  "z": 1,\n  "a": 2\n}\n')
  })

  it('JSON 解析失败 / 非 JSON 文件回落字符串模式', async () => {
    // 解析失败：draftObj 为空，dirty 走原串直比。
    stubFile('game/broken.json', '{oops', 'GameDefinition')
    const store = useConfigStore()
    await store.openFile('game/broken.json')
    expect(store.draftObj).toBeNull()
    expect(store.draft).toBe('{oops')
    expect(store.dirty).toBe(false)
    store.setDraft('{oops!')
    expect(store.dirty).toBe(true)

    // 非 JSON 文本文件：维持纯字符串 + 原串直比。
    stubFile('game/notes.txt', 'hello world')
    await store.openFile('game/notes.txt')
    expect(store.draftObj).toBeNull()
    expect(store.draft).toBe('hello world')
    expect(store.dirty).toBe(false)
    store.setDraft('hello world!')
    expect(store.dirty).toBe(true)

    // 恰好还原原串 → 不 dirty。
    store.setDraft('hello world')
    expect(store.dirty).toBe(false)
  })

  it('save / validateCurrent 发送规范化序列化结果（字符串模式发原串）', async () => {
    stubFile('game/hero.json', '{"a":1}', 'GameDefinition')
    mocks.saveConfigFile.mockResolvedValue({ path: 'game/hero.json', valid: true })
    mocks.validateConfigFile.mockResolvedValue({
      schemaKind: 'GameDefinition',
      valid: true,
      errors: [],
    })
    const store = useConfigStore()
    await store.openFile('game/hero.json')
    store.setDraft('{"a":2}')

    await store.validateCurrent()
    await store.save()
    expect(mocks.validateConfigFile).toHaveBeenCalledWith('game/hero.json', pretty({ a: 2 }))
    expect(mocks.saveConfigFile).toHaveBeenCalledWith('game/hero.json', pretty({ a: 2 }))

    // 字符串模式：直接发原串。
    stubFile('game/notes.txt', 'raw text')
    mocks.saveConfigFile.mockClear()
    mocks.validateConfigFile.mockClear()
    await store.openFile('game/notes.txt')
    store.setDraft('raw text edited')
    await store.validateCurrent()
    await store.save()
    expect(mocks.validateConfigFile).toHaveBeenCalledWith('game/notes.txt', 'raw text edited')
    expect(mocks.saveConfigFile).toHaveBeenCalledWith('game/notes.txt', 'raw text edited')
  })

  it('games.epoch 变更时清空草稿与结构化对象', async () => {
    stubFile('game/hero.json', '{"a":1}', 'GameDefinition')
    const store = useConfigStore()
    await store.openFile('game/hero.json')
    expect(store.draftObj).not.toBeNull()

    const gamesStore = useGamesStore()
    gamesStore.epoch += 1
    await nextTick()

    expect(store.currentFile).toBeNull()
    expect(store.currentPath).toBeNull()
    expect(store.draft).toBe('')
    expect(store.draftObj).toBeNull()
    expect(store.dirty).toBe(false)
  })
})
