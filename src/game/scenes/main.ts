import { Scene, Engine } from 'excalibur'
import { Player } from 'game/actors/player'
import type { GameHost } from 'game/type'

export class Main extends Scene {
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

export const main = new Main()
