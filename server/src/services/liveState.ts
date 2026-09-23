/**
 * liveState 观察服务（S7-A）：管理后端作为 Colyseus 客户端观察运行中实例。
 *
 * 语义（重要）：
 * - joinOrCreate('game') 会在游戏内创建一个玩家实体（观察者本身就是一个玩家，
 *   含自己的 PlayerState），leave 时销毁。这是观察的固有代价，无法避免。
 * - 观察者是纯旁路：不发送任何输入/消息，只读 state，采样对游戏 tick 干扰最小化。
 *
 * 生命周期：
 * - 实例 running → 按该实例端口建立观察会话（join 失败指数退避重试，封顶 15s，
 *   初值 500ms；连接成功重置）；实例 stopped/crashed → leave + 停采样。
 * - 端口变化（实例重启到不同端口）→ 拆旧会话换端口重连。
 * - 连接/采样失败只记日志，绝不影响实例管理本身（旁路容错）。
 *
 * 采样：每 1000ms 从 room.state 读 {tick, 我的 PlayerState.visibleEntities.size}；
 * tickRate = 瞬时速率（tick 增量/间隔秒）的 3 次滑动平均，首样本 0。
 * 每次采样写入 300 条/role 环形缓冲（无订阅者也持续采样，供回填）并广播到
 * ws 频道 live:{role}。
 */
import { Client } from '@colyseus/sdk'
import type { Room } from '@colyseus/sdk'

import { defaultGameContext } from '../gameContext.js'
import type { InstanceRole, InstanceSnapshot, LiveSample } from '../types.js'
import type { WsChannel } from '../ws/hub.js'
import { wsHub } from '../ws/hub.js'

/**
 * 房间状态的最小结构视图（schema-less 观察见 gameBridge/index.ts 头注释）。
 * @colyseus/sdk 0.17 按服务端下发的 schema spec 动态解码，无需编译好的
 * schema 类；这里只声明采样用到的字段形状。
 */
interface RoomStateView {
  tick: number
  players: {
    size: number
    get(sessionId: string):
      | {
          entityId: number
          mapId: string
          visibleEntities: { size: number }
        }
      | undefined
  }
}

/** 环形缓冲容量（每 role）。 */
const RING_CAPACITY = 300
/** 采样间隔。 */
const SAMPLE_INTERVAL_MS = 1_000
/** 重连退避：初值 / 上限。 */
const RECONNECT_INITIAL_MS = 500
const RECONNECT_MAX_MS = 15_000
/** tickRate 滑动平均窗口（瞬时速率样本数）。 */
const RATE_WINDOW = 3

const ROLES: readonly InstanceRole[] = ['official', 'preview']

function channelOf(role: InstanceRole): WsChannel {
  return `live:${role}` as WsChannel
}

export class LiveStateService {
  /** 期望观察中的 role（running 时 true；stop/crash 后 false）。 */
  private readonly wanted = new Map<InstanceRole, boolean>()
  /** 活跃观察会话。 */
  private readonly rooms = new Map<InstanceRole, Room<unknown> | null>()
  /** 观察目标端口（对应实例快照端口）。 */
  private readonly ports = new Map<InstanceRole, number | null>()
  /** 采样定时器。 */
  private readonly sampleTimers = new Map<InstanceRole, NodeJS.Timeout | null>()
  /** 重连定时器（防重复排队）。 */
  private readonly reconnectTimers = new Map<InstanceRole, NodeJS.Timeout | null>()
  /** 当前退避间隔（成功后重置）。 */
  private readonly backoff = new Map<InstanceRole, number>()
  /** tickRate 平滑窗口（瞬时速率样本）。 */
  private readonly rateWindow = new Map<InstanceRole, number[]>()
  /** 上一次采样的 tick 与时间戳。 */
  private readonly lastTick = new Map<InstanceRole, number>()
  private readonly lastTs = new Map<InstanceRole, number>()

  /** 每 role 环形缓冲。 */
  private readonly rings: Record<InstanceRole, LiveSample[]> = {
    official: [],
    preview: [],
  }

  /** 实例状态变化入口（index.ts 订阅 instanceManager.onStateChange 接入）。 */
  handleInstanceStatus(role: InstanceRole, snapshot: InstanceSnapshot): void {
    if (snapshot.status === 'running') {
      void this.ensureObserver(role, snapshot.port)
      return
    }
    // stopped / crashed / starting（重连目标可能变化）→ 拆除观察
    void this.teardown(role)
  }

  /** 回填：最近 N 条（旧→新），limit 夹取 [1, 300]。 */
  getSamples(role: InstanceRole, limit: number): LiveSample[] {
    const n = Number.isFinite(limit) ? Math.floor(limit) : 120
    const clamped = Math.min(RING_CAPACITY, Math.max(1, n))
    return this.rings[role].slice(-clamped)
  }

  /** 全部观察会话拆除（admin 退出时调用）。 */
  stopAll(): void {
    for (const role of ROLES) void this.teardown(role)
  }

  // ---------------------------------------------------------------------------
  // 会话生命周期
  // ---------------------------------------------------------------------------

  private async ensureObserver(role: InstanceRole, port: number): Promise<void> {
    const prevPort = this.ports.get(role) ?? null
    if (this.rooms.get(role)) {
      if (prevPort === port) return // 已在同一实例上观察
      await this.teardown(role) // 端口变化：拆旧换新
    }
    this.wanted.set(role, true)
    this.ports.set(role, port)
    this.backoff.set(role, RECONNECT_INITIAL_MS)
    await this.connect(role, port)
  }

  private async connect(role: InstanceRole, port: number): Promise<void> {
    if (!this.wanted.get(role)) return
    try {
      const client = new Client(`ws://localhost:${port}`)
      // schema-less join（动态解码，见文件说明）；房间名出处 = context.roomName
      const room = (await client.joinOrCreate(defaultGameContext.roomName)) as Room<unknown>
      if (!this.wanted.get(role)) {
        // 等待 join 期间实例已停止：立即退出，不留观察者实体
        await room.leave(true).catch(() => {})
        return
      }
      this.rooms.set(role, room)
      this.backoff.set(role, RECONNECT_INITIAL_MS)
      this.resetRateState(role)
      console.log(
        `[liveState:${role}] joined "${defaultGameContext.roomName}" @:${port} (sessionId=${room.sessionId}) — 观察者在游戏内创建一个玩家实体`,
      )

      room.onLeave((code) => {
        if (this.rooms.get(role) === room) this.rooms.set(role, null)
        this.stopSampling(role)
        if (this.wanted.get(role)) {
          console.warn(`[liveState:${role}] room left (code=${code})，安排重连`)
          this.scheduleReconnect(role, port)
        } else {
          console.log(`[liveState:${role}] room left (code=${code})`)
        }
      })
      room.onError((code, message) => {
        // 房间级错误：只记日志（leave 事件会跟随触发重连判断）
        console.error(`[liveState:${role}] room error: code=${code}`, message ?? '')
      })

      this.startSampling(role)
    } catch (err) {
      const delay = this.backoff.get(role) ?? RECONNECT_INITIAL_MS
      this.backoff.set(role, Math.min(delay * 2, RECONNECT_MAX_MS))
      console.warn(
        `[liveState:${role}] join @:${port} 失败（${err instanceof Error ? err.message : String(err)}），${delay}ms 后重试`,
      )
      this.scheduleReconnect(role, port)
    }
  }

  private scheduleReconnect(role: InstanceRole, port: number): void {
    if (!this.wanted.get(role) || this.reconnectTimers.get(role)) return
    const delay = this.backoff.get(role) ?? RECONNECT_INITIAL_MS
    this.reconnectTimers.set(
      role,
      setTimeout(() => {
        this.reconnectTimers.set(role, null)
        void this.connect(role, port)
      }, delay),
    )
  }

  /** 拆除观察会话与采样（leave 在游戏内销毁观察者实体）。 */
  private async teardown(role: InstanceRole): Promise<void> {
    this.wanted.set(role, false)
    this.ports.set(role, null)
    this.backoff.set(role, RECONNECT_INITIAL_MS)
    const timer = this.reconnectTimers.get(role)
    if (timer) {
      clearTimeout(timer)
      this.reconnectTimers.set(role, null)
    }
    this.stopSampling(role)
    const room = this.rooms.get(role)
    this.rooms.set(role, null)
    if (room) {
      try {
        await room.leave(true)
        console.log(`[liveState:${role}] observer left`)
      } catch (err) {
        console.warn(`[liveState:${role}] leave failed:`, err instanceof Error ? err.message : err)
      }
    }
    this.resetRateState(role)
  }

  // ---------------------------------------------------------------------------
  // 采样
  // ---------------------------------------------------------------------------

  private startSampling(role: InstanceRole): void {
    this.stopSampling(role)
    void this.sample(role) // 首样本立即采集（tickRate=0）
    this.sampleTimers.set(role, setInterval(() => void this.sample(role), SAMPLE_INTERVAL_MS))
  }

  private stopSampling(role: InstanceRole): void {
    const timer = this.sampleTimers.get(role)
    if (timer) {
      clearInterval(timer)
      this.sampleTimers.set(role, null)
    }
  }

  private resetRateState(role: InstanceRole): void {
    this.rateWindow.set(role, [])
    this.lastTick.delete(role)
    this.lastTs.delete(role)
  }

  private sample(role: InstanceRole): void {
    const room = this.rooms.get(role)
    if (!room || !room.state) return // 首次状态同步未完成
    try {
      const state = room.state as unknown as RoomStateView | undefined
      // 初始状态同步未完成时 players 可能尚未就位：跳过本拍
      if (!state || !state.players) return
      const tick = state.tick
      // 观察者自己的 PlayerState（join 时游戏为其创建的实体）
      const me = state.players.get(room.sessionId)
      const entityCount = me ? me.visibleEntities.size : 0

      // tickRate：瞬时速率的滑动平均
      const now = Date.now()
      const prevTick = this.lastTick.get(role)
      const prevTs = this.lastTs.get(role)
      if (prevTick !== undefined && prevTs !== undefined && now > prevTs) {
        const window = this.rateWindow.get(role) ?? []
        window.push((tick - prevTick) / ((now - prevTs) / 1000))
        while (window.length > RATE_WINDOW) window.shift()
        this.rateWindow.set(role, window)
      }
      const rates = this.rateWindow.get(role) ?? []
      const tickRate =
        rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0
      this.lastTick.set(role, tick)
      this.lastTs.set(role, now)

      const sample: LiveSample = {
        role,
        ts: now,
        tick,
        tickRate: Math.round(tickRate * 100) / 100,
        entityCount,
      }
      const ring = this.rings[role]
      ring.push(sample)
      if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY)
      wsHub.broadcast(channelOf(role), sample)
    } catch (err) {
      // 旁路容错：采样异常只记日志
      console.error(`[liveState:${role}] sample failed:`, err instanceof Error ? err.message : err)
    }
  }
}

/** liveState 服务单例。 */
export const liveState = new LiveStateService()
