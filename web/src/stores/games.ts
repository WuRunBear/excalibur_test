/**
 * 游戏管理 store（T2.10）。
 *
 * - 持有 GET /api/games 列表与当前管理目标 currentGameId（初始 = 默认游戏 gst）；
 *   admin.ts 的 REST/WS 寻址经 main.ts 注入的读取器读本 store，切换即全局生效；
 * - epoch：currentGameId 每次实际变化自增，各域 store 监听后失效重取自己的
 *   数据（工作区/配置/存档等均按 gameId 命名空间隔离）；
 * - 切换只改寻址上下文，**绝不启动/停止任何实例**（实例启停只在仪表盘）；
 * - 详情与维护动作（sync / PATCH / DELETE）面向"正在查看的游戏"，可与当前
 *   管理目标不同。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { deleteGame, fetchGameDetail, fetchGames, patchGame, syncGame } from '@/api/admin'
import type { GameDetail, GameListItem, GameSyncResult } from '@/api/admin'

/** 默认游戏 id（Q5；未加载列表前的初始上下文）。 */
export const FALLBACK_GAME_ID = 'gst'

export const useGamesStore = defineStore('admin-games', () => {
  const games = ref<GameListItem[]>([])
  const defaultGameId = ref('')
  const currentGameId = ref<string>(FALLBACK_GAME_ID)
  const loading = ref(false)
  const loaded = ref(false)
  const lastError = ref<string | null>(null)
  /** 上下文代数：切换游戏时自增，其他域 store 监听它做数据失效。 */
  const epoch = ref(0)

  const currentGame = computed(
    () => games.value.find((game) => game.id === currentGameId.value) ?? null,
  )

  /** 是否有任一游戏在导入/同步中（切换器与列表的状态呈现）。 */
  const importing = computed(() => games.value.some((game) => game.isImporting))

  function gameById(gameId: string): GameListItem | undefined {
    return games.value.find((game) => game.id === gameId)
  }

  /**
   * 当前 gameId 不在列表（被别处移除 / 初值失配）时校正为默认游戏。
   * 只在真正变化时 bump epoch，驱动已加载数据的域重取。
   */
  function correctCurrentGameId(): void {
    const ids = new Set(games.value.map((game) => game.id))
    if (ids.size > 0 && !ids.has(currentGameId.value)) {
      currentGameId.value = defaultGameId.value || FALLBACK_GAME_ID
      epoch.value += 1
    }
  }

  async function load(): Promise<void> {
    if (loading.value) return
    loading.value = true
    lastError.value = null
    try {
      const payload = await fetchGames()
      games.value = payload.games
      defaultGameId.value = payload.defaultGameId
      loaded.value = true
      correctCurrentGameId()
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : '获取游戏列表失败'
    } finally {
      loading.value = false
    }
  }

  /** 首次进入加载（幂等）。 */
  async function ensureLoaded(): Promise<void> {
    if (!loaded.value && !loading.value) await load()
  }

  /**
   * 切换当前管理目标（仅限已注册游戏）。只改 REST/WS 寻址上下文，
   * 不触碰实例启停；数据隔离由各域 store 监听 epoch 完成。
   */
  function select(gameId: string): boolean {
    if (!games.value.some((game) => game.id === gameId)) return false
    if (gameId === currentGameId.value) return true
    currentGameId.value = gameId
    epoch.value += 1
    return true
  }

  // -------------------------------------------------------------------------
  // 详情与维护动作（面向"正在查看的游戏"）
  // -------------------------------------------------------------------------

  const detail = ref<GameDetail | null>(null)
  const detailLoading = ref(false)
  const detailError = ref<string | null>(null)

  async function loadDetail(gameId: string): Promise<void> {
    detailLoading.value = true
    detailError.value = null
    try {
      detail.value = await fetchGameDetail(gameId)
    } catch (err) {
      detail.value = null
      detailError.value = err instanceof Error ? err.message : '获取游戏详情失败'
    } finally {
      detailLoading.value = false
    }
  }

  /** 详情指向的游戏有新数据时刷新（无详情或指向其他游戏则跳过）。 */
  async function refreshDetail(gameId?: string): Promise<void> {
    const target = detail.value
    if (!target) return
    if (gameId !== undefined && target.id !== gameId) return
    await loadDetail(target.id)
  }

  /** 重新同步（git 源）/ 重新探测（local 源）：幂等更新 + 刷新列表与详情。 */
  async function runSync(gameId: string): Promise<GameSyncResult> {
    const result = await syncGame(gameId)
    await Promise.allSettled([load(), refreshDetail(gameId)])
    return result
  }

  /** PATCH（registry 字段 / manifest 高级字段）：返回新详情并同步本地缓存。 */
  async function savePatch(gameId: string, body: Record<string, unknown>): Promise<GameDetail> {
    const next = await patchGame(gameId, body)
    if (detail.value?.id === gameId) detail.value = next
    await load()
    return next
  }

  /** 移除游戏；移除的是当前管理目标时回退默认游戏（bump epoch 驱动数据重取）。 */
  async function remove(gameId: string): Promise<void> {
    await deleteGame(gameId)
    if (detail.value?.id === gameId) detail.value = null
    if (currentGameId.value === gameId) {
      currentGameId.value = defaultGameId.value || FALLBACK_GAME_ID
      epoch.value += 1
    }
    await load()
  }

  return {
    games,
    defaultGameId,
    currentGameId,
    loading,
    loaded,
    lastError,
    epoch,
    currentGame,
    importing,
    detail,
    detailLoading,
    detailError,
    gameById,
    load,
    ensureLoaded,
    select,
    loadDetail,
    refreshDetail,
    runSync,
    savePatch,
    remove,
  }
})
