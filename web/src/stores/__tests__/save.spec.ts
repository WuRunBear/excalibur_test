import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  fetchSaves: vi.fn(),
  fetchSaveDetail: vi.fn(),
  deleteSave: vi.fn(),
  restoreSave: vi.fn(),
  messageSuccess: vi.fn(),
  messageError: vi.fn(),
  messageWarning: vi.fn(),
}))

vi.mock('@/api/admin', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/admin')>()
  return {
    ...original,
    fetchSaves: mocks.fetchSaves,
    fetchSaveDetail: mocks.fetchSaveDetail,
    deleteSave: mocks.deleteSave,
    restoreSave: mocks.restoreSave,
  }
})

vi.mock('element-plus', () => ({
  ElMessage: {
    success: mocks.messageSuccess,
    error: mocks.messageError,
    warning: mocks.messageWarning,
  },
}))

import { useSaveStore } from '@/stores/save'
import type { SavesPayload } from '@/api/admin'

function payload(overrides: Partial<SavesPayload> = {}): SavesPayload {
  return {
    scope: 'official',
    dir: '/game/data/saves',
    saves: [
      {
        file: 'slot-1.json',
        saveId: 'slot-1',
        sizeBytes: 2048,
        mtime: 1_700_000_000_000,
        summary: {
          tick: 42,
          savedAt: 1_700_000_000_000,
          mapCount: 2,
          entityCount: 7,
          timeOfDay: null,
          kindStats: {},
        },
      },
      {
        file: 'broken.json',
        saveId: 'broken',
        sizeBytes: 10,
        mtime: 1_700_000_000_000,
        summary: null,
      },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.fetchSaves.mockReset()
  mocks.fetchSaveDetail.mockReset()
  mocks.deleteSave.mockReset()
  mocks.restoreSave.mockReset()
  mocks.messageSuccess.mockReset()
  mocks.messageError.mockReset()
  mocks.messageWarning.mockReset()
})

describe('useSaveStore', () => {
  it('load 拉取清单：scope/目录/可解析计数', async () => {
    mocks.fetchSaves.mockResolvedValue(payload())
    const store = useSaveStore()
    await store.load('official')
    expect(store.dir).toBe('/game/data/saves')
    expect(store.saves).toHaveLength(2)
    expect(store.parsedCount).toBe(1)
    expect(store.lastError).toBeNull()
  })

  it('openDetail 载入详情（maps / topKinds）', async () => {
    mocks.fetchSaveDetail.mockResolvedValue({
      file: 'slot-1.json',
      summary: {
        tick: 42,
        savedAt: 1,
        mapCount: 1,
        entityCount: 2,
        timeOfDay: null,
        kindStats: {},
      },
      maps: [{ mapKey: 'home' }],
      topKinds: [{ kind: 'wolf', count: 3 }],
    })
    const store = useSaveStore()
    await store.openDetail('slot-1.json')
    expect(store.detailVisible).toBe(true)
    expect(store.detail?.maps).toEqual([{ mapKey: 'home' }])
    expect(store.detail?.topKinds).toEqual([{ kind: 'wolf', count: 3 }])
  })

  it('remove 成功提示并刷新清单', async () => {
    mocks.fetchSaves.mockResolvedValue(payload())
    mocks.deleteSave.mockResolvedValue({ file: 'broken.json' })
    const store = useSaveStore()
    await store.load('official')
    const ok = await store.remove('broken.json')
    expect(ok).toBe(true)
    expect(mocks.messageSuccess).toHaveBeenCalledWith('已删除存档 broken.json')
    expect(mocks.fetchSaves).toHaveBeenCalledTimes(2)
  })

  it('restore warnRestart 时给出长时警告提示', async () => {
    mocks.restoreSave.mockResolvedValue({ restoredTo: 'slot-1', warnRestart: true })
    const store = useSaveStore()
    const ok = await store.restore('slot-1.json')
    expect(ok).toBe(true)
    expect(mocks.messageWarning).toHaveBeenCalledTimes(1)
  })

  it('restore 无需重启时走成功提示', async () => {
    mocks.restoreSave.mockResolvedValue({ restoredTo: 'slot-1', warnRestart: false })
    const store = useSaveStore()
    const ok = await store.restore('slot-1.json')
    expect(ok).toBe(true)
    expect(mocks.messageSuccess).toHaveBeenCalledWith('已恢复为 slot-1')
  })
})
