export type Facing = '上' | '下' | '左' | '右'

export interface PlayerSnapshot {
  x: number
  y: number
  facing: Facing
  deltaMs: number
}

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

export type GameUIEvent =
  | {
      type: 'state'
      state: GameUIState
    }
  | {
      type: 'message'
      text: string
    }

export type GameCommand =
  | { type: 'togglePause' }
  | { type: 'setPaused'; value: boolean }
  | { type: 'reset' }
  | { type: 'dealDamage'; amount: number }
  | { type: 'heal'; amount: number }
  | { type: 'spendMana'; amount: number }
  | { type: 'recoverMana'; amount: number }
  | { type: 'earnCoins'; amount: number }

export type Unsubscribe = () => void

export interface GameBridge {
  getState(): GameUIState
  subscribe(listener: (event: GameUIEvent) => void): Unsubscribe
  dispatch(command: GameCommand): void
}

export interface GameController {
  bridge: GameBridge
  destroy(): void
}

export interface GameHost {
  onPlayerSnapshot(snapshot: PlayerSnapshot): void
}
