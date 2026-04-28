import { Scene, Engine } from 'excalibur'
import { Player } from 'game/actors/player'
import type { GameHost } from 'game/type'

/**
 * 主场景：创建玩家等核心 Actor，并把运行时快照通过 GameHost 回调上报给游戏引擎层。
 */
export class Main extends Scene {
  /**
   * 场景初始化钩子（Excalibur 生命周期）。
   *
   * @param engine 运行该场景的引擎实例；这里按 GameHost 约定读取可选回调
   */
  override onInitialize(engine: Engine<any>): void {
    const host = engine as unknown as Partial<GameHost>
    const player = new Player({
      reportSnapshot(snapshot) {
        host.onPlayerSnapshot?.(snapshot)
      },
    })
    this.add(player)
  }
}

/**
 * 预创建的主场景实例（保持单例，便于 sceneList 注册）。
 */
export const main = new Main()
