import { Scene, type Engine } from 'excalibur'

let logAccum = 0

/**
 * 主场景。
 *
 * 说明：
 * - 场景只负责承载地图、服务端实体与调试对象
 * - 每帧通过 engine.onNetworkFrame(...) 回调，把联机通信与渲染驱动交给 MyGame
 */
export class Main extends Scene {
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

    logAccum += delta
    if (logAccum >= 1000) {
      logAccum = 0
      console.log(
        `[camera] pos=(${this.camera.pos.x.toFixed(1)}, ${this.camera.pos.y.toFixed(1)}) zoom=${this.camera.zoom.toFixed(2)}`,
      )
    }
  }
}

/**
 * 预创建的主场景实例（保持单例，便于 sceneList 注册）。
 */
export const main = new Main()
