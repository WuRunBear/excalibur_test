import type { RoomState } from 'game/net/schema'

/**
 * 实体形状类型。
 *
 * 约定：
 * - 0 表示圆形
 * - 1 表示矩形
 */
export type EntityShape = 0 | 1

/**
 * 实体的可渲染快照（对外只暴露 UI/渲染需要的字段）。
 *
 * 说明：
 * - id 是服务端 NetworkId（稳定）
 * - x/y 为世界坐标
 * - hp 为生命值（服务端权威）
 * - shape/radius/w/h 用于前端按服务端形状与尺寸渲染
 */
export interface EntitySnapshot {
  id: number
  x: number
  y: number
  hp: number
  shape: EntityShape
  radius: number
  w: number
  h: number
}

/**
 * 把数值夹到 [0, 1]。
 *
 * @param n 原始值
 * @returns 夹紧后的值
 */
function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

/**
 * 线性插值。
 *
 * @param a 起点值
 * @param b 终点值
 * @param t 插值系数（0~1）
 * @returns 插值结果
 */
function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

/**
 * 房间实体快照存储与插值采样器。
 *
 * 设计目标：
 * - onStateChange 到来的频率通常低于渲染帧率
 * - 这里缓存 last/current 两份快照，并在渲染时做插值，让移动更平滑
 *
 * 注意：
 * - 本实现是“轻量插值”，不做客户端预测/回滚
 * - 当实体首次出现或中途新增时，会直接使用 current 值
 */
export class EntityStore {
  private lastTick = 0
  private currentTick = 0
  private lastReceivedAtMs = 0
  private currentReceivedAtMs = 0

  private last = new Map<number, EntitySnapshot>()
  private current = new Map<number, EntitySnapshot>()

  /**
   * @param tickIntervalMs 服务端 tick 间隔（毫秒），用于计算插值比例
   */
  constructor(private readonly tickIntervalMs: number) {}

  /**
   * 获取当前缓存的服务端 tick。
   */
  get tick() {
    return this.currentTick
  }

  /**
   * 获取当前快照到达的本地时间戳（毫秒）。
   */
  get receivedAtMs() {
    return this.currentReceivedAtMs
  }

  /**
   * 重置全部快照缓存。
   *
   * 用于断线、销毁或重新连接后清空旧的服务端状态。
   */
  reset() {
    this.lastTick = 0
    this.currentTick = 0
    this.lastReceivedAtMs = 0
    this.currentReceivedAtMs = 0
    this.last.clear()
    this.current.clear()
  }

  /**
   * 从 RoomState 写入最新快照，并维护 last/current 两份缓存。
   *
   * @param state Colyseus 房间状态（已自动合并增量补丁）
   * @param nowMs 本地当前时间（毫秒）
   */
  updateFromRoomState(state: RoomState, nowMs: number) {
    const nextTick = state.tick

    if (this.currentTick === 0) {
      this.currentTick = nextTick
      this.lastTick = nextTick
      this.currentReceivedAtMs = nowMs
      this.lastReceivedAtMs = nowMs
      this.current = this.readEntities(state)
      this.last = new Map(this.current)
      return
    }

    if (nextTick !== this.currentTick) {
      this.lastTick = this.currentTick
      this.lastReceivedAtMs = this.currentReceivedAtMs
      this.last = this.current
    }

    this.currentTick = nextTick
    this.currentReceivedAtMs = nowMs
    this.current = this.readEntities(state)
  }

  /**
   * 采样一份“用于渲染”的实体快照表。
   *
   * @param nowMs 本地当前时间（毫秒）
   * @returns 采样后的实体快照表（key=entityId）
   */
  sample(nowMs: number): Map<number, EntitySnapshot> {
    if (this.currentTick === 0) return new Map()
    const t = clamp01((nowMs - this.currentReceivedAtMs) / this.tickIntervalMs)
    const result = new Map<number, EntitySnapshot>()

    for (const [id, curr] of this.current) {
      const prev = this.last.get(id)
      if (!prev) {
        result.set(id, curr)
        continue
      }

      result.set(id, {
        id,
        x: lerp(prev.x, curr.x, t),
        y: lerp(prev.y, curr.y, t),
        hp: curr.hp,
        shape: curr.shape,
        radius: curr.radius,
        w: curr.w,
        h: curr.h,
      })
    }

    return result
  }

  /**
   * 把 RoomState.entities 转换为可渲染快照表。
   *
   * @param state 房间状态
   * @returns 实体快照表（key=entityId）
   */
  private readEntities(state: RoomState) {
    const map = new Map<number, EntitySnapshot>()

    state.entities.forEach((entity) => {
      map.set(entity.id, {
        id: entity.id,
        x: entity.x,
        y: entity.y,
        hp: entity.hp,
        shape: entity.shape as EntityShape,
        radius: entity.radius,
        w: entity.w,
        h: entity.h,
      })
    })

    return map
  }
}
