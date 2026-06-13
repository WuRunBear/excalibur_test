import { Actor, Color, Engine, Keys } from 'excalibur'

import type { Facing, PlayerSnapshot } from 'game/type'

/**
 * 玩家 Actor：处理键盘输入与位移，并按帧上报可序列化的玩家快照。
 *
 * 注意：
 * - 该 Actor 负责本地渲染与本地移动
 * - 可通过 reportSnapshot 把当前位置同步给 UI 或宿主层
 */
export class Player extends Actor {
  /**
   * 移动速度（像素/秒）。
   */
  speed = 200
  private reportSnapshot?: (snapshot: PlayerSnapshot) => void
  private facing: Facing = '下'

  /**
   * @param options.reportSnapshot 可选：每帧上报玩家快照（用于 UI 同步、调试等）
   */
  constructor(options?: { reportSnapshot?: (snapshot: PlayerSnapshot) => void }) {
    super({
      x: 50,
      y: 50,
      radius: 20,
      color: Color.Cyan,
    })
    this.reportSnapshot = options?.reportSnapshot
  }

  /**
   * Actor 每帧更新（Excalibur 生命周期）。
   *
   * @param engine 引擎实例，用于读取输入
   * @param delta 距离上一帧的时间（毫秒）
   */
  public override update(engine: Engine, delta: number) {
    if (engine.input.keyboard.isHeld(Keys.W)) {
      this.pos.y -= this.speed * (delta / 1000)
      this.facing = '上'
    }
    if (engine.input.keyboard.isHeld(Keys.S)) {
      this.pos.y += this.speed * (delta / 1000)
      this.facing = '下'
    }
    if (engine.input.keyboard.isHeld(Keys.D)) {
      this.pos.x += this.speed * (delta / 1000)
      this.facing = '右'
    }
    if (engine.input.keyboard.isHeld(Keys.A)) {
      this.pos.x -= this.speed * (delta / 1000)
      this.facing = '左'
    }

    if (this.reportSnapshot) {
      const snapshot: PlayerSnapshot = {
        x: this.pos.x,
        y: this.pos.y,
        facing: this.facing,
        deltaMs: delta,
      }
      this.reportSnapshot(snapshot)
    }
  }
}
