/**
 * 客户端输入消息（上行到服务端）。
 *
 * 对应服务端 GameRoom 的 onMessage("input")：
 * - seq 用于丢弃重复/乱序输入
 * - moveX/moveY 为速度分量（像素/秒），会写入服务端 ECS 的 Velocity.vx/vy
 * - interact/attack/talk 为边沿信号：仅在按下那一帧置 true
 */
export interface InputPayload {
  seq: number
  moveX: number
  moveY: number
  interact?: boolean
  attack?: boolean
  talk?: boolean
}

/**
 * 离散命令负载（上行到服务端 "command" 通道，与协议 §2.2 严格一致）。
 *
 * 说明：
 * - 所有命令失败均无回执（服务端零副作用），客户端以状态变化为准
 * - 命令不进入 seq 去重，重复发送会被多次执行
 */
export type CommandPayload =
  | { type: 'consume'; slot: number }
  | { type: 'drop'; slot: number }
  | { type: 'transfer'; slot: number; toSlot: number }
  | { type: 'craft'; recipe: string }
  | { type: 'equip'; slot: number }
  | { type: 'place'; slot: number; x: number; y: number }
  | { type: 'deconstruct'; target: number }
  | { type: 'dialogue'; option: number }

/**
 * 物品 kind 清单（协议 §4.1，仅 UI 展示/分类用，服务端才是权威）。
 */
export const ITEM_KINDS = [
  'wood',
  'stone',
  'berry',
  'raw_meat',
  'cooked_meat',
  'berry_pie',
  'water',
  'axe',
  'stone_axe',
  'spear',
  'campfire_kit',
  'wall_kit',
  'floor_kit',
  'door_kit',
  'fence_kit',
  'furniture_kit',
] as const

export type ItemKind = (typeof ITEM_KINDS)[number]

/** 物品分类：食物（consume）/ 工具（equip）/ 建造 kit（place）。 */
export type ItemCategory = 'food' | 'tool' | 'kit'

const FOOD_KINDS = new Set<ItemKind>(['berry', 'raw_meat', 'cooked_meat', 'berry_pie', 'water'])
const TOOL_KINDS = new Set<ItemKind>(['axe', 'stone_axe', 'spear'])
const KIT_KINDS = new Set<ItemKind>([
  'campfire_kit',
  'wall_kit',
  'floor_kit',
  'door_kit',
  'fence_kit',
  'furniture_kit',
])

/** 物品中文名（UI 展示用）。 */
export const ITEM_NAMES: Record<string, string> = {
  wood: '木材',
  stone: '石头',
  berry: '浆果',
  raw_meat: '生肉',
  cooked_meat: '熟肉',
  berry_pie: '浆果派',
  water: '水',
  axe: '斧头',
  stone_axe: '石斧',
  spear: '长矛',
  campfire_kit: '火堆套件',
  wall_kit: '墙壁套件',
  floor_kit: '地板套件',
  door_kit: '门套件',
  fence_kit: '围栏套件',
  furniture_kit: '家具套件',
}

/** 物品 emoji 图标（临时视觉，无美术资源）。 */
export const ITEM_ICONS: Record<string, string> = {
  wood: '🪵',
  stone: '🪨',
  berry: '🫐',
  raw_meat: '🍖',
  cooked_meat: '🍗',
  berry_pie: '🥧',
  water: '💧',
  axe: '🪓',
  stone_axe: '⛏️',
  spear: '🔱',
  campfire_kit: '🔥',
  wall_kit: '🧱',
  floor_kit: '⬜',
  door_kit: '🚪',
  fence_kit: '🚧',
  furniture_kit: '🪑',
}

/** 根据 kind 判断物品分类（useItem 路由 consume/equip 用）。 */
export function getItemCategory(kind: string): ItemCategory | undefined {
  if (FOOD_KINDS.has(kind as ItemKind)) return 'food'
  if (TOOL_KINDS.has(kind as ItemKind)) return 'tool'
  if (KIT_KINDS.has(kind as ItemKind)) return 'kit'
  return undefined
}

/**
 * 合成配方清单（协议 §4.4，UI 展示用）。
 * - stationType：0=手搓，1=火堆旁
 */
export interface RecipeInfo {
  id: string
  name: string
  costs: Array<{ kind: string; count: number }>
  produces: { kind: string; count: number }
  stationType: 0 | 1
}

export const RECIPES: RecipeInfo[] = [
  {
    id: 'wood_axe',
    name: '斧头',
    costs: [{ kind: 'wood', count: 2 }],
    produces: { kind: 'axe', count: 1 },
    stationType: 0,
  },
  {
    id: 'stone_axe',
    name: '石斧',
    costs: [
      { kind: 'wood', count: 1 },
      { kind: 'stone', count: 1 },
    ],
    produces: { kind: 'stone_axe', count: 1 },
    stationType: 0,
  },
  {
    id: 'spear',
    name: '长矛',
    costs: [
      { kind: 'wood', count: 2 },
      { kind: 'stone', count: 1 },
    ],
    produces: { kind: 'spear', count: 1 },
    stationType: 0,
  },
  {
    id: 'berry_pie',
    name: '浆果派',
    costs: [{ kind: 'berry', count: 3 }],
    produces: { kind: 'berry_pie', count: 1 },
    stationType: 0,
  },
  {
    id: 'cooked_meat',
    name: '熟肉',
    costs: [{ kind: 'raw_meat', count: 1 }],
    produces: { kind: 'cooked_meat', count: 1 },
    stationType: 1,
  },
  {
    id: 'campfire_kit',
    name: '火堆套件',
    costs: [
      { kind: 'wood', count: 3 },
      { kind: 'stone', count: 2 },
    ],
    produces: { kind: 'campfire_kit', count: 1 },
    stationType: 0,
  },
  {
    id: 'wall_kit',
    name: '墙壁套件',
    costs: [
      { kind: 'wood', count: 2 },
      { kind: 'stone', count: 1 },
    ],
    produces: { kind: 'wall_kit', count: 1 },
    stationType: 0,
  },
  {
    id: 'floor_kit',
    name: '地板套件',
    costs: [{ kind: 'wood', count: 1 }],
    produces: { kind: 'floor_kit', count: 1 },
    stationType: 0,
  },
  {
    id: 'door_kit',
    name: '门套件',
    costs: [
      { kind: 'wood', count: 2 },
      { kind: 'stone', count: 1 },
    ],
    produces: { kind: 'door_kit', count: 1 },
    stationType: 0,
  },
  {
    id: 'fence_kit',
    name: '围栏套件',
    costs: [{ kind: 'wood', count: 2 }],
    produces: { kind: 'fence_kit', count: 1 },
    stationType: 0,
  },
  {
    id: 'furniture_kit',
    name: '家具套件',
    costs: [
      { kind: 'wood', count: 2 },
      { kind: 'stone', count: 2 },
    ],
    produces: { kind: 'furniture_kit', count: 1 },
    stationType: 0,
  },
]

/**
 * 服务端关键数值常量（协议 §4，客户端仅 UI 提示参考，服务端才是权威）。
 */
export const SERVER_CONSTANTS = {
  speedLimit: 200,
  interactRadius: 24,
  attackRadius: 32,
  talkRadius: 48,
  placeDistance: 64,
  viewRadius: 300,
} as const

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
