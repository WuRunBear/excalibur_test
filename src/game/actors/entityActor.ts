import { Actor, Color } from 'excalibur'

type CircleEntityActorOptions = {
  entityId: number
  x: number
  y: number
  color: Color
  shape: 0
  radius: number
}

type BoxEntityActorOptions = {
  entityId: number
  x: number
  y: number
  color: Color
  shape: 1
  w: number
  h: number
}

type EntityActorOptions = CircleEntityActorOptions | BoxEntityActorOptions

/**
 * 网络实体 Actor（纯渲染）。
 *
 * 说明：
 * - 该 Actor 不读取输入、不进行本地权威移动
 * - 位置由外部同步层（ActorManager）每帧写入
 * - entityId 用于把渲染对象稳定绑定到服务端的 NetworkId
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
   * @param options.entityId 实体网络 id
   * @param options.x 初始坐标 x
   * @param options.y 初始坐标 y
   * @param options.color 渲染颜色（用于区分本地玩家/远端实体）
   */
  constructor(options: EntityActorOptions) {
    super(
      options.shape === 0
        ? {
            x: options.x,
            y: options.y,
            radius: options.radius,
            color: options.color,
          }
        : {
            x: options.x,
            y: options.y,
            width: options.w,
            height: options.h,
            color: options.color,
          },
    )
    this.entityId = options.entityId
    this.shape = options.shape
    this.radiusValue = options.shape === 0 ? options.radius : 0
    this.widthValue = options.shape === 1 ? options.w : 0
    this.heightValue = options.shape === 1 ? options.h : 0
  }

  /**
   * 判断当前 Actor 的渲染形状是否仍与最新快照一致。
   *
   * @param shape 最新形状
   * @param radius 最新圆形半径
   * @param w 最新宽度
   * @param h 最新高度
   * @returns 一致时返回 true，否则返回 false
   */
  matchesRender(shape: 0 | 1, radius: number, w: number, h: number) {
    if (this.shape !== shape) return false
    if (shape === 0) return this.radiusValue === radius
    return this.widthValue === w && this.heightValue === h
  }
}
