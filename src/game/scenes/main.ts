import { Scene, type Engine } from 'excalibur'

import { Player } from 'game/actors/player'
import type { PlayerSnapshot } from 'game/type'

/**
 * 主场景。
 *
 * 说明：
 * - 场景内保留本地玩家 Actor，用于本地渲染与移动
 * - 每帧通过 engine.onNetworkFrame(...) 回调，把联机通信驱动交给 MyGame
 */
export class Main extends Scene {
  /**
   * 场景初始化钩子（Excalibur 生命周期）。
   *
   * @param engine 运行该场景的引擎实例
   */
  override onInitialize(engine: Engine<any>): void {
    const player = new Player({
      reportSnapshot: (snapshot: PlayerSnapshot) => {
        ;(engine as unknown as { onPlayerSnapshot?: (next: PlayerSnapshot) => void }).onPlayerSnapshot?.(
          snapshot,
        )
      },
    })
    this.add(player)
  }

  /**
   * 场景每帧更新（Excalibur 生命周期）。
   *
   * 说明：
   * - 这里把联机通信驱动委托给引擎实例（MyGame）提供的回调
   * - 通过“弱约定”字段 onNetworkFrame 避免场景反向依赖 MyGame 的具体类型
   *
   * @param engine 引擎实例
   * @param delta 距离上一帧的时间（毫秒）
   */
  public override update(engine: Engine, delta: number) {
    super.update(engine, delta)
    const handler = (
      engine as unknown as { onNetworkFrame?: (scene: Scene, deltaMs: number) => void }
    ).onNetworkFrame
    handler?.call(engine, this, delta)
  }
}

/**
 * 预创建的主场景实例（保持单例，便于 sceneList 注册）。
 */
export const main = new Main()
