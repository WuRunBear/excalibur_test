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
 * ws 频道 live:{gameId}:{role}（T2.4 公式；hub 白名单改版在 T2.7）。
 *
 * T2.4 per-game 实例化：每游戏一个 LiveStateService 实例（servicesFor(gameId).live），
 * 内部态 Map 的 key 一律 `<gameId>:<role>`；roomName 读自各自 context
 * （manifest.observer.roomName 合成而来）。
 */
import { Client } from '@colyseus/sdk'
import type { Room } from '@colyseus/sdk'

import { defaultGameContext, type GameContext } from '../gameContext.js'
import { toHolder } from './workspaceService.js'
import type { ContextHolder } from './index.js'
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

/**
 * live 采样 WS 频道名（T2.4 公式）：`live:{gameId}:{role}`。
 * 纯函数导出供单测与 T2.7 hub 白名单/路由复用。
 * 注意：ws/hub.ts 的频道白名单改版在 T2.7——在此之前本频道名尚无法被订阅
 * （broadcast 无订阅者为 no-op），属 Phase 2 内部过渡态。
 */
export function liveChannel(gameId: string, role: InstanceRole): string {
  return `live:${gameId}:${role}`
}

/** 构造参数（T2.4 per-game 实例化）。 */
export interface LiveStateServiceOptions {
  /** 游戏上下文（或容器 contextHolder）：roomName 的出处（manifest.observer）。 */
  context: GameContext | ContextHolder
}

export class LiveStateService {
  private readonly holder: ContextHolder

  constructor(options: LiveStateServiceOptions) {
    this.holder = toHolder(options.context)
  }

  /** 当前上下文（容器热更新后自动生效）。 */
  private get ctx(): GameContext {
    return this.holder.current
  }

  /** per-game 内部态的 key：`<gameId>:<role>`（规格 T2.4：Map<role,…> key 变此公式）。 */
  private keyOf(role: InstanceRole): string {
    return `${this.ctx.gameId}:${role}`
  }

  /** 期望观察中的 role（running 时 true；stop/crash 后 false）。 */
  private readonly wanted = new Map<string, boolean>()
  /** 活跃观察会话。 */
  private readonly rooms = new Map<string, Room<unknown> | null>()
  /** 观察目标端口（对应实例快照端口）。 */
  private readonly ports = new Map<string, number | null>()
  /** 采样定时器。 */
  private readonly sampleTimers = new Map<string, NodeJS.Timeout | null>()
  /** 重连定时器（防重复排队）。 */
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout | null>()
  /** 当前退避间隔（成功后重置）。 */
  private readonly backoff = new Map<string, number>()
  /** tickRate 平滑窗口（瞬时速率样本）。 */
  private readonly rateWindow = new Map<string, number[]>()
  /** 上一次采样的 tick 与时间戳。 */
  private readonly lastTick = new Map<string, number>()
  private readonly lastTs = new Map<string, number>()

  /** 每 role 环形缓冲（懒建，key = `<gameId>:<role>`）。 */
  private readonly rings = new Map<string, LiveSample[]>()

  /** 实例状态变化入口（index.ts 订阅 instanceManager.onStateChange 接入）。 */
  handleInstanceStatus(role: InstanceRole, snapshot: InstanceSnapshot): void {
    // 防串台：快照带 gameId 时只处理本游戏的实例（T2.7 起多游戏并存）
    if (snapshot.gameId !== undefined && snapshot.gameId !== this.ctx.gameId) return
    const key = this.keyOf(role)
    if (snapshot.status === 'running') {
      void this.ensureObserver(key, role, snapshot.port)
      return
    }
    // stopped / crashed / starting（重连目标可能变化）→ 拆除观察
    void this.teardown(key)
  }

  /** 回填：最近 N 条（旧→新），limit 夹取 [1, 300]。 */
  getSamples(role: InstanceRole, limit: number): LiveSample[] {
    const n = Number.isFinite(limit) ? Math.floor(limit) : 120
    const clamped = Math.min(RING_CAPACITY, Math.max(1, n))
    return (this.rings.get(this.keyOf(role)) ?? []).slice(-clamped)
  }

  /** 本游戏全部观察会话拆除（admin 退出时调用；per-game 实例只拆自己的 key）。 */
  stopAll(): void {
    for (const key of [...this.wanted.keys()]) {
      const role = (key.slice(key.lastIndexOf(':') + 1) || 'official') as InstanceRole
      void this.teardown(key)
    }
  }

  // ---------------------------------------------------------------------------
  // 会话生命周期
  // ---------------------------------------------------------------------------

  private async ensureObserver(key: string, role: InstanceRole, port: number): Promise<void> {
    const prevPort = this.ports.get(key) ?? null
    if (this.rooms.get(key)) {
      if (prevPort === port) return // 已在同一实例上观察
      await this.teardown(key) // 端口变化：拆旧换新
    }
    this.wanted.set(key, true)
    this.ports.set(key, port)
    this.backoff.set(key, RECONNECT_INITIAL_MS)
    await this.connect(key, role, port)
  }

  private async connect(key: string, role: InstanceRole, port: number): Promise<void> {
    if (!this.wanted.get(key)) return
    try {
      const client = new Client(`ws://localhost:${port}`)
      // schema-less join（动态解码，见文件说明）；房间名出处 = context.roomName
      // （T2.4：per-game，从 manifest.observer.roomName 合成而来）
      const roomName = this.ctx.roomName
      const room = (await client.joinOrCreate(roomName)) as Room<unknown>
      if (!this.wanted.get(key)) {
        // 等待 join 期间实例已停止：立即退出，不留观察者实体
        await room.leave(true).catch(() => {})
        return
      }
      this.rooms.set(key, room)
      this.backoff.set(key, RECONNECT_INITIAL_MS)
      this.resetRateState(key)
      console.log(
        `[liveState:${key}] joined "${roomName}" @:${port} (sessionId=${room.sessionId}) — 观察者在游戏内创建一个玩家实体`,
      )

      room.onLeave((code) => {
        if (this.rooms.get(key) === room) this.rooms.set(key, null)
        this.stopSampling(key)
        if (this.wanted.get(key)) {
          console.warn(`[liveState:${key}] room left (code=${code})，安排重连`)
          this.scheduleReconnect(key, role, port)
        } else {
          console.log(`[liveState:${key}] room left (code=${code})`)
        }
      })
      room.onError((code, message) => {
        // 房间级错误：只记日志（leave 事件会跟随触发重连判断）
        console.error(`[liveState:${key}] room error: code=${code}`, message ?? '')
      })

      this.startSampling(key, role)
    } catch (err) {
      const delay = this.backoff.get(key) ?? RECONNECT_INITIAL_MS
      this.backoff.set(key, Math.min(delay * 2, RECONNECT_MAX_MS))
      console.warn(
        `[liveState:${key}] join @:${port} 失败（${err instanceof Error ? err.message : String(err)}），${delay}ms 后重试`,
      )
      this.scheduleReconnect(key, role, port)
    }
  }

  private scheduleReconnect(key: string, role: InstanceRole, port: number): void {
    if (!this.wanted.get(key) || this.reconnectTimers.get(key)) return
    const delay = this.backoff.get(key) ?? RECONNECT_INITIAL_MS
    this.reconnectTimers.set(
      key,
      setTimeout(() => {
        this.reconnectTimers.set(key, null)
        void this.connect(key, role, port)
      }, delay),
    )
  }

  /** 拆除观察会话与采样（leave 在游戏内销毁观察者实体）。 */
  private async teardown(key: string): Promise<void> {
    this.wanted.set(key, false)
    this.ports.set(key, null)
    this.backoff.set(key, RECONNECT_INITIAL_MS)
    const timer = this.reconnectTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.reconnectTimers.set(key, null)
    }
    this.stopSampling(key)
    const room = this.rooms.get(key)
    this.rooms.set(key, null)
    if (room) {
      try {
        await room.leave(true)
        console.log(`[liveState:${key}] observer left`)
      } catch (err) {
        console.warn(`[liveState:${key}] leave failed:`, err instanceof Error ? err.message : err)
      }
    }
    this.resetRateState(key)
  }

  // ---------------------------------------------------------------------------
  // 采样
  // ---------------------------------------------------------------------------

  private startSampling(key: string, role: InstanceRole): void {
    this.stopSampling(key)
    void this.sample(key, role) // 首样本立即采集（tickRate=0）
    this.sampleTimers.set(key, setInterval(() => void this.sample(key, role), SAMPLE_INTERVAL_MS))
  }

  private stopSampling(key: string): void {
    const timer = this.sampleTimers.get(key)
    if (timer) {
      clearInterval(timer)
      this.sampleTimers.set(key, null)
    }
  }

  private resetRateState(key: string): void {
    this.rateWindow.set(key, [])
    this.lastTick.delete(key)
    this.lastTs.delete(key)
  }

  private sample(key: string, role: InstanceRole): void {
    const room = this.rooms.get(key)
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
      const prevTick = this.lastTick.get(key)
      const prevTs = this.lastTs.get(key)
      if (prevTick !== undefined && prevTs !== undefined && now > prevTs) {
        const window = this.rateWindow.get(key) ?? []
        window.push((tick - prevTick) / ((now - prevTs) / 1000))
        while (window.length > RATE_WINDOW) window.shift()
        this.rateWindow.set(key, window)
      }
      const rates = this.rateWindow.get(key) ?? []
      const tickRate =
        rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0
      this.lastTick.set(key, tick)
      this.lastTs.set(key, now)

      const sample: LiveSample = {
        role,
        ts: now,
        tick,
        tickRate: Math.round(tickRate * 100) / 100,
        entityCount,
      }
      let ring = this.rings.get(key)
      if (!ring) {
        ring = []
        this.rings.set(key, ring)
      }
      ring.push(sample)
      if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY)
      // T2.4 频道公式：live:{gameId}:{role}（hub 白名单改版在 T2.7，见 liveChannel 注释）
      wsHub.broadcast(liveChannel(this.ctx.gameId, role) as WsChannel, sample)
    } catch (err) {
      // 旁路容错：采样异常只记日志
      console.error(`[liveState:${key}] sample failed:`, err instanceof Error ? err.message : err)
    }
  }
}

/**
 * liveState 服务单例（compat 壳，T2.4）：绑定 defaultGameContext（≡ forGame('gst')
 * 语义，roomName='game'）；频道名随之变为 live:gst:{role}（hub 白名单 T2.7 改版）。
 * 路由层改接 servicesFor 是 T2.7 的事，本单例保证过渡期行为连续。
 */
export const liveState = new LiveStateService({ context: defaultGameContext })
