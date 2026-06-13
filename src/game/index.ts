import { Engine, Keys } from 'excalibur'
import { createGameBridge } from './bridge'
import { config } from './config'
import { sceneList } from './scenes'
import { loader } from './resources'

import type { Facing, GameCommand, GameController, GameUIState, PlayerSnapshot } from './type'

import { GameConnection } from './net/connection'
import type { ConnectionStatus, InputPayload } from './net/types'

/**
 * Excalibur 游戏引擎实现：
 * - 维护游戏内部状态（GameUIState）
 * - 通过 bridge 向 UI 推送状态/消息，接收 UI 指令
 *
 * 当前模式约定：
 * - 场景仍使用本地 Actor 渲染
 * - 保留联机通信能力：连接服务端并上行输入
 * - 不接入服务端下行状态的渲染逻辑
 */
export class MyGame extends Engine {
  private readonly bridgeInternal: ReturnType<typeof createGameBridge>
  private state: GameUIState
  private emitCooldownMs = 0
  private connectionStatus: ConnectionStatus = 'idle'

  private readonly connection = new GameConnection()

  private inputSeq = 0
  private inputCooldownMs = 0
  private facing: Facing = '下'

  /**
   * @param canvasElement 承载 Excalibur 渲染的 canvas
   */
  constructor(canvasElement: HTMLCanvasElement) {
    super({
      width: config.width,
      height: config.height,
      canvasElement: canvasElement,
      backgroundColor: config.backgroundColor,
      displayMode: config.displayMode,
    })

    this.state = this.createInitialState()

    this.bridgeInternal = createGameBridge({
      initialState: this.state,
      onCommand: (command) => this.onCommand(command),
    })
  }

  /**
   * 启动引擎并预加载资源。
   *
   * @returns 资源加载完成后 resolve
   */
  async startAndLoad() {
    // 1. 注册场景
    for (const [name, scene] of Object.entries(sceneList)) {
      this.add(name, scene)
    }

    // 2. 启动引擎并加载资源
    await super.start(loader)

    await this.connectToServer()
  }

  /**
   * 提供给 UI 的桥接对象（只包含 getState/subscribe/dispatch）。
   */
  get bridge() {
    return this.bridgeInternal.bridge
  }

  /**
   * 销毁游戏实例：停止引擎循环，并释放桥接层订阅。
   */
  destroy() {
    this.stop()
    void this.connection.disconnect()
    this.bridgeInternal.destroy()
  }

  /**
   * 网络驱动帧回调：由场景每帧调用，用于驱动网络同步与输入上行。
   *
   * 职责：
   * - 更新 UI 状态（fps 等）
   * - 以固定频率读取输入并上行到服务端
   *
   * @param deltaMs 距离上一帧的时间（毫秒）
   */
  onNetworkFrame(_scene: unknown, deltaMs: number) {
    if (this.connectionStatus !== 'connected') {
      this.emitNetworkUiState(deltaMs)
      return
    }

    this.emitNetworkUiState(deltaMs)

    if (this.state.isPaused) return
    this.inputCooldownMs += deltaMs
    if (this.inputCooldownMs < 50) return
    this.inputCooldownMs = 0

    const payload = this.readInputPayload()
    this.connection.sendInput(payload)
  }

  /**
   * 生成 UI 初始状态。
   *
   * 说明：
   * - 这里的默认值用于首屏占位
   * - 后续由本地玩家快照与运行时状态逐步覆盖
   *
   * @returns 初始 UI 状态
   */
  private createInitialState(): GameUIState {
    return {
      fps: 60,
      isPaused: false,
      player: { x: 0, y: 0, facing: '下' },
      stats: {
        name: '-',
        zone: '-',
        level: 1,
        hp: 0,
        hpMax: 100,
        mp: 0,
        mpMax: 0,
        coins: 0,
      },
    }
  }

  /**
   * 连接服务端。
   *
   * 说明：
   * - joinOrCreate("game") 进入单房间
   * - 仅保留连接与断线处理，不接入服务端状态渲染链路
   */
  private async connectToServer() {
    if (this.connectionStatus === 'connecting' || this.connectionStatus === 'connected') return
    this.connectionStatus = 'connecting'

    try {
      const room = await this.connection.connect()
      this.connectionStatus = 'connected'
      this.bridgeInternal.emitMessage('已连接到服务器')

      room.onLeave(() => {
        this.connectionStatus = 'disconnected'
        this.bridgeInternal.emitMessage('连接已断开')
      })
    } catch {
      this.connectionStatus = 'disconnected'
      this.bridgeInternal.emitMessage('连接失败')
    }
  }

  /**
   * 推送网络驱动的 UI 状态（带节流）。
   *
   * @param deltaMs 距离上一帧的时间（毫秒）
   */
  private emitNetworkUiState(deltaMs: number) {
    const fps = deltaMs > 0 ? Math.round(1000 / deltaMs) : this.state.fps
    const next = {
      ...this.state,
      fps,
      player: {
        x: this.state.player.x,
        y: this.state.player.y,
        facing: this.state.player.facing,
      },
    }

    this.state = next

    this.emitCooldownMs += deltaMs
    if (this.emitCooldownMs < 100) return
    this.emitCooldownMs = 0
    this.bridgeInternal.setState(this.state)
  }

  /**
   * 接收本地玩家快照，并同步到 UI 状态。
   *
   * @param snapshot 本地玩家快照
   */
  onPlayerSnapshot(snapshot: PlayerSnapshot) {
    this.facing = snapshot.facing
    this.state = {
      ...this.state,
      player: {
        x: snapshot.x,
        y: snapshot.y,
        facing: snapshot.facing,
      },
    }
  }

  /**
   * 读取键盘输入并构造服务端需要的 InputPayload。
   *
   * 说明：
   * - WASD 映射为二维方向向量
   * - moveX/moveY 以“速度（像素/秒）”形式上行，与服务端 movementSystem 积分方式对齐
   * - 对斜向移动做归一化，避免对角线速度更快
   *
   * @returns 输入负载
   */
  private readInputPayload(): InputPayload {
    const speed = 200
    const keyboard = this.input.keyboard

    let dx = 0
    let dy = 0

    if (keyboard.isHeld(Keys.W)) dy -= 1
    if (keyboard.isHeld(Keys.S)) dy += 1
    if (keyboard.isHeld(Keys.A)) dx -= 1
    if (keyboard.isHeld(Keys.D)) dx += 1

    if (dx !== 0 || dy !== 0) {
      if (Math.abs(dx) > Math.abs(dy)) this.facing = dx > 0 ? '右' : '左'
      else this.facing = dy > 0 ? '下' : '上'
    }

    if (dx !== 0 && dy !== 0) {
      const inv = 1 / Math.sqrt(2)
      dx *= inv
      dy *= inv
    }

    const payload: InputPayload = {
      seq: (this.inputSeq += 1),
      moveX: dx * speed,
      moveY: dy * speed,
    }
    return payload
  }

  /**
   * 处理 UI 下发的指令（GameCommand）。
   *
   * @param command 指令对象
   */
  private onCommand(command: GameCommand) {
    if (command.type === 'togglePause') {
      this.onCommand({ type: 'setPaused', value: !this.state.isPaused })
      return
    }

    if (command.type === 'setPaused') {
      const nextPaused = command.value
      this.state = { ...this.state, isPaused: nextPaused }
      if (nextPaused) {
        this.stop()
        this.bridgeInternal.emitMessage('游戏已暂停')
      } else {
        void this.start()
        this.bridgeInternal.emitMessage('游戏已恢复')
      }
      this.bridgeInternal.setState(this.state)
      return
    }

    if (command.type === 'reset') {
      this.bridgeInternal.emitMessage('服务端未提供重置能力')
      return
    }

    this.bridgeInternal.emitMessage('服务端未提供该能力')
  }
}

let game: MyGame
let controller: GameController | undefined

/**
 * 初始化游戏并返回控制器（供页面持有并在卸载时 destroy）。
 *
 * @param gameCanvas 承载游戏渲染的 canvas 元素
 * @returns GameController（包含 bridge 与 destroy）
 */
export async function initGame(gameCanvas: HTMLCanvasElement): Promise<GameController> {
  controller?.destroy()
  game = new MyGame(gameCanvas)
  await game.startAndLoad()
  await game.goToScene('main')

  controller = {
    bridge: game.bridge,
    destroy() {
      game.destroy()
    },
  }
  return controller
}

/**
 * 销毁当前游戏实例（若存在）。
 */
export function destroyGame() {
  controller?.destroy()
  controller = undefined
}
