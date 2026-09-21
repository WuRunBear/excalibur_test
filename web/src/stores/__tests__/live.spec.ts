import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => {
  const handlersByChannel = new Map<
    string,
    {
      onMessage: (payload: unknown) => void
      onOpen?: () => void
      onClose?: () => void
    }
  >()
  return {
    handlersByChannel,
    closeByChannel: new Map<string, ReturnType<typeof vi.fn>>(),
    fetchLiveSamples: vi.fn(),
  }
})

vi.mock('@/api/admin', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/admin')>()
  return {
    ...original,
    fetchLiveSamples: mocks.fetchLiveSamples,
    subscribeAdminChannel: (
      channel: string,
      handlers: Parameters<typeof original.subscribeAdminChannel>[1],
    ) => {
      mocks.handlersByChannel.set(channel, handlers)
      const close = vi.fn()
      mocks.closeByChannel.set(channel, close)
      return { close }
    },
  }
})

import type { InstanceRole, LiveSample } from '@/api/admin'
import { LIVE_BUFFER_CAP, LIVE_WINDOW, useLiveStore } from '@/stores/live'

function makeSample(
  role: InstanceRole,
  ts: number,
  overrides: Partial<LiveSample> = {},
): LiveSample {
  return { role, ts, tick: ts, tickRate: 20, entityCount: 3, ...overrides }
}

function wsHandlers(channel: string) {
  const handlers = mocks.handlersByChannel.get(channel)
  if (!handlers) throw new Error(`channel ${channel} not subscribed`)
  return handlers
}

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.handlersByChannel.clear()
  mocks.closeByChannel.clear()
  mocks.fetchLiveSamples.mockReset()
})

describe('live store', () => {
  it('ensureRole 订阅 WS 频道并 REST 回填', async () => {
    mocks.fetchLiveSamples.mockResolvedValue({
      role: 'official',
      samples: [makeSample('official', 1000), makeSample('official', 2000)],
    })
    const store = useLiveStore()
    store.ensureRole('official')

    await vi.waitFor(() => expect(store.backfillDone.official).toBe(true))
    expect(mocks.handlersByChannel.has('live:official')).toBe(true)
    expect(store.samples.official).toHaveLength(2)
    expect(store.windowOf('official')).toHaveLength(2)
  })

  it('回填完成前到达的 WS 消息先缓冲，回填后按序合并去重', async () => {
    let resolveBackfill: (value: { role: string; samples: LiveSample[] }) => void = () => {}
    mocks.fetchLiveSamples.mockReturnValue(
      new Promise((resolve) => {
        resolveBackfill = resolve
      }),
    )
    const store = useLiveStore()
    store.ensureRole('official')

    // 回填未完成，WS 消息进待合并缓冲
    wsHandlers('live:official').onMessage(makeSample('official', 5000))
    wsHandlers('live:official').onMessage(makeSample('official', 6000))
    expect(store.samples.official).toHaveLength(0)

    resolveBackfill({
      role: 'official',
      samples: [
        makeSample('official', 1000),
        makeSample('official', 2000),
        makeSample('official', 5000),
      ],
    })
    await vi.waitFor(() => expect(store.backfillDone.official).toBe(true))
    // 5000 与 WS 已缓冲的重复（ts 相同），只保留一份
    expect(store.samples.official.map((s) => s.ts)).toEqual([1000, 2000, 5000, 6000])
  })

  it('回填完成后 WS 增量直接入缓冲，ts 非递增丢弃', async () => {
    mocks.fetchLiveSamples.mockResolvedValue({
      role: 'official',
      samples: [makeSample('official', 1000)],
    })
    const store = useLiveStore()
    store.ensureRole('official')
    await vi.waitFor(() => expect(store.backfillDone.official).toBe(true))

    wsHandlers('live:official').onMessage(makeSample('official', 2000, { entityCount: 5 }))
    wsHandlers('live:official').onMessage(makeSample('official', 1500))
    expect(store.samples.official.map((s) => s.ts)).toEqual([1000, 2000])
    expect(store.samples.official[1].entityCount).toBe(5)
  })

  it('环形缓冲超限丢最旧（上限 300）', async () => {
    mocks.fetchLiveSamples.mockResolvedValue({ role: 'preview', samples: [] })
    const store = useLiveStore()
    store.ensureRole('preview')
    await vi.waitFor(() => expect(store.backfillDone.preview).toBe(true))

    for (let i = 1; i <= LIVE_BUFFER_CAP + 10; i++) {
      wsHandlers('live:preview').onMessage(makeSample('preview', i * 1000))
    }
    expect(store.samples.preview).toHaveLength(LIVE_BUFFER_CAP)
    expect(store.samples.preview[0].ts).toBe(11000)
  })

  it('重连 onOpen 走 merge 补拉，仅追加缺失段', async () => {
    mocks.fetchLiveSamples.mockResolvedValue({
      role: 'official',
      samples: [makeSample('official', 1000)],
    })
    const store = useLiveStore()
    store.ensureRole('official')
    await vi.waitFor(() => expect(store.backfillDone.official).toBe(true))

    // 断线 → 重连成功
    wsHandlers('live:official').onClose?.()
    expect(store.wsState.official).toBe('offline')
    mocks.fetchLiveSamples.mockResolvedValue({
      role: 'official',
      samples: [
        makeSample('official', 1000),
        makeSample('official', 2000),
        makeSample('official', 3000),
      ],
    })
    wsHandlers('live:official').onOpen?.()
    expect(store.wsState.official).toBe('online')
    await vi.waitFor(() =>
      expect(store.samples.official.map((s) => s.ts)).toEqual([1000, 2000, 3000]),
    )
    // merge 模式调用（第二次 fetch）
    expect(mocks.fetchLiveSamples).toHaveBeenLastCalledWith('official', LIVE_WINDOW)
  })

  it('形状不符的 WS 消息被丢弃', async () => {
    mocks.fetchLiveSamples.mockResolvedValue({ role: 'official', samples: [] })
    const store = useLiveStore()
    store.ensureRole('official')
    await vi.waitFor(() => expect(store.backfillDone.official).toBe(true))

    wsHandlers('live:official').onMessage({ role: 'official', ts: 1 })
    wsHandlers('live:official').onMessage(null)
    wsHandlers('live:official').onMessage(
      makeSample('official', 2000, { entityCount: 'x' as unknown as number }),
    )
    expect(store.samples.official).toHaveLength(0)
  })

  it('dispose 关闭全部连接并重置状态', async () => {
    mocks.fetchLiveSamples.mockResolvedValue({ role: 'official', samples: [] })
    const store = useLiveStore()
    store.ensureRole('official')
    await vi.waitFor(() => expect(store.backfillDone.official).toBe(true))

    store.dispose()
    expect(mocks.closeByChannel.get('live:official')).toHaveBeenCalled()
    expect(store.samples.official).toHaveLength(0)
    expect(store.backfillDone.official).toBe(false)
    expect(store.wsState.official).toBe('connecting')
  })
})
