/**
 * 角色朝向（用于 UI 展示与输入反馈）。
 */
export type Facing = '上' | '下' | '左' | '右'

/**
 * 玩家在某一帧的快照。
 * - 用于从游戏域向 UI 域同步“可序列化”的玩家状态
 * - deltaMs 用于计算 FPS/节流等逻辑
 */
export interface PlayerSnapshot {
  x: number
  y: number
  facing: Facing
  deltaMs: number
}

/**
 * 玩家面板属性（示例用，供 UI 展示）。
 */
export interface PlayerStats {
  name: string
  zone: string
  level: number
  hp: number
  hpMax: number
  mp: number
  mpMax: number
  coins: number
}

/**
 * 游戏提供给 UI 的状态快照。
 * - UI 只读：UI 不应直接改写该对象，而是通过 dispatch 下发指令
 */
export interface GameUIState {
  fps: number
  isPaused: boolean
  player: {
    x: number
    y: number
    facing: Facing
  }
  stats: PlayerStats
}

/**
 * 游戏向 UI 派发的事件。
 * - state：状态刷新（订阅后会立即收到一次）
 * - message：短消息提示（例如战斗提示、系统提示等）
 */
export type GameUIEvent =
  | {
      type: 'state'
      state: GameUIState
    }
  | {
      type: 'message'
      text: string
    }

/**
 * UI 向游戏下发的指令。
 * - 所有指令都应是“意图”，由游戏侧决定如何修改内部状态
 * - amount 默认按“绝对值”处理，由具体指令语义决定增减（例如 heal 为加血）
 */
export type GameCommand =
  | { type: 'togglePause' }
  | { type: 'setPaused'; value: boolean }
  | { type: 'reset' }
  | { type: 'dealDamage'; amount: number }
  | { type: 'heal'; amount: number }
  | { type: 'spendMana'; amount: number }
  | { type: 'recoverMana'; amount: number }
  | { type: 'earnCoins'; amount: number }

/**
 * 取消订阅函数。
 */
export type Unsubscribe = () => void

/**
 * UI 与游戏之间的最小通信桥接协议。
 * - 只暴露状态读取、事件订阅、指令派发
 * - 不暴露 Engine/Scene/Actor 等引擎对象，避免 UI 反向依赖游戏实现
 */
export interface GameBridge {
  getState(): GameUIState
  subscribe(listener: (event: GameUIEvent) => void): Unsubscribe
  dispatch(command: GameCommand): void
}

/**
 * 游戏实例的生命周期控制器（UI/页面持有）。
 */
export interface GameController {
  bridge: GameBridge
  destroy(): void
}

/**
 * 游戏域对外回调入口（由 Engine/Scene 内部触发）。
 */
export interface GameHost {
  onPlayerSnapshot(snapshot: PlayerSnapshot): void
}
