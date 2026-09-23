import { beforeEach, describe, expect, it, vi } from 'vitest'
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

const TREE: ConfigTreeNode = {
  name: 'game',
  path: 'game',
  type: 'dir',
  children: [
    { name: 'hero.json', path: 'game/hero.json', type: 'file' },
    { name: 'map.json', path: 'game/map.json', type: 'file' },
  ],
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
    mocks.fetchConfigFile.mockResolvedValue({
      path: 'game/hero.json',
      content: '{"a":1}',
      schemaKind: 'GameDefinition',
    })
    const store = useConfigStore()
    await store.openFile('game/hero.json')
    expect(store.currentFile?.schemaKind).toBe('GameDefinition')
    expect(store.draft).toBe('{"a":1}')
    expect(store.dirty).toBe(false)
    expect(store.isJsonFile(store.currentPath)).toBe(true)

    store.setDraft('{"a":2}')
    expect(store.dirty).toBe(true)
  })

  it('save 成功后同步基线并刷新工作区改动数', async () => {
    mocks.fetchConfigFile.mockResolvedValue({
      path: 'game/hero.json',
      content: '{"a":1}',
      schemaKind: null,
    })
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
    mocks.fetchConfigFile.mockResolvedValue({
      path: 'game/hero.json',
      content: '{"a":1}',
      schemaKind: 'GameDefinition',
    })
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
    mocks.fetchConfigFile.mockResolvedValue({
      path: 'game/hero.json',
      content: '{}',
      schemaKind: null,
    })
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
})
