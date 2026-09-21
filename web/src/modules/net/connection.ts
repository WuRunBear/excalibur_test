import { Client, type Room } from '@colyseus/sdk'

import { resolveHttpBaseUrlFromWs, resolveServerUrl } from './config'
import type {
  CollisionDebugSnapshot,
  CommandPayload,
  InputPayload,
  MapRuntime,
  MapRuntimeResponse,
} from './types'
// RoomState 以「值」引入：joinOrCreate 需要类本身作为 rootSchema（仅 type 引入会在运行时 undefined）
import { RoomState } from './schema'

/**
 * Colyseus 连接封装：负责创建客户端、加入单房间、发送输入消息。
 *
 * 设计目标：
 * - 让引擎层（MyGame）只面对“连接/断开/发输入”这三个动作
 * - 房间类型固定为 "game"（单房间模式）
 */
export class GameConnection {
  /**
   * Colyseus SDK 客户端实例（首次 connect 时按目标地址懒创建）。
   */
  private clientInternal: Client | undefined
  /**
   * 当前加入的房间引用（只允许单房间）。
   */
  private roomInternal: Room<RoomState> | undefined
  /**
   * 首次 connect 实际使用的端点（地图等 HTTP 资源从同一实例拉取）。
   */
  private endpointInternal = resolveServerUrl('official')

  /**
   * 获取当前房间对象。
   *
   * @returns 已加入的房间；未连接时为 undefined
   */
  get room() {
    return this.roomInternal
  }

  /**
   * 获取连接使用的 WebSocket 端点。
   */
  get endpoint(): string {
    return this.endpointInternal
  }

  /**
   * 连接服务器并加入房间。
   *
   * 说明：
   * - 多次调用会复用同一个 room（避免重复 join）
   * - 客户端首次 connect 时创建，后续调用复用同一地址
   *
   * @param urlOverride 可选连接地址覆盖；默认 undefined → official 实例地址
   *   （resolveServerUrl('official')）。观察视图切换实例目标时传入
   *   resolveServerUrl(target)，地图等 HTTP 资源随之从同一实例拉取
   * @returns 成功加入后的房间对象
   */
  async connect(urlOverride?: string): Promise<Room<RoomState>> {
    if (this.roomInternal) return this.roomInternal
    if (!this.clientInternal) {
      this.endpointInternal = urlOverride ?? resolveServerUrl('official')
      this.clientInternal = new Client(this.endpointInternal)
    }
    // rootSchema 必须显式传入（SDK 的第三个参数）：缺省时 SDK 用 Reflection 反射态
    // 初始化 serializer，room.state.players 不是 MapSchema（无 .get），join 一返回
    // 读 state 即抛 TypeError——服务端 join 全绿、客户端却落 handleDisconnected 的根因。
    const room = await this.clientInternal.joinOrCreate<RoomState>('game', {}, RoomState)
    this.roomInternal = room
    return room
  }

  /**
   * 主动断开连接并离开房间。
   *
   * @returns 断开完成后 resolve
   */
  async disconnect(): Promise<void> {
    const room = this.roomInternal
    this.roomInternal = undefined
    if (room) await room.leave()
  }

  /**
   * 发送输入消息到服务端。
   *
   * @param payload 输入负载（seq/moveX/moveY/边沿信号）
   */
  sendInput(payload: InputPayload): void {
    this.roomInternal?.send('input', payload)
  }

  /**
   * 发送离散玩法命令到服务端。
   *
   * 说明：
   * - 对应协议 §2.2 的 "command" 通道（consume/drop/transfer/craft/equip/place/deconstruct/dialogue）
   * - 命令失败无回执（服务端零副作用），以状态变化为准
   *
   * @param payload 命令负载
   */
  sendCommand(payload: CommandPayload): void {
    this.roomInternal?.send('command', payload)
  }

  /**
   * 订阅碰撞调试快照消息。
   *
   * @param onSnapshot 收到快照后的回调
   * @returns 取消订阅函数
   */
  subscribeCollisionDebugSnapshots(
    onSnapshot: (snapshot: CollisionDebugSnapshot) => void,
  ): () => void {
    const room = this.roomInternal
    if (!room) return () => {}
    return room.onMessage('debug_colliders_snapshot', onSnapshot)
  }

  /**
   * 打开服务端碰撞调试推送。
   */
  subscribeCollisionDebugStream(): void {
    this.roomInternal?.send('debug_colliders_subscribe')
  }

  /**
   * 关闭服务端碰撞调试推送。
   */
  unsubscribeCollisionDebugStream(): void {
    this.roomInternal?.send('debug_colliders_unsubscribe')
  }

  /**
   * 请求服务端立即回传一帧碰撞调试快照。
   */
  requestCollisionDebugSnapshot(): void {
    this.roomInternal?.send('debug_colliders_pull')
  }

  /**
   * 拉取服务端当前地图运行时数据（用于客户端显示）。
   *
   * 说明：
   * - 地图不通过 Colyseus state 同步，改为 HTTP 拉取一次
   * - 响应契约 = 服务端 SerializedMapGeometry：{key, grid, tiles, walkable,
   *   regions, regionOfTile, version}；客户端把 walkable 位图取反为 blocked
   * - 响应形状不符（缺 key/grid/walkable/version、walkable 长度不符）时显式抛错，
   *   绝不静默错配
   *
   * @param mapId 可选地图 id（= 服务端地图 key）；提供时作为 ?mapId 查询参数传给服务端
   * @returns 地图运行时数据（blocked 为扁平 Uint8Array，1=阻挡）
   */
  async fetchMapRuntime(mapId?: string): Promise<MapRuntime> {
    const httpBase = resolveHttpBaseUrlFromWs(this.endpointInternal)
    const url = mapId
      ? `${httpBase}/maps/runtime?mapId=${encodeURIComponent(mapId)}`
      : `${httpBase}/maps/runtime`
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`fetch map runtime failed: ${resp.status}`)
    const json = (await resp.json()) as MapRuntimeResponse

    if (typeof json.key !== 'string' || json.key === '') {
      throw new Error('地图运行时响应缺少 key 字段')
    }
    if (
      !json.grid ||
      typeof json.grid.width !== 'number' ||
      typeof json.grid.height !== 'number' ||
      typeof json.grid.tileWidth !== 'number' ||
      typeof json.grid.tileHeight !== 'number'
    ) {
      throw new Error('地图运行时响应缺少 grid 字段')
    }
    if (typeof json.version !== 'string') {
      throw new Error('地图运行时响应缺少 version 字段')
    }
    if (!Array.isArray(json.walkable)) {
      throw new Error('地图运行时响应缺少 walkable 字段')
    }

    const size = json.grid.width * json.grid.height
    if (json.walkable.length !== size) {
      throw new Error(`地图 walkable 长度不符：期望 ${size}，实际 ${json.walkable.length}`)
    }

    // 服务端 walkable（0=阻挡，非 0=可走）→ 客户端 blocked（1=阻挡，行主序）
    const blocked = new Uint8Array(size)
    for (let i = 0; i < size; i++) blocked[i] = json.walkable[i] ? 0 : 1

    return {
      id: json.key,
      name: json.key,
      grid: json.grid,
      version: json.version,
      blocked,
    }
  }

  /**
   * 拉取服务端当前帧的碰撞调试快照（用于可视化真实碰撞体）。
   *
   * @returns 碰撞调试快照
   */
  async fetchCollisionDebugSnapshot(): Promise<CollisionDebugSnapshot> {
    const resp = await fetch(`${resolveHttpBaseUrlFromWs(this.endpointInternal)}/debug/colliders`)
    if (!resp.ok) throw new Error(`fetch collision debug snapshot failed: ${resp.status}`)
    return (await resp.json()) as CollisionDebugSnapshot
  }
}
