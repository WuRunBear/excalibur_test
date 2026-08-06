import {
  Actor,
  Circle,
  Color,
  Font,
  GraphicsGroup,
  Rectangle,
  Text,
  vec,
  type GraphicsGrouping,
} from 'excalibur'

import { ITEM_ICONS } from 'game/net/types'

import type { EntityKind } from 'game/world/entityStore'

/**
 * 各实体种类的渲染配色（纯色临时视觉，无美术资源）。
 */
export const KIND_COLORS: Record<EntityKind, Color> = {
  player: Color.Cyan,
  enemy: Color.Red,
  npc: Color.Green,
  resource: Color.fromHex('#8b5a2b'),
  item: Color.Yellow,
  campfire: Color.Orange,
  portal: Color.Violet,
  building: Color.Gray,
  unknown: Color.LightGray,
}

/**
 * 各实体种类的标签文本（叠加在形状上的短标记）。
 */
const KIND_LABELS: Record<EntityKind, string> = {
  player: '你',
  enemy: '敌',
  npc: '👤',
  resource: '',
  item: '',
  campfire: '🔥',
  portal: '门',
  building: '',
  unknown: '?',
}

type CircleEntityActorOptions = {
  entityId: number
  x: number
  y: number
  color: Color
  shape: 0
  radius: number
  kind: EntityKind
  label?: string
}

type BoxEntityActorOptions = {
  entityId: number
  x: number
  y: number
  color: Color
  shape: 1
  w: number
  h: number
  kind: EntityKind
  label?: string
}

type EntityActorOptions = CircleEntityActorOptions | BoxEntityActorOptions

/**
 * 网络实体 Actor（纯渲染）。
 *
 * 说明：
 * - 该 Actor 不读取输入、不进行本地权威移动
 * - 位置由外部同步层（ActorManager）每帧写入
 * - entityId 用于把渲染对象稳定绑定到服务端的 NetworkId
 * - 按实体种类（kind）选择颜色/形状/标签
 */
export class EntityActor extends Actor {
  /**
   * 实体网络 id（来自服务端 EntityState.id）。
   */
  readonly entityId: number

  /**
   * 当前渲染使用的形状类型。
   */
  readonly shape: 0 | 1

  /**
   * 当前渲染使用的圆形半径。
   */
  readonly radiusValue: number

  /**
   * 当前渲染使用的宽度。
   */
  readonly widthValue: number

  /**
   * 当前渲染使用的高度。
   */
  readonly heightValue: number

  /**
   * 当前渲染使用的实体种类。
   */
  readonly kind: EntityKind

  /**
   * @param options.entityId 实体网络 id
   * @param options.x 初始坐标 x
   * @param options.y 初始坐标 y
   * @param options.color 渲染颜色
   * @param options.kind 实体种类
   */
  constructor(options: EntityActorOptions) {
    super({ x: options.x, y: options.y })
    this.entityId = options.entityId
    this.shape = options.shape
    this.radiusValue = options.shape === 0 ? options.radius : 0
    this.widthValue = options.shape === 1 ? options.w : 0
    this.heightValue = options.shape === 1 ? options.h : 0
    this.kind = options.kind
    this.applyVisual(options.kind, options.label, options.color)
  }

  /**
   * 根据种类应用图形：形状（圆形/矩形）+ 居中标签文本（Text/emoji 临时视觉）。
   *
   * 说明：
   * - 形状图形提供底色与可见性（同时决定组的包围盒，避免离屏裁剪误判）
   * - 标签文本叠加在形状上方，useBounds=false 以免影响组居中
   *
   * @param kind 实体种类
   * @param label 自定义标签（如物品 emoji）
   * @param color 形状颜色
   */
  private applyVisual(kind: EntityKind, label: string | undefined, color: Color) {
    const shapeGraphic =
      this.shape === 0
        ? new Circle({ radius: Math.max(1, this.radiusValue), color })
        : new Rectangle({
            width: Math.max(1, this.widthValue),
            height: Math.max(1, this.heightValue),
            color,
          })

    const members: GraphicsGrouping[] = [{ graphic: shapeGraphic, offset: vec(0, 0) }]

    const text = label ?? KIND_LABELS[kind]
    if (text) {
      const size =
        this.shape === 1 ? Math.max(this.widthValue, this.heightValue) : this.radiusValue * 2
      const fontSize = Math.max(8, Math.min(14, size * 0.6))

      members.push({
        graphic: new Text({
          text,
          color: Color.White,
          font: new Font({ size: fontSize, family: 'monospace' }),
        }),
        offset: vec(0, 0),
        useBounds: false,
      })
    }

    this.graphics.use(new GraphicsGroup({ members }))
  }

  /**
   * 判断当前 Actor 的渲染形态是否仍与最新快照一致。
   *
   * 说明：
   * - kind/shape/尺寸任一变化才需要重建 Actor
   * - 只变化 hp/数量等数值时不重建（避免闪烁）
   *
   * @param kind 最新种类
   * @param shape 最新形状
   * @param radius 最新圆形半径
   * @param w 最新宽度
   * @param h 最新高度
   * @returns 一致时返回 true，否则返回 false
   */
  matchesRender(kind: EntityKind, shape: 0 | 1, radius: number, w: number, h: number) {
    if (this.kind !== kind) return false
    if (this.shape !== shape) return false
    if (shape === 0) return this.radiusValue === radius
    return this.widthValue === w && this.heightValue === h
  }
}

/** item 种类的 emoji 图标（按 ItemMeta.kind 映射，B2 与 UI 共用）。 */
export function itemIcon(kind: string | undefined): string {
  return kind ? (ITEM_ICONS[kind] ?? '📦') : '📦'
}
