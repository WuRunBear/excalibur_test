/**
 * 实例管理 store（S1-D2）。
 *
 * - 持有 official / preview 双实例快照；
 * - 订阅 WS 'instance:state' 频道实时更新（断线指数退避重连由 api 层封装）；
 *   WS 不可用时自动降级为 5s 轮询 REST 兜底，重连成功后停止轮询并立即拉取一次；
 * - start / stop / restart action：乐观状态 + 失败回滚，反馈走 ElMessage。
 */
import { ref } from 'vue'
import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'

import {
  AdminApiError,
  fetchInstances,
  INSTANCE_ROLE_LABELS,
  restartInstance,
  startInstance,
  stopInstance,
  subscribeAdminChannel,
} from '@/api/admin'
import type { InstanceRole, InstanceSnapshot } from '@/api/admin'

/** 实例操作名。 */
export type InstanceActionName = 'start' | 'stop' | 'restart'

/** WS 通道状态：连接中 / 实时推送 / 降级轮询。 */
export type AdminConnectionState = 'connecting' | 'online' | 'polling'

/** WS 不可用时的 REST 轮询间隔。 */
const POLL_INTERVAL_MS = 5000

/** WS 负载校验：instance:state 频道广播单角色 InstanceSnapshot。 */
function isInstanceSnapshot(value: unknown): value is InstanceSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    (v.role === 'official' || v.role === 'preview') &&
    (v.status === 'stopped' ||
      v.status === 'starting' ||
      v.status === 'running' ||
      v.status === 'crashed')
  )
}

function actionSuccessMessage(role: InstanceRole, action: InstanceActionName): string {
  const label = INSTANCE_ROLE_LABELS[role]
  if (action === 'stop') return `${label}已停止`
  if (action === 'start') return `${label}启动指令已执行，等待服务就绪`
  return `${label}重启指令已执行，等待服务就绪`
}

export const useInstanceStore = defineStore('admin-instance', () => {
  const snapshots = ref<Record<InstanceRole, InstanceSnapshot | null>>({
    official: null,
    preview: null,
  })
  const connection = ref<AdminConnectionState>('connecting')
  const lastLoadError = ref<string | null>(null)
  const pending = ref<Record<InstanceRole, Record<InstanceActionName, boolean>>>({
    official: { start: false, stop: false, restart: false },
    preview: { start: false, stop: false, restart: false },
  })

  let socketHandle: ReturnType<typeof subscribeAdminChannel> | null = null
  let pollTimer: number | null = null
  let loadAttempted = false

  /** 拉取双实例快照；失败时记录错误并向上抛出（由调用方决定提示方式）。 */
  async function fetchSnapshots(): Promise<void> {
    try {
      const detail = await fetchInstances()
      snapshots.value = { official: detail.official, preview: detail.preview }
      lastLoadError.value = null
    } catch (err) {
      lastLoadError.value = err instanceof Error ? err.message : String(err)
      throw err
    }
  }

  /** 手动刷新（失败直接提示）。 */
  async function refresh(): Promise<void> {
    try {
      await fetchSnapshots()
    } catch (err) {
      ElMessage.error(err instanceof AdminApiError ? err.message : '获取实例状态失败')
    }
  }

  /**
   * 仪表盘进页入口：建立 WS 状态流（幂等）并做首次 REST 拉取。
   * 首次拉取失败提示一次，不阻塞后续 WS / 轮询更新。
   */
  async function ensureLoaded(): Promise<void> {
    connectStateStream()
    if (loadAttempted) return
    loadAttempted = true
    try {
      await fetchSnapshots()
    } catch (err) {
      ElMessage.error(err instanceof AdminApiError ? err.message : '获取实例状态失败')
    }
  }

  /** 状态机约束：start 仅在 stopped/crashed；stop / restart 仅在 starting/running。 */
  function isActionAllowed(role: InstanceRole, action: InstanceActionName): boolean {
    const status = snapshots.value[role]?.status
    if (!status) return false
    if (action === 'start') return status === 'stopped' || status === 'crashed'
    return status === 'starting' || status === 'running'
  }

  function isPending(role: InstanceRole, action: InstanceActionName): boolean {
    return pending.value[role][action]
  }

  /** 该实例是否有任一操作在途（在途期间整组按钮禁用，避免并发操作打架）。 */
  function isBusy(role: InstanceRole): boolean {
    const p = pending.value[role]
    return p.start || p.stop || p.restart
  }

  /** WS 状态推送修订号：每落地一条 instance:state 递增，用于识别 REST 请求在途期间的更新。 */
  const wsRevision: Record<InstanceRole, number> = { official: 0, preview: 0 }

  /**
   * 执行实例操作：乐观状态 + 失败回滚。
   * - start / restart：立即呈现「启动中」；
   * - stop：状态机无中间态，保持现状由按钮 loading 表达，完成后由 REST/WS 收敛为 stopped。
   */
  async function performAction(role: InstanceRole, action: InstanceActionName): Promise<void> {
    const prev = snapshots.value[role]
    if (!prev) return
    if (isBusy(role)) return
    if (!isActionAllowed(role, action)) return

    pending.value[role][action] = true
    if (action === 'start' || action === 'restart') {
      snapshots.value[role] = { ...prev, status: 'starting' }
    }

    const revisionBefore = wsRevision[role]

    const request =
      action === 'start'
        ? startInstance(role)
        : action === 'stop'
          ? stopInstance(role)
          : restartInstance(role)

    try {
      const snapshot = await request
      // 在途期间若有 WS 推送落地，说明 store 已收到更新鲜的状态（REST 响应的快照
      // 生成早于其上，如 start 的 starting 响应晚于 running 推送到达）——丢弃本次
      // 响应快照，避免陈旧数据把「运行中」回退成「启动中」。
      if (wsRevision[role] === revisionBefore) {
        snapshots.value[role] = snapshot
      }
      ElMessage.success(actionSuccessMessage(role, action))
    } catch (err) {
      // 失败回滚：恢复操作前快照，并提示后端返回的 message。
      // 若在途期间 WS 已推送更新状态（如启动后瞬间崩溃的 crashed 广播），以 WS 为准、不回退。
      if (wsRevision[role] === revisionBefore) {
        snapshots.value[role] = prev
      }
      ElMessage.error(err instanceof AdminApiError ? err.message : '操作失败，请稍后重试')
    } finally {
      pending.value[role][action] = false
    }
  }

  function startPolling(): void {
    if (pollTimer !== null) return
    pollTimer = window.setInterval(() => {
      void fetchSnapshots().catch(() => {
        // 轮询静默失败，下一轮再试。
      })
    }, POLL_INTERVAL_MS)
  }

  function stopPolling(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  /** 建立 WS 状态流（幂等）；断线自动重连，重连前降级为轮询。 */
  function connectStateStream(): void {
    if (socketHandle) return
    socketHandle = subscribeAdminChannel('instance:state', {
      onMessage: (payload) => {
        if (!isInstanceSnapshot(payload)) return
        wsRevision[payload.role] += 1
        snapshots.value[payload.role] = payload
      },
      onOpen: () => {
        connection.value = 'online'
        stopPolling()
        // 重连成功后立即拉取一次，弥合断线期间的空窗。
        void fetchSnapshots().catch(() => {})
      },
      onClose: () => {
        connection.value = 'polling'
        startPolling()
      },
    })
  }

  /** 释放连接与计时器（测试 / HMR 用）。 */
  function dispose(): void {
    socketHandle?.close()
    socketHandle = null
    stopPolling()
    loadAttempted = false
    connection.value = 'connecting'
  }

  return {
    snapshots,
    connection,
    lastLoadError,
    pending,
    fetchSnapshots,
    refresh,
    ensureLoaded,
    isActionAllowed,
    isPending,
    isBusy,
    performAction,
    dispose,
  }
})
