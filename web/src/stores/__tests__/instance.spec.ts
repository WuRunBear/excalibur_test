import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  handlers: null as {
    onMessage: (payload: unknown) => void
    onOpen?: () => void
    onClose?: () => void
  } | null,
  fetchInstances: vi.fn(),
  startInstance: vi.fn(),
  stopInstance: vi.fn(),
  restartInstance: vi.fn(),
  messageSuccess: vi.fn(),
  messageError: vi.fn(),
}))

vi.mock('@/api/admin', () => ({
  AdminApiError: class AdminApiError extends Error {
    readonly code: number
    constructor(message: string, code = 1) {
      super(message)
      this.name = 'AdminApiError'
      this.code = code
    }
  },
  INSTANCE_ROLE_LABELS: { official: '正式实例', preview: '预览实例' },
  fetchInstances: mocks.fetchInstances,
  startInstance: mocks.startInstance,
  stopInstance: mocks.stopInstance,
  restartInstance: mocks.restartInstance,
  subscribeAdminChannel: (_channel: string, handlers: NonNullable<typeof mocks.handlers>) => {
    mocks.handlers = handlers
    return { close: vi.fn() }
  },
}))

vi.mock('element-plus', () => ({
  ElMessage: { success: mocks.messageSuccess, error: mocks.messageError },
}))

import { AdminApiError } from '@/api/admin'
import type { InstanceRole, InstanceSnapshot, InstanceStatus } from '@/api/admin'
import { useInstanceStore } from '@/stores/instance'

function makeSnapshot(
  role: InstanceRole,
  status: InstanceStatus,
  overrides: Partial<InstanceSnapshot> = {},
): InstanceSnapshot {
  return {
    role,
    status,
    pid: null,
    startedAt: null,
    port: role === 'official' ? 3000 : 3200,
    lastExitCode: null,
    lastSignal: null,
    ...overrides,
  }
}

async function loadStore() {
  mocks.fetchInstances.mockResolvedValue({
    official: makeSnapshot('official', 'stopped'),
    preview: makeSnapshot('preview', 'stopped'),
  })
  const store = useInstanceStore()
  await store.ensureLoaded()
  return store
}

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.fetchInstances.mockReset()
  mocks.startInstance.mockReset()
  mocks.stopInstance.mockReset()
  mocks.restartInstance.mockReset()
  mocks.messageSuccess.mockReset()
  mocks.messageError.mockReset()
  mocks.handlers = null
})

afterEach(() => {
  useInstanceStore().dispose()
  vi.useRealTimers()
})

describe('useInstanceStore', () => {
  it('ensureLoaded 拉取双实例快照并建立 WS 订阅', async () => {
    const store = await loadStore()
    expect(store.snapshots.official?.status).toBe('stopped')
    expect(store.snapshots.preview?.port).toBe(3200)
    expect(mocks.handlers).not.toBeNull()
  })

  it('start 乐观置为 starting，成功后采用后端快照', async () => {
    const store = await loadStore()
    mocks.startInstance.mockResolvedValue(
      makeSnapshot('official', 'running', { pid: 7, startedAt: 123 }),
    )
    const running = store.performAction('official', 'start')
    expect(store.snapshots.official?.status).toBe('starting')
    await running
    expect(store.snapshots.official?.status).toBe('running')
    expect(mocks.messageSuccess).toHaveBeenCalledTimes(1)
  })

  it('start 失败回滚到操作前快照并提示后端 message', async () => {
    const store = await loadStore()
    mocks.startInstance.mockRejectedValue(new AdminApiError('端口 3000 已被占用', 1))
    const running = store.performAction('official', 'start')
    expect(store.snapshots.official?.status).toBe('starting')
    await running
    expect(store.snapshots.official?.status).toBe('stopped')
    expect(mocks.messageError).toHaveBeenCalledWith('端口 3000 已被占用')
  })

  it('状态机约束：running 不允许 start，stopped 不允许 stop / restart', async () => {
    mocks.fetchInstances.mockResolvedValue({
      official: makeSnapshot('official', 'running', { pid: 5, startedAt: 1 }),
      preview: makeSnapshot('preview', 'stopped'),
    })
    const store = useInstanceStore()
    await store.ensureLoaded()

    expect(store.isActionAllowed('official', 'start')).toBe(false)
    expect(store.isActionAllowed('official', 'stop')).toBe(true)
    expect(store.isActionAllowed('official', 'restart')).toBe(true)
    expect(store.isActionAllowed('preview', 'stop')).toBe(false)
    expect(store.isActionAllowed('preview', 'start')).toBe(true)

    await store.performAction('official', 'start')
    expect(mocks.startInstance).not.toHaveBeenCalled()
  })

  it('WS instance:state 推送更新对应角色快照，非法负载被忽略', async () => {
    const store = await loadStore()
    mocks.handlers!.onMessage(
      makeSnapshot('preview', 'crashed', { lastExitCode: 1, lastSignal: 'SIGTERM' }),
    )
    expect(store.snapshots.preview?.status).toBe('crashed')
    expect(store.snapshots.preview?.lastExitCode).toBe(1)

    mocks.handlers!.onMessage({ foo: 'bar' })
    expect(store.snapshots.preview?.status).toBe('crashed')
  })

  it('WS 断线降级为 5s 轮询，重连恢复实时', async () => {
    vi.useFakeTimers()
    const store = await loadStore()
    expect(store.connection).toBe('connecting')

    mocks.fetchInstances.mockClear()
    mocks.handlers!.onClose!()
    expect(store.connection).toBe('polling')

    await vi.advanceTimersByTimeAsync(5000)
    expect(mocks.fetchInstances).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(mocks.fetchInstances).toHaveBeenCalledTimes(2)

    mocks.fetchInstances.mockClear()
    mocks.handlers!.onOpen!()
    expect(store.connection).toBe('online')
    await vi.advanceTimersByTimeAsync(20000)
    // onOpen 立即拉取一次，且轮询已停止
    expect(mocks.fetchInstances).toHaveBeenCalledTimes(1)
  })

  it('操作在途期间整组按钮判定为 busy', async () => {
    const store = await loadStore()
    mocks.startInstance.mockReturnValue(new Promise(() => {}))
    const running = store.performAction('official', 'start')
    expect(store.isPending('official', 'start')).toBe(true)
    expect(store.isBusy('official')).toBe(true)
    running.catch(() => {})
  })
})
