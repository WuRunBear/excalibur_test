/**
 * 游戏观察采样 store（S7-B）。
 *
 * - 持有 official / preview 双角色的运行采样环形缓冲（tick 速率 / 实体总数）；
 * - 订阅 WS live:{role} 频道接收每秒增量（断线指数退避重连由 api 层封装）；
 * - 进页先 REST 回填最近窗口，回填完成前到达的 WS 消息先进缓冲，保证「先历史后增量」；
 * - WS 断线重连成功后自动补拉，按 ts 去重只追加缺失段，图表不重建实例增量更新。
 */
import { ref } from 'vue'
import { defineStore } from 'pinia'

import { fetchLiveSamples, isLiveSampleMessage, subscribeAdminChannel } from '@/api/admin'
import type { AdminChannel, AdminSocketHandle, InstanceRole, LiveSample } from '@/api/admin'

/** WS 通道状态：连接中 / 实时推送 / 已断开（重连中）。 */
export type LiveWsState = 'connecting' | 'online' | 'offline'

/** 本地缓冲上限（与服务端环形缓冲 300 对齐）。 */
export const LIVE_BUFFER_CAP = 300

/** 趋势图展示窗口（最近点数）。 */
export const LIVE_WINDOW = 120

function emptyRoles<T>(value: T): Record<InstanceRole, T> {
  return { official: value, preview: value }
}

/** 追加采样并保序去重：ts 必须严格递增，环形超限丢最旧。 */
function appendSample(buffer: LiveSample[], sample: LiveSample): void {
  const last = buffer[buffer.length - 1]
  if (last && sample.ts <= last.ts) return
  buffer.push(sample)
  if (buffer.length > LIVE_BUFFER_CAP) buffer.splice(0, buffer.length - LIVE_BUFFER_CAP)
}

export const useLiveStore = defineStore('admin-live', () => {
  const samples = ref<Record<InstanceRole, LiveSample[]>>(emptyRoles<LiveSample[]>([]))
  const wsState = ref<Record<InstanceRole, LiveWsState>>(emptyRoles<LiveWsState>('connecting'))
  /** REST 回填是否完成（决定 WS 增量直接入缓冲还是先进待合并队列）。 */
  const backfillDone = ref<Record<InstanceRole, boolean>>(emptyRoles(false))

  const socketHandles = ref<Record<InstanceRole, AdminSocketHandle | null>>(
    emptyRoles<AdminSocketHandle | null>(null),
  )
  /** 回填完成前到达的 WS 消息（保证顺序）。 */
  const pendingLive = ref<Record<InstanceRole, LiveSample[]>>(emptyRoles<LiveSample[]>([]))
  /** 回填在途标记（避免直连兜底与 WS onOpen 并发重复拉取）。 */
  const backfillInFlight = ref<Record<InstanceRole, boolean>>(emptyRoles(false))

  /** 追加一条增量采样（ts 去重 + 环形上限）。 */
  function ingest(role: InstanceRole, sample: LiveSample): void {
    appendSample(samples.value[role], sample)
  }

  /**
   * REST 回填。initial：进页 / 首连，历史 + 待合并增量合成缓冲；
   * merge：WS 断线重连后的补拉，仅追加本地缺失（ts 更新）的段。
   */
  async function backfill(role: InstanceRole, mode: 'initial' | 'merge'): Promise<void> {
    if (backfillInFlight.value[role]) return
    backfillInFlight.value[role] = true
    try {
      const detail = await fetchLiveSamples(role, LIVE_WINDOW)
      if (mode === 'initial') {
        const buffered = pendingLive.value[role].splice(0)
        const lastSample = detail.samples.at(-1)
        const lastTs = lastSample ? lastSample.ts : 0
        samples.value[role] = [...detail.samples, ...buffered.filter((s) => s.ts > lastTs)]
        backfillDone.value[role] = true
        return
      }
      for (const sample of detail.samples) {
        ingest(role, sample)
      }
    } finally {
      backfillInFlight.value[role] = false
    }
  }

  /** 建立 WS live 流并做首次回填（幂等，按角色）。 */
  function ensureRole(role: InstanceRole): void {
    if (socketHandles.value[role]) return
    const channel: AdminChannel = `live:${role}`
    socketHandles.value[role] = subscribeAdminChannel(channel, {
      onMessage: (payload) => {
        if (!isLiveSampleMessage(payload) || payload.role !== role) return
        const sample: LiveSample = {
          ts: payload.ts,
          tick: payload.tick,
          tickRate: payload.tickRate,
          entityCount: payload.entityCount,
        }
        if (!backfillDone.value[role]) {
          const buffer = pendingLive.value[role]
          buffer.push(sample)
          if (buffer.length > LIVE_BUFFER_CAP) buffer.splice(0, buffer.length - LIVE_BUFFER_CAP)
          return
        }
        ingest(role, sample)
      },
      onOpen: () => {
        wsState.value[role] = 'online'
        // 首连未完成回填 → 补做 initial；之后的 open 视为断线重连 → 增量补拉。
        void backfill(role, backfillDone.value[role] ? 'merge' : 'initial').catch(() => {
          // 回填失败不阻塞 WS 增量；下次重连会自动重试。
        })
      },
      onClose: () => {
        wsState.value[role] = 'offline'
      },
    })
    // WS 建连通常先于订阅方渲染完成，这里直接做一次回填兜底（onOpen 成功后由 merge 幂等补拉）。
    void backfill(role, backfillDone.value[role] ? 'merge' : 'initial').catch(() => {})
  }

  /** 最近 WINDOW 个采样（旧→新），供图表直接消费。 */
  function windowOf(role: InstanceRole): LiveSample[] {
    return samples.value[role].slice(-LIVE_WINDOW)
  }

  /** 释放连接与缓冲（测试 / HMR 用）。 */
  function dispose(): void {
    for (const role of ['official', 'preview'] as const) {
      socketHandles.value[role]?.close()
      socketHandles.value[role] = null
      pendingLive.value[role] = []
      backfillDone.value[role] = false
      samples.value[role] = []
      wsState.value[role] = 'connecting'
    }
  }

  return {
    samples,
    wsState,
    backfillDone,
    ensureRole,
    windowOf,
    ingest,
    dispose,
  }
})
