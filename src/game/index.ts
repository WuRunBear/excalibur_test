import { Actor, Engine, Keys, type Scene, type TileMap } from 'excalibur'
import { createGameBridge } from './bridge'
import { config, debugConfig } from './config'
import { sceneList } from './scenes'
import { loader } from './resources'

import type { Facing, GameCommand, GameController, GameUIState } from './type'

import { GameConnection } from './net/connection'
import type { CollisionDebugSnapshot, ConnectionStatus, InputPayload } from './net/types'
import type { RoomState } from './net/schema'
import { ActorManager } from './world/actorManager'
import { EntityStore } from './world/entityStore'
import { createMapTileMap, createServerColliderDebugActors } from './world/mapTileMap'

const serverTickIntervalMs = 50
/**
 * Excalibur 游戏引擎实现：
 * - 维护游戏内部状态（GameUIState）
 * - 通过 bridge 向 UI 推送状态/消息，接收 UI 指令
 *
 * 当前模式约定：
 * - 场景完全以后端 RoomState 为权威进行渲染
 * - 前端只负责输入上行、地图显示与插值表现
 */
export class MyGame extends Engine {
  private readonly bridgeInternal: ReturnType<typeof createGameBridge>
  private readonly entityStore = new EntityStore(serverTickIntervalMs)
  private readonly actorManager = new ActorManager()
  private readonly mainScene = sceneList.main
  private state: GameUIState
  private emitCooldownMs = 0
  private connectionStatus: ConnectionStatus = 'idle'

  private readonly connection = new GameConnection()
  private localEntityId: number | undefined
  private mapTileMap: TileMap | undefined
  private debugActors: Actor[] = []
  private unsubscribeCollisionDebugSnapshots?: () => void

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
    this.actorManager.clear(this.mainScene)
    this.detachMapTileMap()
    this.clearDebugActors()
    this.entityStore.reset()
    this.localEntityId = undefined
    this.unsubscribeCollisionDebugSnapshots?.()
    this.unsubscribeCollisionDebugSnapshots = undefined
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
    const scene = _scene as Scene
    const nowMs = performance.now()
    const snapshots = this.entityStore.sample(nowMs)

    this.actorManager.apply(scene, snapshots, this.localEntityId)
    this.emitNetworkUiState(deltaMs, snapshots)

    if (this.connectionStatus !== 'connected') return

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
   * - 后续由服务端权威状态与本地连接状态逐步覆盖
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
      debug: {
        enabled: debugConfig.drawServerColliders,
        showMapColliders: true,
        showEntityColliders: true,
        autoRefresh: true,
        colliderCount: 0,
        pairCount: 0,
        tick: 0,
      },
    }
  }

  /**
   * 连接服务端。
   *
   * 说明：
   * - joinOrCreate("game") 进入单房间
   * - 连接成功后拉取地图，并订阅 RoomState 驱动实体渲染
   */
  private async connectToServer() {
    if (this.connectionStatus === 'connecting' || this.connectionStatus === 'connected') return
    this.connectionStatus = 'connecting'

    try {
      const room = await this.connection.connect()
      const runtime = await this.connection.fetchMapRuntime()
      this.attachMapTileMap(runtime)
      this.unsubscribeCollisionDebugSnapshots?.()
      this.unsubscribeCollisionDebugSnapshots = this.connection.subscribeCollisionDebugSnapshots(
        (snapshot) => {
          this.applyDebugSnapshot(snapshot)
        },
      )
      room.onStateChange((state) => {
        this.handleRoomStateChange(state, room.sessionId)
      })
      this.connectionStatus = 'connected'
      this.bridgeInternal.emitMessage('已连接到服务器')

      room.onLeave(() => {
        this.handleDisconnected('连接已断开')
      })

      if (this.state.debug.enabled) {
        this.syncDebugSubscription()
      }
    } catch {
      this.handleDisconnected('连接失败')
    }
  }

  /**
   * 根据服务端快照推送 UI 状态（带节流）。
   *
   * @param deltaMs 距离上一帧的时间（毫秒）
   * @param snapshots 当前帧用于渲染的实体快照
   */
  private emitNetworkUiState(deltaMs: number, snapshots: ReturnType<EntityStore['sample']>) {
    const fps = deltaMs > 0 ? Math.round(1000 / deltaMs) : this.state.fps
    const local =
      typeof this.localEntityId === 'number' ? snapshots.get(this.localEntityId) : undefined
    const next = {
      ...this.state,
      fps,
      player: {
        x: local?.x ?? this.state.player.x,
        y: local?.y ?? this.state.player.y,
        facing: this.facing,
      },
      stats: {
        ...this.state.stats,
        hp: local?.hp ?? this.state.stats.hp,
      },
      debug: this.state.debug,
    }

    this.state = next

    this.emitCooldownMs += deltaMs
    if (this.emitCooldownMs < 100) return
    this.emitCooldownMs = 0
    this.bridgeInternal.setState(this.state)
  }

  /**
   * 处理一次房间状态变化。
   *
   * @param state 服务端房间状态
   * @param sessionId 当前客户端 sessionId
   */
  private handleRoomStateChange(state: RoomState, sessionId: string) {
    this.localEntityId = state.players.get(sessionId)?.entityId
    this.entityStore.updateFromRoomState(state, performance.now())
  }

  /**
   * 处理断线后的本地清理。
   *
   * @param message 需要推送给 UI 的提示文案
   */
  private handleDisconnected(message: string) {
    this.connectionStatus = 'disconnected'
    this.localEntityId = undefined
    this.unsubscribeCollisionDebugSnapshots?.()
    this.unsubscribeCollisionDebugSnapshots = undefined
    this.clearDebugActors()
    this.entityStore.reset()
    this.actorManager.clear(this.mainScene)
    this.state = {
      ...this.state,
      stats: {
        ...this.state.stats,
        hp: 0,
      },
      debug: {
        ...this.state.debug,
        colliderCount: 0,
        pairCount: 0,
        tick: 0,
      },
    }
    this.bridgeInternal.setState(this.state)
    this.bridgeInternal.emitMessage(message)
  }

  /**
   * 把服务端地图挂到主场景中。
   *
   * @param runtime 服务端地图运行时数据
   */
  private attachMapTileMap(runtime: Awaited<ReturnType<GameConnection['fetchMapRuntime']>>) {
    this.detachMapTileMap()
    this.mapTileMap = createMapTileMap(runtime)
    this.mainScene.add(this.mapTileMap)
  }

  /**
   * 从主场景移除已挂载的地图。
   */
  private detachMapTileMap() {
    if (!this.mapTileMap) return
    this.mainScene.remove(this.mapTileMap)
    this.mapTileMap = undefined
  }

  /**
   * 同步当前调试订阅状态到服务端。
   */
  private syncDebugSubscription() {
    if (!this.state.debug.enabled) {
      this.connection.unsubscribeCollisionDebugStream()
      return
    }

    if (this.state.debug.autoRefresh) {
      this.connection.subscribeCollisionDebugStream()
      return
    }

    this.connection.unsubscribeCollisionDebugStream()
  }

  /**
   * 把服务端碰撞体快照渲染到主场景。
   *
   * @param snapshot 服务端碰撞调试快照
   */
  private applyDebugSnapshot(snapshot: CollisionDebugSnapshot) {
    const bodies = snapshot.bodies.filter((body) => {
      if (body.kind === 'map') return this.state.debug.showMapColliders
      return this.state.debug.showEntityColliders
    })

    this.clearDebugActors()
    this.debugActors = createServerColliderDebugActors({
      tick: snapshot.tick,
      pairs: snapshot.pairs,
      bodies,
    })

    for (const actor of this.debugActors) {
      this.mainScene.add(actor)
    }

    this.state = {
      ...this.state,
      debug: {
        ...this.state.debug,
        colliderCount: bodies.length,
        pairCount: snapshot.pairs.length,
        tick: snapshot.tick,
      },
    }
    this.bridgeInternal.setState(this.state)
  }

  /**
   * 清理主场景中的调试碰撞体。
   */
  private clearDebugActors() {
    for (const actor of this.debugActors) {
      this.mainScene.remove(actor)
    }
    this.debugActors = []
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

    if (command.type === 'setDebugOptions') {
      const nextDebug = { ...this.state.debug, ...command.value }
      this.state = { ...this.state, debug: nextDebug }
      this.bridgeInternal.setState(this.state)

      if (!nextDebug.enabled) {
        this.connection.unsubscribeCollisionDebugStream()
        this.clearDebugActors()
        this.state = {
          ...this.state,
          debug: {
            ...nextDebug,
            colliderCount: 0,
            pairCount: 0,
            tick: 0,
          },
        }
        this.bridgeInternal.setState(this.state)
        return
      }

      this.syncDebugSubscription()
      this.connection.requestCollisionDebugSnapshot()
      return
    }

    if (command.type === 'refreshDebugOverlay') {
      this.connection.requestCollisionDebugSnapshot()
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
