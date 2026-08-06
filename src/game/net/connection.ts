import { Client, type Room } from '@colyseus/sdk'

import { gameServerHttpBaseUrl, gameServerUrl } from './config'
import type {
  CollisionDebugSnapshot,
  CommandPayload,
  InputPayload,
  MapRuntime,
  MapRuntimeResponse,
} from './types'
import type { RoomState } from './schema'

/**
 * 将 base64 字符串解码为 Uint8Array。
 *
 * @param base64 base64 字符串
 * @returns 二进制字节数组
 */
function decodeBase64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Colyseus 连接封装：负责创建客户端、加入单房间、发送输入消息。
 *
 * 设计目标：
 * - 让引擎层（MyGame）只面对“连接/断开/发输入”这三个动作
 * - 房间类型固定为 "game"（单房间模式）
 */
export class GameConnection {
  /**
   * Colyseus SDK 客户端实例。
   */
  private readonly client = new Client(gameServerUrl)
  /**
   * 当前加入的房间引用（只允许单房间）。
   */
  private roomInternal: Room<RoomState> | undefined

  /**
   * 获取当前房间对象。
   *
   * @returns 已加入的房间；未连接时为 undefined
   */
  get room() {
    return this.roomInternal
  }

  /**
   * 连接服务器并加入房间。
   *
   * 说明：
   * - 多次调用会复用同一个 room（避免重复 join）
   *
   * @returns 成功加入后的房间对象
   */
  async connect(): Promise<Room<RoomState>> {
    if (this.roomInternal) return this.roomInternal
    const room = await this.client.joinOrCreate<RoomState>('game')
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
   * - blocked 使用 base64 编码传输，客户端解码为 Uint8Array
   *
   * @returns 地图运行时数据
   */
  async fetchMapRuntime(): Promise<MapRuntime> {
    const resp = await fetch(`${gameServerHttpBaseUrl}/maps/runtime`)
    if (!resp.ok) throw new Error(`fetch map runtime failed: ${resp.status}`)
    const json = (await resp.json()) as MapRuntimeResponse
    return {
      id: json.id,
      name: json.name,
      grid: json.grid,
      blocked: decodeBase64ToUint8Array(json.blockedBase64),
      spawns: json.spawns,
      zones: json.zones,
    }
  }

  /**
   * 拉取服务端当前帧的碰撞调试快照（用于可视化真实碰撞体）。
   *
   * @returns 碰撞调试快照
   */
  async fetchCollisionDebugSnapshot(): Promise<CollisionDebugSnapshot> {
    const resp = await fetch(`${gameServerHttpBaseUrl}/debug/colliders`)
    if (!resp.ok) throw new Error(`fetch collision debug snapshot failed: ${resp.status}`)
    return (await resp.json()) as CollisionDebugSnapshot
  }
}
