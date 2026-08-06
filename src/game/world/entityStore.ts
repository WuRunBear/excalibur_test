import type { EntityState, RoomState } from 'game/net/schema'

/**
 * 实体形状类型。
 *
 * 约定（协议 §3.5 Collider.shape）：
 * - 0 表示圆形
 * - 1 表示矩形
 */
export type EntityShape = 0 | 1

/**
 * 实体种类（按协议 §3.6 的 key 组合辨识）。
 */
export type EntityKind =
  | 'player'
  | 'enemy'
  | 'npc'
  | 'resource'
  | 'item'
  | 'campfire'
  | 'portal'
  | 'building'
  | 'unknown'

export interface NeedsSlot {
  name: string
  current: number
  max: number
}

export interface InventorySlot {
  kind: string
  count: number
}

export interface QuestEntry {
  questId: string
  state: number
  count: number
}

export interface DialogueState {
  npcId: number
  treeId: string
  nodeId: string
  options: string[]
}

/**
 * 实体的玩法快照（渲染 + UI 双用）。
 *
 * 说明：
 * - 所有字段都可能缺失（key 会被服务端删除），读取方必须容忍 undefined
 * - id 是服务端 NetworkId（稳定）
 */
export interface EntitySnapshot {
  id: number
  kind: EntityKind
  x: number
  y: number
  hp: number
  shape: EntityShape
  radius: number
  w: number
  h: number
  needs: NeedsSlot[]
  inventory: InventorySlot[]
  itemKind?: string
  itemCount?: number
  resourceRemaining?: number
  equipment?: { weaponSlot: number; toolSlot: number; armorSlot: number }
  stationType?: number
  light?: { radius: number; fuelRemainingMs: number }
  portal?: { targetMap: string; x: number; y: number }
  placeable?: { footprintW: number; footprintH: number; canCollide: number }
  dialogueSource?: string
  quests?: QuestEntry[]
  dialogue?: DialogueState
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

/** 背包容量（协议 §4.1：固定 12 槽）。 */
const INVENTORY_SLOTS = 12

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
   * @param sessionId 当前客户端 sessionId（用于取自己的 visibleEntities）
   * @param nowMs 本地当前时间（毫秒）
   */
  updateFromRoomState(state: RoomState, sessionId: string, nowMs: number) {
    const nextTick = state.tick

    if (this.currentTick === 0) {
      this.currentTick = nextTick
      this.lastTick = nextTick
      this.currentReceivedAtMs = nowMs
      this.lastReceivedAtMs = nowMs
      this.current = this.readEntities(state, sessionId)
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
    this.current = this.readEntities(state, sessionId)
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
        ...curr,
        x: lerp(prev.x, curr.x, t),
        y: lerp(prev.y, curr.y, t),
      })
    }

    return result
  }

  /**
   * 判断一张实体表是否可解码（含至少一个带有效 id 的条目）。
   *
   * 说明：
   * - 服务端兴趣裁剪（@view() 字段）在部分 colyseus 版本存在解码缺陷，
   *   可见表条目可能只剩空壳（id undefined）——此时必须回退到全量表。
   * - 服务端修复后（@colyseus/core >= 0.17.44，colyseus#935/#936），
   *   该表可解码，此处自动切回兴趣裁剪路径。
   *
   * @param map 候选实体表
   * @returns 可解码时返回 true
   */
  private static isDecodable(map: MapSchemaLike<EntityState>) {
    if (map.size === 0) return false
    let decodable = false
    map.forEach((entity) => {
      if (typeof entity.id === 'number') decodable = true
    })
    return decodable
  }

  /**
   * 把 RoomState 转换为可渲染快照表。
   *
   * 实体来源（协议 §3.2 兼容逻辑）：
   * - 自己的 visibleEntities 可解码时优先（兴趣裁剪）
   * - 否则回退 state.entities 全量广播（兼容旧部署）
   *
   * @param state 房间状态
   * @param sessionId 当前客户端 sessionId
   * @returns 实体快照表（key=entityId）
   */
  private readEntities(state: RoomState, sessionId: string) {
    const mine = state.players.get(sessionId)
    const visible = mine?.visibleEntities
    const entityMap =
      visible && visible.size > 0 && EntityStore.isDecodable(visible) ? visible : state.entities

    const map = new Map<number, EntitySnapshot>()

    entityMap.forEach((entity) => {
      const snapshot = this.parseEntity(entity)
      map.set(entity.id, snapshot)
    })

    return map
  }

  /**
   * 把单个 EntityState（键值表）解析为玩法快照。
   *
   * 解析规则（协议 §3.5）：
   * - 数值 key 用 entity.values.get(key)；字符串 key 用 entity.stringValues.get(key)
   * - key 消失 = undefined：所有读取容忍 undefined（?? 默认值）
   *
   * @param entity 服务端实体状态
   * @returns 玩法快照
   */
  private parseEntity(entity: EntityState): EntitySnapshot {
    const get = (key: string) => entity.values.get(key)
    const getStr = (key: string) => entity.stringValues.get(key)

    const needs: NeedsSlot[] = []
    const maxNeeds = 4
    for (let i = 0; i < maxNeeds; i++) {
      const name = getStr(`Needs.${i}.name`)
      if (name === undefined && get(`Needs.${i}.current`) === undefined) break
      needs.push({
        name: name ?? '',
        current: get(`Needs.${i}.current`) ?? 0,
        max: get(`Needs.${i}.max`) ?? 100,
      })
    }

    const inventory: InventorySlot[] = []
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      inventory.push({
        kind: getStr(`Inventory.${i}.kind`) ?? '',
        count: get(`Inventory.${i}.count`) ?? 0,
      })
    }

    const quests: QuestEntry[] = []
    const maxQuests = 8
    for (let i = 0; i < maxQuests; i++) {
      const questId = getStr(`Quest.${i}.questId`)
      if (questId === undefined) break
      quests.push({
        questId,
        state: get(`Quest.${i}.state`) ?? 0,
        count: get(`Quest.${i}.count`) ?? 0,
      })
    }

    const dialogueTree = getStr('Dialogue.treeId')
    const dialogue: DialogueState | undefined =
      dialogueTree !== undefined || get('Dialogue.npcId') !== undefined
        ? {
            npcId: get('Dialogue.npcId') ?? 0,
            treeId: getStr('Dialogue.treeId') ?? '',
            nodeId: getStr('Dialogue.nodeId') ?? '',
            options: this.readDialogueOptions(entity),
          }
        : undefined

    const equipment =
      get('Equipment.weaponSlot') !== undefined ||
      get('Equipment.toolSlot') !== undefined ||
      get('Equipment.armorSlot') !== undefined
        ? {
            weaponSlot: get('Equipment.weaponSlot') ?? -1,
            toolSlot: get('Equipment.toolSlot') ?? -1,
            armorSlot: get('Equipment.armorSlot') ?? -1,
          }
        : undefined

    const light =
      get('LightSource.radius') !== undefined || get('LightSource.fuelRemainingMs') !== undefined
        ? {
            radius: get('LightSource.radius') ?? 0,
            fuelRemainingMs: get('LightSource.fuelRemainingMs') ?? 0,
          }
        : undefined

    const portal =
      getStr('Portal.targetMap') !== undefined
        ? {
            targetMap: getStr('Portal.targetMap') ?? '',
            x: get('Portal.x') ?? 0,
            y: get('Portal.y') ?? 0,
          }
        : undefined

    const placeable =
      get('Placeable.footprintW') !== undefined || get('Placeable.footprintH') !== undefined
        ? {
            footprintW: get('Placeable.footprintW') ?? 0,
            footprintH: get('Placeable.footprintH') ?? 0,
            canCollide: get('Placeable.canCollide') ?? 0,
          }
        : undefined

    const hasHealth = get('Health.current') !== undefined

    const snapshot: EntitySnapshot = {
      id: entity.id,
      kind: 'unknown',
      x: get('Transform.x') ?? 0,
      y: get('Transform.y') ?? 0,
      hp: get('Health.current') ?? 0,
      shape: (get('Collider.shape') ?? 0) as EntityShape,
      radius: get('Collider.radius') ?? 0,
      w: get('Size.w') ?? 0,
      h: get('Size.h') ?? 0,
      needs,
      inventory,
      itemKind: getStr('ItemMeta.kind'),
      itemCount: get('ItemMeta.count'),
      resourceRemaining: get('ResourceNode.remaining'),
      equipment,
      stationType: get('CraftingStation.stationType'),
      light,
      portal,
      placeable,
      dialogueSource: getStr('DialogueSource.treeId'),
      quests: quests.length > 0 ? quests : undefined,
      dialogue,
    }

    snapshot.kind = this.identifyKind(snapshot, hasHealth)
    return snapshot
  }

  /**
   * 读取对话选项文本数组（Dialogue.{i}.option）。
   *
   * @param entity 服务端实体状态
   * @returns 选项文本数组（无选项时为空数组）
   */
  private readDialogueOptions(entity: EntityState): string[] {
    const options: string[] = []
    const maxOptions = 8
    for (let i = 0; i < maxOptions; i++) {
      const option = entity.stringValues.get(`Dialogue.${i}.option`)
      if (option === undefined) break
      options.push(option)
    }
    return options
  }

  /**
   * 实体种类辨识（协议 §3.6，顺序即优先级，首个命中即返回）。
   *
   * @param snapshot 已解析的快照
   * @param hasHealth 是否存在 Health.current key（区分 hp=0 与键缺失）
   * @returns 辨识出的种类
   */
  private identifyKind(snapshot: EntitySnapshot, hasHealth: boolean): EntityKind {
    if (snapshot.resourceRemaining !== undefined) return 'resource'
    if (snapshot.itemKind !== undefined) return 'item'
    if (snapshot.dialogueSource !== undefined) return 'npc'
    if (snapshot.stationType !== undefined && snapshot.light !== undefined) return 'campfire'
    if (snapshot.portal !== undefined) return 'portal'
    if (snapshot.placeable !== undefined) return 'building'
    if (hasHealth && snapshot.needs.length > 0) return 'player'
    if (hasHealth) return 'enemy'
    return 'unknown'
  }
}

/** MapSchema 的最小可读接口（避免依赖具体实现类型）。 */
type MapSchemaLike<T> = {
  size: number
  forEach(callback: (value: T, key: string) => void): void
}
