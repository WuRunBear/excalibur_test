import { Scene, type Engine } from 'excalibur'

/**
 * 主场景（网络驱动版）。
 *
 * 说明：
 * - 该场景本身不创建“本地权威玩家 Actor”
 * - 每帧通过 engine.onNetworkFrame(...) 回调，把同步/渲染驱动交给 MyGame
 * - 这样可以保持 UI 层与游戏域解耦，同时让网络同步逻辑集中在 MyGame 内
 */
export class Main extends Scene {
  /**
   * 场景初始化钩子（Excalibur 生命周期）。
   *
   * @param engine 运行该场景的引擎实例
   */
  override onInitialize(_engine: Engine<any>): void {}

  /**
   * 场景每帧更新（Excalibur 生命周期）。
   *
   * 说明：
   * - 这里把渲染驱动委托给引擎实例（MyGame）提供的回调
   * - 通过“弱约定”字段 onNetworkFrame 避免场景反向依赖 MyGame 的具体类型
   *
   * @param engine 引擎实例
   * @param delta 距离上一帧的时间（毫秒）
   */
  public override update(engine: Engine, delta: number) {
    const handler = (
      engine as unknown as { onNetworkFrame?: (scene: Scene, deltaMs: number) => void }
    ).onNetworkFrame
    handler?.call(engine, this, delta)
    super.update(engine, delta)
  }
}

/**
 * 预创建的主场景实例（保持单例，便于 sceneList 注册）。
 */
export const main = new Main()
