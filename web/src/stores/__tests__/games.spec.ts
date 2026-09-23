import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  fetchGames: vi.fn(),
  fetchGameDetail: vi.fn(),
  patchGame: vi.fn(),
  syncGame: vi.fn(),
  deleteGame: vi.fn(),
}))

vi.mock('@/api/admin', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/admin')>()
  return {
    ...original,
    fetchGames: mocks.fetchGames,
    fetchGameDetail: mocks.fetchGameDetail,
    patchGame: mocks.patchGame,
    syncGame: mocks.syncGame,
    deleteGame: mocks.deleteGame,
  }
})

import type { GameDetail, GameListItem, GameListPayload } from '@/api/admin'
import { FALLBACK_GAME_ID, useGamesStore } from '@/stores/games'

function makeGame(overrides: Partial<GameListItem> = {}): GameListItem {
  return {
    id: 'gst',
    name: '默认游戏',
    isDefault: true,
    source: { type: 'local', path: '../game_server_test' },
    resolved: { commit: 'abc1234abcd', syncedAt: '2026-09-23T10:00:00.000Z', lockfileHash: 'hash' },
    ports: { official: 3000, preview: 3200 },
    createdAt: '2026-09-23T09:00:00.000Z',
    isImporting: false,
    sidecar: {
      fingerprint: 'fp',
      fingerprintSource: 'git-head',
      alive: false,
      pid: null,
      spawnFailures: 0,
      unavailable: null,
    },
    ...overrides,
  }
}

function payload(games: GameListItem[]): GameListPayload {
  const fallback = games.find((game) => game.isDefault) ?? games[0]
  return { defaultGameId: fallback ? fallback.id : '', games }
}

function makeDetail(id: string): GameDetail {
  return {
    id,
    name: id === 'gst' ? '默认游戏' : '演示',
    isDefault: id === 'gst',
    source: { type: 'local', path: '../game_server_test' },
    resolved: { commit: 'abc1234abcd', syncedAt: '2026-09-23T10:00:00.000Z', lockfileHash: 'hash' },
    ports: { official: 3000, preview: 3200 },
    createdAt: '2026-09-23T09:00:00.000Z',
    manifest: null,
    sidecar: {
      gameId: id,
      fingerprint: 'fp',
      fingerprintSource: 'git-head',
      client: { alive: false, pid: null, spawnFailures: 0, unavailable: null },
    },
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.fetchGames.mockReset()
  mocks.fetchGameDetail.mockReset()
  mocks.patchGame.mockReset()
  mocks.syncGame.mockReset()
  mocks.deleteGame.mockReset()
})

describe('useGamesStore', () => {
  it('ensureLoaded 拉取列表；初始管理目标 = 默认游戏 gst 且不矫正', async () => {
    mocks.fetchGames.mockResolvedValue(
      payload([makeGame(), makeGame({ id: 'demo', name: '演示', isDefault: false })]),
    )
    const store = useGamesStore()
    expect(store.currentGameId).toBe(FALLBACK_GAME_ID)
    expect(store.currentGameId).toBe('gst')

    await store.ensureLoaded()
    expect(store.loaded).toBe(true)
    expect(store.games).toHaveLength(2)
    expect(store.defaultGameId).toBe('gst')
    expect(store.currentGameId).toBe('gst')
    expect(store.epoch).toBe(0)
    expect(store.importing).toBe(false)
  })

  it('列表加载后当前游戏不在册时矫正为默认游戏并 bump epoch', async () => {
    mocks.fetchGames.mockResolvedValue(payload([makeGame({ id: 'other', name: '其他' })]))
    const store = useGamesStore()
    store.currentGameId = 'ghost'

    await store.ensureLoaded()
    expect(store.currentGameId).toBe('other')
    expect(store.epoch).toBe(1)
  })

  it('select 切换管理目标并 bump epoch；未知 id 拒绝；重复选中不 bump', async () => {
    mocks.fetchGames.mockResolvedValue(
      payload([makeGame(), makeGame({ id: 'demo', name: '演示', isDefault: false })]),
    )
    const store = useGamesStore()
    await store.ensureLoaded()

    expect(store.select('nope')).toBe(false)
    expect(store.currentGameId).toBe('gst')

    expect(store.select('demo')).toBe(true)
    expect(store.currentGameId).toBe('demo')
    expect(store.epoch).toBe(1)

    expect(store.select('demo')).toBe(true)
    expect(store.epoch).toBe(1)
  })

  it('load 失败记录 lastError 且不置 loaded', async () => {
    mocks.fetchGames.mockRejectedValue(new Error('网络中断'))
    const store = useGamesStore()
    await store.load()
    expect(store.loaded).toBe(false)
    expect(store.lastError).toBe('网络中断')
  })

  it('loadDetail 失败清空详情并记录 detailError', async () => {
    mocks.fetchGames.mockResolvedValue(payload([makeGame()]))
    mocks.fetchGameDetail.mockRejectedValue(new Error('详情不可得'))
    const store = useGamesStore()
    await store.ensureLoaded()

    await store.loadDetail('gst')
    expect(store.detail).toBeNull()
    expect(store.detailError).toBe('详情不可得')
  })

  it('runSync 调同步并刷新列表与详情', async () => {
    mocks.fetchGames.mockResolvedValue(payload([makeGame()]))
    mocks.fetchGameDetail.mockResolvedValue(makeDetail('gst'))
    const store = useGamesStore()
    await store.ensureLoaded()
    await store.loadDetail('gst')

    mocks.syncGame.mockResolvedValue({
      gameId: 'gst',
      action: 'updated',
      commit: 'def5678',
      lockfileHash: 'hash2',
      fingerprintSource: 'git',
      installRan: false,
      notes: ['lockfile 未变化，跳过依赖安装'],
    })
    const result = await store.runSync('gst')
    expect(mocks.syncGame).toHaveBeenCalledWith('gst')
    expect(result.notes).toHaveLength(1)
    expect(mocks.fetchGames).toHaveBeenCalledTimes(2)
    expect(mocks.fetchGameDetail).toHaveBeenCalledWith('gst')
  })

  it('savePatch 更新详情缓存并刷新列表', async () => {
    mocks.fetchGames.mockResolvedValue(payload([makeGame()]))
    mocks.fetchGameDetail.mockResolvedValue(makeDetail('gst'))
    const store = useGamesStore()
    await store.ensureLoaded()
    await store.loadDetail('gst')

    mocks.patchGame.mockResolvedValue({ ...makeDetail('gst'), name: '新名字' })
    const next = await store.savePatch('gst', { name: '新名字' })
    expect(mocks.patchGame).toHaveBeenCalledWith('gst', { name: '新名字' })
    expect(next.name).toBe('新名字')
    expect(store.detail?.name).toBe('新名字')
    expect(mocks.fetchGames).toHaveBeenCalledTimes(2)
  })

  it('remove 当前管理目标 → 回退默认游戏并 bump epoch，详情清空', async () => {
    mocks.fetchGames.mockResolvedValue(
      payload([makeGame(), makeGame({ id: 'demo', name: '演示', isDefault: false })]),
    )
    const store = useGamesStore()
    await store.ensureLoaded()
    store.select('demo')
    expect(store.epoch).toBe(1)

    mocks.deleteGame.mockResolvedValue({ gameId: 'demo', action: 'removed', notes: [] })
    mocks.fetchGames.mockResolvedValue(payload([makeGame()]))
    await store.remove('demo')

    expect(mocks.deleteGame).toHaveBeenCalledWith('demo')
    expect(store.currentGameId).toBe('gst')
    expect(store.epoch).toBe(2)
    expect(store.gameById('demo')).toBeUndefined()
  })

  it('remove 非当前管理目标 → 管理目标与 epoch 不变', async () => {
    mocks.fetchGames.mockResolvedValue(
      payload([makeGame(), makeGame({ id: 'demo', name: '演示', isDefault: false })]),
    )
    const store = useGamesStore()
    await store.ensureLoaded()

    mocks.deleteGame.mockResolvedValue({ gameId: 'demo', action: 'removed', notes: [] })
    mocks.fetchGames.mockResolvedValue(payload([makeGame()]))
    await store.remove('demo')

    expect(store.currentGameId).toBe('gst')
    expect(store.epoch).toBe(0)
  })
})
