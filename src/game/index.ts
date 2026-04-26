import { Engine } from 'excalibur'
import { createGameBridge } from './bridge'
import { config } from './config'
import { sceneList } from './scenes'
import { loader } from './resources'

import type { GameCommand, GameController, GameHost, GameUIState, PlayerSnapshot } from './type'

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

export class MyGame extends Engine implements GameHost {
  private readonly bridgeInternal: ReturnType<typeof createGameBridge>
  private state: GameUIState
  private emitCooldownMs = 0

  constructor(canvasElement: HTMLCanvasElement) {
    super({
      width: config.width,
      height: config.height,
      canvasElement: canvasElement,
      backgroundColor: config.backgroundColor,
      displayMode: config.displayMode,
    })

    this.state = {
      fps: 60,
      isPaused: false,
      player: { x: 50, y: 50, facing: '下' },
      stats: {
        name: '测试玩家',
        zone: '新手村',
        level: 7,
        hp: 86,
        hpMax: 100,
        mp: 52,
        mpMax: 80,
        coins: 128,
      },
    }

    this.bridgeInternal = createGameBridge({
      initialState: this.state,
      onCommand: (command) => this.onCommand(command),
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

  get bridge() {
    return this.bridgeInternal.bridge
  }

  destroy() {
    this.stop()
    this.bridgeInternal.destroy()
  }

  onPlayerSnapshot(snapshot: PlayerSnapshot): void {
    const fps = snapshot.deltaMs > 0 ? Math.round(1000 / snapshot.deltaMs) : this.state.fps
    this.state = {
      ...this.state,
      fps,
      player: { x: snapshot.x, y: snapshot.y, facing: snapshot.facing },
    }

    this.emitCooldownMs += snapshot.deltaMs
    if (this.emitCooldownMs < 100) return
    this.emitCooldownMs = 0
    this.bridgeInternal.setState(this.state)
  }

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
      this.state = {
        ...this.state,
        isPaused: false,
        player: { x: 50, y: 50, facing: '下' },
        stats: {
          ...this.state.stats,
          hp: this.state.stats.hpMax,
          mp: this.state.stats.mpMax,
          coins: 0,
        },
      }
      this.bridgeInternal.emitMessage('状态已重置')
      this.bridgeInternal.setState(this.state)
      void this.goToScene('main')
      return
    }

    if (command.type === 'dealDamage') {
      const nextHp = clamp(this.state.stats.hp - command.amount, 0, this.state.stats.hpMax)
      this.state = { ...this.state, stats: { ...this.state.stats, hp: nextHp } }
      this.bridgeInternal.emitMessage(
        `受到伤害 -${command.amount}，生命剩余 ${nextHp}/${this.state.stats.hpMax}`,
      )
      this.bridgeInternal.setState(this.state)
      return
    }

    if (command.type === 'heal') {
      const nextHp = clamp(this.state.stats.hp + command.amount, 0, this.state.stats.hpMax)
      this.state = { ...this.state, stats: { ...this.state.stats, hp: nextHp } }
      this.bridgeInternal.emitMessage(
        `使用治疗 +${command.amount}，生命变为 ${nextHp}/${this.state.stats.hpMax}`,
      )
      this.bridgeInternal.setState(this.state)
      return
    }

    if (command.type === 'spendMana') {
      const nextMp = clamp(this.state.stats.mp - command.amount, 0, this.state.stats.mpMax)
      this.state = { ...this.state, stats: { ...this.state.stats, mp: nextMp } }
      if (nextMp === 0) this.bridgeInternal.emitMessage('能量不足，无法施法')
      else
        this.bridgeInternal.emitMessage(
          `施法消耗 -${command.amount}，能量剩余 ${nextMp}/${this.state.stats.mpMax}`,
        )
      this.bridgeInternal.setState(this.state)
      return
    }

    if (command.type === 'recoverMana') {
      const nextMp = clamp(this.state.stats.mp + command.amount, 0, this.state.stats.mpMax)
      this.state = { ...this.state, stats: { ...this.state.stats, mp: nextMp } }
      this.bridgeInternal.emitMessage(
        `回复能量 +${command.amount}，能量变为 ${nextMp}/${this.state.stats.mpMax}`,
      )
      this.bridgeInternal.setState(this.state)
      return
    }

    if (command.type === 'earnCoins') {
      const nextCoins = this.state.stats.coins + command.amount
      this.state = { ...this.state, stats: { ...this.state.stats, coins: nextCoins } }
      this.bridgeInternal.emitMessage(`拾取金币 +${command.amount}，总计 ${nextCoins}`)
      this.bridgeInternal.setState(this.state)
    }
  }
}

let game: MyGame
let controller: GameController | undefined

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

export function destroyGame() {
  controller?.destroy()
  controller = undefined
}
