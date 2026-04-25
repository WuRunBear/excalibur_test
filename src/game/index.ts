import { Engine } from 'excalibur'
import { config } from './config'
import { sceneList } from './scenes'
import { loader } from './resources'

export class MyGame extends Engine {
  constructor(canvasElement: HTMLCanvasElement) {
    super({
      width: config.width,
      height: config.height,
      canvasElement: canvasElement,
      backgroundColor: config.backgroundColor,
      displayMode: config.displayMode,
    })
  }

  // 利用 Excalibur 提供的初始化钩子
  async startAndLoad() {
    // 1. 注册场景
    for (const [name, scene] of Object.entries(sceneList)) {
      this.add(name, scene)
    }

    // 2. 启动引擎并加载资源
    await super.start(loader)
  }

  // 可以在这里封装一些全局方法
  public pauseGame() {
    this.stop()
  }
}

let game: MyGame

export async function initGame(gameCanvas: HTMLCanvasElement) {
  game = new MyGame(gameCanvas)
  await game.startAndLoad()
  await game.goToScene('main')
}
