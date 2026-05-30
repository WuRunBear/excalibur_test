import { Actor, Color } from 'excalibur'

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
   * @param options.entityId 实体网络 id
   * @param options.x 初始坐标 x
   * @param options.y 初始坐标 y
   * @param options.color 渲染颜色（用于区分本地玩家/远端实体）
   */
  constructor(options: { entityId: number; x: number; y: number; color: Color }) {
    super({
      x: options.x,
      y: options.y,
      radius: 16,
      color: options.color,
    })
    this.entityId = options.entityId
  }
}
