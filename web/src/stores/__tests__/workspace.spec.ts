import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  fetchWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
  activateWorkspace: vi.fn(),
  renameWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
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
    fetchWorkspaces: mocks.fetchWorkspaces,
    createWorkspace: mocks.createWorkspace,
    activateWorkspace: mocks.activateWorkspace,
    renameWorkspace: mocks.renameWorkspace,
    deleteWorkspace: mocks.deleteWorkspace,
  }
})

vi.mock('element-plus', () => ({
  ElMessage: { success: mocks.messageSuccess, error: mocks.messageError },
}))

import { AdminApiError } from '@/api/admin'
import type { WorkspaceMeta } from '@/api/admin'
import { useWorkspaceStore } from '@/stores/workspace'

function meta(id: string, overrides: Partial<WorkspaceMeta> = {}): WorkspaceMeta {
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
  mocks.fetchWorkspaces.mockReset()
  mocks.createWorkspace.mockReset()
  mocks.activateWorkspace.mockReset()
  mocks.renameWorkspace.mockReset()
  mocks.deleteWorkspace.mockReset()
  mocks.messageSuccess.mockReset()
  mocks.messageError.mockReset()
})

describe('useWorkspaceStore', () => {
  it('load 建立列表与活动工作区', async () => {
    mocks.fetchWorkspaces.mockResolvedValue({
      activeId: 'a',
      items: [meta('a'), meta('b', { changedFiles: 3 })],
    })
    const store = useWorkspaceStore()
    await store.load()
    expect(store.items).toHaveLength(2)
    expect(store.activeId).toBe('a')
    expect(store.activeWorkspace?.id).toBe('a')
    expect(store.lastError).toBeNull()
  })

  it('create 新建后自动激活并插入列表', async () => {
    mocks.createWorkspace.mockResolvedValue(meta('c', { name: '玩法实验-A' }))
    const store = useWorkspaceStore()
    const ok = await store.create('玩法实验-A')
    expect(ok).toBe(true)
    expect(store.activeId).toBe('c')
    expect(store.items.some((item) => item.id === 'c')).toBe(true)
    expect(mocks.messageSuccess).toHaveBeenCalled()
  })

  it('create 失败提示后端 message', async () => {
    mocks.createWorkspace.mockRejectedValue(new AdminApiError('工作区名称已存在', 1))
    const store = useWorkspaceStore()
    const ok = await store.create('重复名')
    expect(ok).toBe(false)
    expect(mocks.messageError).toHaveBeenCalledWith('工作区名称已存在')
  })

  it('activate 切换活动工作区', async () => {
    mocks.fetchWorkspaces.mockResolvedValue({ activeId: 'a', items: [meta('a'), meta('b')] })
    mocks.activateWorkspace.mockResolvedValue(meta('b'))
    const store = useWorkspaceStore()
    await store.load()
    const ok = await store.activate('b')
    expect(ok).toBe(true)
    expect(store.activeId).toBe('b')
  })

  it('rename 更新条目名称', async () => {
    mocks.fetchWorkspaces.mockResolvedValue({ activeId: 'a', items: [meta('a')] })
    mocks.renameWorkspace.mockResolvedValue(meta('a', { name: '新名字' }))
    const store = useWorkspaceStore()
    await store.load()
    await store.rename('a', '新名字')
    expect(store.items[0]?.name).toBe('新名字')
  })

  it('remove 删除活动工作区后清空活动标记', async () => {
    mocks.fetchWorkspaces.mockResolvedValue({ activeId: 'a', items: [meta('a'), meta('b')] })
    mocks.deleteWorkspace.mockResolvedValue({ id: 'a' })
    const store = useWorkspaceStore()
    await store.load()
    await store.remove('a')
    expect(store.items.map((item) => item.id)).toEqual(['b'])
    expect(store.activeId).toBeNull()
  })
})
