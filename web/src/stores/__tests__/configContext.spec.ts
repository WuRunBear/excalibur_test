import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  fetchConfigContext: vi.fn(),
  fetchWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
  activateWorkspace: vi.fn(),
  renameWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  messageSuccess: vi.fn(),
  messageError: vi.fn(),
}))

vi.mock('@/api/admin', () => ({
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
  fetchConfigContext: mocks.fetchConfigContext,
  fetchWorkspaces: mocks.fetchWorkspaces,
  createWorkspace: mocks.createWorkspace,
  activateWorkspace: mocks.activateWorkspace,
  renameWorkspace: mocks.renameWorkspace,
  deleteWorkspace: mocks.deleteWorkspace,
}))

vi.mock('element-plus', () => ({
  ElMessage: { success: mocks.messageSuccess, error: mocks.messageError },
}))

import { AdminApiError } from '@/api/admin'
import type { ConfigContext, WorkspaceMeta } from '@/api/admin'
import { useConfigContextStore } from '@/stores/configContext'
import { useWorkspaceStore } from '@/stores/workspace'

function makeContext(overrides: Partial<ConfigContext> = {}): ConfigContext {
  return {
    official: { fingerprint: 'a1b2c3d4e5f6', fileCount: 12 },
    workspace: { id: 'ws-1', name: '玩法实验-A', fingerprint: 'a1b2c3d4e5f6', fileCount: 12 },
    inSync: true,
    changes: [],
    ...overrides,
  }
}

function wsMeta(id: string, overrides: Partial<WorkspaceMeta> = {}): WorkspaceMeta {
  return {
    id,
    name: `工作区-${id}`,
    createdAt: 1_700_000_000_000,
    baseFingerprint: 'fp',
    changedFiles: 0,
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.fetchConfigContext.mockReset()
  mocks.fetchWorkspaces.mockReset()
  mocks.createWorkspace.mockReset()
  mocks.activateWorkspace.mockReset()
  mocks.renameWorkspace.mockReset()
  mocks.deleteWorkspace.mockReset()
  mocks.messageSuccess.mockReset()
  mocks.messageError.mockReset()
})

describe('useConfigContextStore', () => {
  it('load 拉取上下文并清除错误', async () => {
    mocks.fetchConfigContext.mockResolvedValue(makeContext())
    const store = useConfigContextStore()
    await store.load()
    expect(store.context?.inSync).toBe(true)
    expect(store.context?.workspace?.name).toBe('玩法实验-A')
    expect(store.lastError).toBeNull()
  })

  it('load 失败记录 lastError（供卡片渲染错误态 + 重试）', async () => {
    mocks.fetchConfigContext.mockRejectedValue(new AdminApiError('无法连接管理后端', -1))
    const store = useConfigContextStore()
    await store.load()
    expect(store.context).toBeNull()
    expect(store.lastError).toBe('无法连接管理后端')
  })

  it('ensureLoaded 幂等：已有数据不重复拉取', async () => {
    mocks.fetchConfigContext.mockResolvedValue(makeContext())
    const store = useConfigContextStore()
    await store.ensureLoaded()
    await store.ensureLoaded()
    expect(mocks.fetchConfigContext).toHaveBeenCalledTimes(1)
  })

  it('活动工作区变更后自动重取（仅在已被使用过时）', async () => {
    mocks.fetchWorkspaces.mockResolvedValue({
      activeId: 'ws-1',
      items: [wsMeta('ws-1'), wsMeta('ws-2')],
    })
    mocks.fetchConfigContext.mockResolvedValue(makeContext())

    const wsStore = useWorkspaceStore()
    const store = useConfigContextStore()

    // 使用前：工作区列表加载导致的 activeId 变化不触发上下文请求
    await wsStore.load()
    await nextTick()
    expect(mocks.fetchConfigContext).not.toHaveBeenCalled()

    // 首次使用：加载一次
    await store.ensureLoaded()
    expect(mocks.fetchConfigContext).toHaveBeenCalledTimes(1)
    mocks.fetchConfigContext.mockClear()

    // 激活另一个工作区 → activeId 变更 → 自动重取
    mocks.activateWorkspace.mockResolvedValue(wsMeta('ws-2'))
    await wsStore.activate('ws-2')
    await nextTick()
    await nextTick()
    expect(mocks.fetchConfigContext).toHaveBeenCalledTimes(1)
  })

  it('无活动工作区时 workspace 为 null，inSync 语义由后端给出', async () => {
    mocks.fetchConfigContext.mockResolvedValue(
      makeContext({ workspace: null, inSync: true, changes: [] }),
    )
    const store = useConfigContextStore()
    await store.load()
    expect(store.context?.workspace).toBeNull()
    expect(store.context?.inSync).toBe(true)
  })
})
