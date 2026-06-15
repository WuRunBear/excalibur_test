/**
 * 客户端输入消息（上行到服务端）。
 *
 * 对应服务端 GameRoom 的 onMessage("input")：
 * - seq 用于丢弃重复/乱序输入
 * - moveX/moveY 为速度分量（像素/秒），会写入服务端 ECS 的 Velocity.vx/vy
 */
export interface InputPayload {
  seq: number
  moveX: number
  moveY: number
}

export interface MapRuntimeGrid {
  width: number
  height: number
  tileWidth: number
  tileHeight: number
}

export interface MapRuntimeVec2 {
  x: number
  y: number
}

export interface MapRuntimeZone {
  id: number
  name: string
  polygon: MapRuntimeVec2[]
}

export interface MapRuntimeSpawns {
  player: MapRuntimeVec2 | null
  npcs: Array<{ kind: string; pos: MapRuntimeVec2; zoneId?: number }>
}

export interface MapRuntimeResponse {
  id: string
  name: string
  grid: MapRuntimeGrid
  blockedBase64: string
  spawns: MapRuntimeSpawns
  zones: MapRuntimeZone[]
}

export interface MapRuntime {
  id: string
  name: string
  grid: MapRuntimeGrid
  blocked: Uint8Array
  spawns: MapRuntimeSpawns
  zones: MapRuntimeZone[]
}

export type CollisionDebugMapBody = {
  kind: 'map'
  shape: 'box'
  x: number
  y: number
  width: number
  height: number
}

export type CollisionDebugEntityBody =
  | { kind: 'entity'; shape: 'circle'; eid: number; x: number; y: number; r: number }
  | {
      kind: 'entity'
      shape: 'box'
      eid: number
      x: number
      y: number
      width: number
      height: number
    }

export type CollisionDebugBody = CollisionDebugMapBody | CollisionDebugEntityBody

export interface CollisionDebugPair {
  id: string
  a: string
  b: string
  overlap: number
}

export interface CollisionDebugSnapshot {
  tick: number
  mapBodies?: CollisionDebugMapBody[]
  entityBodies: CollisionDebugEntityBody[]
  pairs: CollisionDebugPair[]
}

/**
 * 网络连接状态。
 *
 * - idle：未开始连接
 * - connecting：连接中
 * - connected：已加入房间（可收发消息）
 * - disconnected：断开连接/连接失败
 */
export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected'
