import { Actor, Engine, Keys, type Keyboard, type Scene, type TileMap } from 'excalibur'
import { createGameBridge } from './bridge'
import { config, debugConfig } from './config'
import { sceneList } from './scenes'
import { loader } from './resources'

import type { Facing, GameCommand, GameController, GameUIState } from './type'

import { GameConnection } from './net/connection'
import { makeMapCacheKey } from './net/mapCodec'
import type {
  CollisionDebugEntityBody,
  CollisionDebugMapBody,
  CollisionDebugSnapshot,
  CommandPayload,
  ConnectionStatus,
  InputPayload,
  MapRuntime,
} from './net/types'
import { getItemCategory, SERVER_CONSTANTS } from './net/types'
import type { RoomState } from './net/schema'
import { ActorManager } from './world/actorManager'
import { EntityStore, type EntitySnapshot } from './world/entityStore'
import { createMapTileMap, createServerColliderDebugActor } from './world/mapTileMap'

const serverTickIntervalMs = 50
/** 放置 kit 时的朝向偏移（协议校验距离 64px，客户端取半距）。 */
const placeOffsetPx = 32
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
  private readonly canvasElement: HTMLCanvasElement
  private localEntityId: number | undefined
  private mapTileMap: TileMap | undefined
  /** 当前已挂载地图对应的运行时数据（用于与缓存条目比对，判断是否需要真正重建）。 */
  private attachedMapRuntime: MapRuntime | undefined
  /** 按 {id,version} 缓存的地图运行时数据：命中即复用，避免重复构建相同内容。 */
  private mapRuntimeCache = new Map<string, MapRuntime>()
  private mapDebugActors: Actor[] = []
  private entityDebugActors = new Map<number, Actor>()
  private entityDebugActorMeta = new Map<
    number,
    { shape: 'circle'; r: number } | { shape: 'box'; width: number; height: number }
  >()
  private unsubscribeCollisionDebugSnapshots?: () => void

  private isDragging = false
  private dragInitialScreen = { x: 0, y: 0 }
  private dragCurrentScreen = { x: 0, y: 0 }
  private dragInitialCamera = { x: 0, y: 0 }
  private manualCameraPos: { x: number; y: number } | null = null

  private inputSeq = 0
  private inputCooldownMs = 0
  private facing: Facing = '下'
  private selectedSlot: number | undefined

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

    this.canvasElement = canvasElement
    this.state = this.createInitialState()

    this.bridgeInternal = createGameBridge({
      initialState: this.state,
      onCommand: (command) => this.onCommand(command),
    })

    this.setupDragListeners()
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
    this.teardownDragListeners()
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
    this.updateCamera(scene)
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
      world: { hour: 8, phase: 0, mapId: '' },
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
      needs: [],
      inventory: Array.from({ length: 12 }, () => ({ kind: '', count: 0 })),
      equipment: { weaponSlot: -1, toolSlot: -1, armorSlot: -1 },
      quests: [],
      dialogue: null,
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
      const mapId = room.state.mapId ?? ''
      const runtime = await this.connection.fetchMapRuntime(mapId)
      this.applyMapRuntime(runtime, mapId)
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

    const next: GameUIState = {
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
      needs: local ? local.needs : this.state.needs,
      inventory: local ? local.inventory : this.state.inventory,
      equipment: local?.equipment ?? this.state.equipment,
      quests: local?.quests ?? this.state.quests,
      dialogue: local?.dialogue ?? this.state.dialogue,
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
   * 职责：
   * - 记录本地玩家 entityId
   * - 把实体表（visibleEntities/entities 兼容）写入 EntityStore
   * - 记录昼夜（hour/phase）与地图（mapId）；mapId 变化时重建地图层
   *
   * @param state 服务端房间状态
   * @param sessionId 当前客户端 sessionId
   */
  private handleRoomStateChange(state: RoomState, sessionId: string) {
    this.localEntityId = state.players.get(sessionId)?.entityId
    this.entityStore.updateFromRoomState(state, sessionId, performance.now())

    const prevMapId = this.state.world.mapId
    this.state = {
      ...this.state,
      world: {
        hour: state.hour,
        phase: state.phase,
        mapId: state.mapId,
      },
    }

    // 首次连接时地图已由 connectToServer 加载；仅地图切换（非空 → 非空）时重建
    if (prevMapId !== state.mapId && prevMapId !== '' && state.mapId) {
      this.rebuildMapForWorld(state.mapId)
    }
  }

  /**
   * 按指定地图 id 重新拉取地图并重建地图层（场景切换时调用）。
   *
   * 说明：
   * - 以房间状态 mapId 作为请求参数，杜绝换图后仍拉默认图
   * - 校验响应 id 与请求 id 一致后才应用，不符则告警并拒绝（不挂载错图）
   *
   * @param mapId 服务端房间状态中的地图 id
   */
  private async rebuildMapForWorld(mapId: string) {
    try {
      const runtime = await this.connection.fetchMapRuntime(mapId)
      if (this.applyMapRuntime(runtime, mapId)) {
        this.clearDebugActors()
      }
    } catch {
      this.bridgeInternal.emitMessage('地图加载失败')
    }
  }

  /**
   * 校验地图响应并按 {id,version} 缓存键应用地图运行时数据。
   *
   * 说明：
   * - 请求 id 非空时校验响应 id 一致，不符则告警并拒绝应用（不挂载错图）；
   *   请求 id 为空/未定义（首 tick 前 RoomState.mapId 尚未同步，或按默认图拉取）时
   *   不校验，服务端契约省略 mapId 回退默认图
   * - 缓存命中时复用已缓存运行时：内容相同且已挂载则跳过重建，
   *   尚未挂载（如换图后返回旧图）则直接用缓存对象挂载
   * - 未命中时写入缓存并挂载新运行时
   *
   * @param runtime 服务端返回的地图运行时数据
   * @param requestedMapId 请求的地图 id（空串/undefined 表示未指定、按默认图）
   * @returns 是否实际挂载了地图（校验失败或命中缓存跳过时为 false）
   */
  private applyMapRuntime(runtime: MapRuntime, requestedMapId: string): boolean {
    if (requestedMapId && runtime.id !== requestedMapId) {
      console.warn(`[map] 请求地图 ${requestedMapId}，服务端返回 ${runtime.id}，拒绝应用`)
      this.bridgeInternal.emitMessage('地图数据与请求不符')
      return false
    }

    const key = makeMapCacheKey(runtime.id, runtime.version)
    const cached = this.mapRuntimeCache.get(key)
    if (cached) {
      if (cached !== this.attachedMapRuntime) {
        this.attachMapTileMap(cached)
        return true
      }
      return false
    }

    this.mapRuntimeCache.set(key, runtime)
    this.attachMapTileMap(runtime)
    return true
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
  private attachMapTileMap(runtime: MapRuntime) {
    this.detachMapTileMap()
    this.attachedMapRuntime = runtime
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
    this.attachedMapRuntime = undefined
  }

  private updateCamera(scene: Scene) {
    if (this.isDragging) {
      const zoom = scene.camera.zoom || 1
      const dx = (this.dragCurrentScreen.x - this.dragInitialScreen.x) / zoom
      const dy = (this.dragCurrentScreen.y - this.dragInitialScreen.y) / zoom
      const cx = this.dragInitialCamera.x - dx
      const cy = this.dragInitialCamera.y - dy
      scene.camera.pos.x = cx
      scene.camera.pos.y = cy
      this.manualCameraPos = { x: cx, y: cy }
      return
    }
    if (this.manualCameraPos) {
      scene.camera.pos.x = this.manualCameraPos.x
      scene.camera.pos.y = this.manualCameraPos.y
      return
    }
    if (this.localEntityId === undefined) return
    const localActor = this.actorManager.getActor(this.localEntityId)
    if (!localActor) return
    scene.camera.pos = localActor.pos.clone()
  }

  private setupDragListeners() {
    this.canvasElement.addEventListener('pointerdown', this.onPointerDown)
    this.canvasElement.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    this.canvasElement.addEventListener('wheel', this.onWheel, { passive: false })
  }

  private teardownDragListeners() {
    this.canvasElement.removeEventListener('pointerdown', this.onPointerDown)
    this.canvasElement.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    this.canvasElement.removeEventListener('wheel', this.onWheel)
  }

  private onPointerDown = (e: PointerEvent) => {
    this.isDragging = true
    this.dragInitialScreen = { x: e.clientX, y: e.clientY }
    this.dragCurrentScreen = { x: e.clientX, y: e.clientY }
    const cam = this.mainScene.camera
    this.dragInitialCamera = { x: cam.pos.x, y: cam.pos.y }
  }

  private onPointerMove = (e: PointerEvent) => {
    if (!this.isDragging) return
    this.dragCurrentScreen = { x: e.clientX, y: e.clientY }
  }

  private onPointerUp = () => {
    this.isDragging = false
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const cam = this.mainScene.camera
    const oldZoom = cam.zoom
    const step = 0.1
    const newZoom = Math.max(0.3, Math.min(5, oldZoom - Math.sign(e.deltaY) * step))
    if (newZoom === oldZoom) return

    const rect = this.canvasElement.getBoundingClientRect()
    const scaleX = config.width / rect.width
    const scaleY = config.height / rect.height
    const mx = (e.clientX - rect.left) * scaleX
    const my = (e.clientY - rect.top) * scaleY

    const hw = config.width / 2
    const hh = config.height / 2
    const worldX = cam.pos.x + (mx - hw) / oldZoom
    const worldY = cam.pos.y + (my - hh) / oldZoom

    cam.zoom = newZoom
    cam.pos.x = worldX - (mx - hw) / newZoom
    cam.pos.y = worldY - (my - hh) / newZoom

    this.manualCameraPos = { x: cam.pos.x, y: cam.pos.y }
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
    if (snapshot.mapBodies) {
      this.replaceMapDebugActors(snapshot.mapBodies)
    }
    this.syncEntityDebugActors(snapshot.entityBodies)

    this.state = {
      ...this.state,
      debug: {
        ...this.state.debug,
        colliderCount: this.getVisibleDebugColliderCount(snapshot.entityBodies.length),
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
    this.detachDebugActors(this.mapDebugActors)
    this.mapDebugActors = []

    for (const actor of this.entityDebugActors.values()) {
      this.mainScene.remove(actor)
    }
    this.entityDebugActors.clear()
    this.entityDebugActorMeta.clear()
  }

  /**
   * 计算当前需要展示到 UI 的碰撞体数量。
   *
   * @param entityCount 当前帧实体碰撞体数量
   * @returns 根据可见性开关折算后的碰撞体数量
   */
  private getVisibleDebugColliderCount(entityCount: number) {
    const mapCount = this.state.debug.showMapColliders ? this.mapDebugActors.length : 0
    const visibleEntityCount = this.state.debug.showEntityColliders ? entityCount : 0
    return mapCount + visibleEntityCount
  }

  /**
   * 批量把调试 Actor 挂到主场景。
   *
   * @param actors 需要挂载的 Actor 列表
   */
  private attachDebugActors(actors: Iterable<Actor>) {
    for (const actor of actors) {
      this.mainScene.add(actor)
    }
  }

  /**
   * 批量把调试 Actor 从主场景移除。
   *
   * @param actors 需要移除的 Actor 列表
   */
  private detachDebugActors(actors: Iterable<Actor>) {
    for (const actor of actors) {
      this.mainScene.remove(actor)
    }
  }

  /**
   * 用最新地图碰撞体替换静态调试层。
   *
   * @param mapBodies 地图碰撞体列表
   */
  private replaceMapDebugActors(mapBodies: CollisionDebugMapBody[]) {
    this.detachDebugActors(this.mapDebugActors)
    this.mapDebugActors = mapBodies.map((body) => createServerColliderDebugActor(body))
    if (this.state.debug.showMapColliders) {
      this.attachDebugActors(this.mapDebugActors)
    }
  }

  /**
   * 按实体编号增量同步动态调试层。
   *
   * @param entityBodies 实体碰撞体列表
   */
  private syncEntityDebugActors(entityBodies: CollisionDebugEntityBody[]) {
    const activeEntityIds = new Set<number>()

    for (const body of entityBodies) {
      activeEntityIds.add(body.eid)
      const actor = this.entityDebugActors.get(body.eid)
      const meta = this.entityDebugActorMeta.get(body.eid)
      const shouldRecreate =
        !actor ||
        !meta ||
        meta.shape !== body.shape ||
        (body.shape === 'circle' && meta.shape === 'circle' && meta.r !== body.r) ||
        (body.shape === 'box' &&
          meta.shape === 'box' &&
          (meta.width !== body.width || meta.height !== body.height))

      if (shouldRecreate) {
        this.replaceEntityDebugActor(body)
        continue
      }

      this.updateEntityDebugActorPosition(actor, body)
    }

    for (const [eid, actor] of this.entityDebugActors) {
      if (activeEntityIds.has(eid)) continue
      this.mainScene.remove(actor)
      this.entityDebugActors.delete(eid)
      this.entityDebugActorMeta.delete(eid)
    }
  }

  /**
   * 用新的实体碰撞体 Actor 替换旧实例。
   *
   * @param body 实体碰撞体数据
   */
  private replaceEntityDebugActor(body: CollisionDebugEntityBody) {
    const previous = this.entityDebugActors.get(body.eid)
    if (previous) {
      this.mainScene.remove(previous)
    }

    const actor = createServerColliderDebugActor(body)
    this.entityDebugActors.set(body.eid, actor)
    this.entityDebugActorMeta.set(
      body.eid,
      body.shape === 'circle'
        ? { shape: 'circle', r: body.r }
        : { shape: 'box', width: body.width, height: body.height },
    )

    if (this.state.debug.showEntityColliders) {
      this.mainScene.add(actor)
    }
  }

  /**
   * 仅更新已存在实体调试 Actor 的位置，避免反复重建对象。
   *
   * @param actor 已存在的调试 Actor
   * @param body 最新实体碰撞体数据
   */
  private updateEntityDebugActorPosition(actor: Actor, body: CollisionDebugEntityBody) {
    if (body.shape === 'circle') {
      actor.pos.x = body.x
      actor.pos.y = body.y
      return
    }

    actor.pos.x = body.x + body.width * 0.5
    actor.pos.y = body.y + body.height * 0.5
  }

  /**
   * 根据当前可见性开关刷新调试层挂载状态。
   */
  private refreshDebugActorVisibility() {
    this.detachDebugActors(this.mapDebugActors)
    this.detachDebugActors(this.entityDebugActors.values())

    if (this.state.debug.showMapColliders) {
      this.attachDebugActors(this.mapDebugActors)
    }
    if (this.state.debug.showEntityColliders) {
      this.attachDebugActors(this.entityDebugActors.values())
    }
  }

  /**
   * 读取键盘输入并构造服务端需要的 InputPayload。
   *
   * 说明：
   * - WASD 映射为二维方向向量
   * - moveX/moveY 以“速度（像素/秒）”形式上行，与服务端 movementSystem 积分方式对齐
   * - 对斜向移动做归一化，避免对角线速度更快
   * - E/空格/T 为边沿信号：只在按下那一帧置 true（服务端消费后清除）
   *
   * @returns 输入负载
   */
  private readInputPayload(): InputPayload {
    const speed = SERVER_CONSTANTS.speedLimit
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
      this.manualCameraPos = null
    }

    if (dx !== 0 && dy !== 0) {
      const inv = 1 / Math.sqrt(2)
      dx *= inv
      dy *= inv
    }

    this.handleGameplayHotkeys(keyboard)

    const payload: InputPayload = {
      seq: (this.inputSeq += 1),
      moveX: dx * speed,
      moveY: dy * speed,
      interact: keyboard.wasPressed(Keys.E) ? true : undefined,
      attack: keyboard.wasPressed(Keys.Space) ? true : undefined,
      talk: keyboard.wasPressed(Keys.T) ? true : undefined,
    }
    return payload
  }

  /**
   * 处理玩法热键（与 UI 共用同一命令通道，防抖：按下沿触发一次）。
   *
   * 键位（协议 §3.1）：
   * - C：打开合成面板（UI 指令，由面板点击合成）
   * - G：丢弃选中槽
   * - B：放置选中 kit（玩家朝向偏移 ~32px）
   * - X：拆除最近建筑
   * - 数字 1–6：选中快捷槽
   *
   * @param keyboard Excalibur 键盘输入
   */
  private handleGameplayHotkeys(keyboard: Keyboard) {
    if (keyboard.wasPressed(Keys.C)) {
      this.bridgeInternal.emitMessage('按 C 打开合成面板（点击物品合成）')
    }
    if (keyboard.wasPressed(Keys.G)) {
      const slot = this.selectedSlot
      if (slot !== undefined) this.onCommand({ type: 'dropItem', slot })
    }
    if (keyboard.wasPressed(Keys.B)) {
      const slot = this.selectedSlot
      if (slot !== undefined) this.onCommand({ type: 'placeItem', slot })
    }
    if (keyboard.wasPressed(Keys.X)) {
      this.deconstructNearest()
    }
    const digitKeys: Keys[] = [
      Keys.Digit1,
      Keys.Digit2,
      Keys.Digit3,
      Keys.Digit4,
      Keys.Digit5,
      Keys.Digit6,
    ]
    for (let i = 0; i < digitKeys.length; i++) {
      const key = digitKeys[i]
      if (key && keyboard.wasPressed(key)) {
        this.selectedSlot = i
      }
    }
  }

  /**
   * 拆除最近建筑：从实体快照中找最近的 building 实体并发 deconstruct 命令。
   */
  private deconstructNearest() {
    const snapshots = this.entityStore.sample(performance.now())
    const local =
      typeof this.localEntityId === 'number' ? snapshots.get(this.localEntityId) : undefined
    if (!local) return

    let nearest: EntitySnapshot | undefined
    let nearestDist = Infinity
    snapshots.forEach((s) => {
      if (s.kind !== 'building') return
      const d = (s.x - local.x) ** 2 + (s.y - local.y) ** 2
      if (d < nearestDist) {
        nearestDist = d
        nearest = s
      }
    })
    if (!nearest) {
      this.bridgeInternal.emitMessage('附近没有可拆除的建筑')
      return
    }
    this.onCommand({ type: 'deconstructItem', target: nearest.id })
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

      this.state = {
        ...this.state,
        debug: {
          ...nextDebug,
          colliderCount: this.getVisibleDebugColliderCount(this.entityDebugActors.size),
        },
      }
      this.refreshDebugActorVisibility()
      this.bridgeInternal.setState(this.state)

      this.syncDebugSubscription()
      this.connection.requestCollisionDebugSnapshot()
      return
    }

    if (command.type === 'refreshDebugOverlay') {
      this.connection.requestCollisionDebugSnapshot()
      return
    }

    if (command.type === 'useItem') {
      const slotInfo = this.state.inventory[command.slot]
      const category = slotInfo ? getItemCategory(slotInfo.kind) : undefined
      if (category === 'food') {
        this.sendCommand({ type: 'consume', slot: command.slot })
      } else if (category === 'tool') {
        this.sendCommand({ type: 'equip', slot: command.slot })
      } else if (category === 'kit') {
        this.bridgeInternal.emitMessage('kit 类物品请用 B 键放置')
      } else {
        this.bridgeInternal.emitMessage('该物品不能使用')
      }
      return
    }

    if (command.type === 'dropItem') {
      this.sendCommand({ type: 'drop', slot: command.slot })
      return
    }

    if (command.type === 'transferItem') {
      this.sendCommand({ type: 'transfer', slot: command.slot, toSlot: command.toSlot })
      return
    }

    if (command.type === 'craftItem') {
      this.sendCommand({ type: 'craft', recipe: command.recipe })
      return
    }

    if (command.type === 'placeItem') {
      const snapshots = this.entityStore.sample(performance.now())
      const local =
        typeof this.localEntityId === 'number' ? snapshots.get(this.localEntityId) : undefined
      if (!local) {
        this.bridgeInternal.emitMessage('无法确定玩家位置')
        return
      }
      const offset = this.facingOffset()
      this.sendCommand({
        type: 'place',
        slot: command.slot,
        x: local.x + offset.x,
        y: local.y + offset.y,
      })
      return
    }

    if (command.type === 'deconstructItem') {
      this.sendCommand({ type: 'deconstruct', target: command.target })
      return
    }

    if (command.type === 'dialogueSelect') {
      this.sendCommand({ type: 'dialogue', option: command.option })
      return
    }

    this.bridgeInternal.emitMessage('服务端未提供该能力')
  }

  /**
   * 把 UI 指令映射为服务端 command 负载并发送。
   *
   * @param payload 服务端命令负载（协议 §2.2）
   */
  private sendCommand(payload: CommandPayload) {
    if (this.connectionStatus !== 'connected') {
      this.bridgeInternal.emitMessage('尚未连接服务器')
      return
    }
    this.connection.sendCommand(payload)
  }

  /**
   * 计算玩家朝向的偏移向量（放置 kit 用，协议 §3.1：朝向偏移 ~32px）。
   *
   * @returns 偏移向量
   */
  private facingOffset() {
    switch (this.facing) {
      case '上':
        return { x: 0, y: -placeOffsetPx }
      case '下':
        return { x: 0, y: placeOffsetPx }
      case '左':
        return { x: -placeOffsetPx, y: 0 }
      case '右':
        return { x: placeOffsetPx, y: 0 }
    }
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
