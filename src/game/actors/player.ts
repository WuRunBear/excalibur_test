import { Actor, Color, Engine, Keys } from 'excalibur'

import type { Facing, PlayerSnapshot } from 'game/type'

export class Player extends Actor {
  speed = 200
  private reportSnapshot?: (snapshot: PlayerSnapshot) => void
  private facing: Facing = '下'

  constructor(options?: { reportSnapshot?: (snapshot: PlayerSnapshot) => void }) {
    super({
      x: 50,
      y: 50,
      radius: 20,
      color: Color.Cyan,
    })
    this.reportSnapshot = options?.reportSnapshot
  }

  public override update(engine: Engine, delta: number) {
    if (engine.input.keyboard.isHeld(Keys.W)) {
      this.pos.y -= this.speed * (delta / 1000)
      this.facing = '上'
    }
    if (engine.input.keyboard.isHeld(Keys.S)) {
      this.pos.y += this.speed * (delta / 1000)
      this.facing = '下'
    }
    if (engine.input.keyboard.isHeld(Keys.D)) {
      this.pos.x += this.speed * (delta / 1000)
      this.facing = '右'
    }
    if (engine.input.keyboard.isHeld(Keys.A)) {
      this.pos.x -= this.speed * (delta / 1000)
      this.facing = '左'
    }

    if (this.reportSnapshot) {
      const snapshot: PlayerSnapshot = {
        x: this.pos.x,
        y: this.pos.y,
        facing: this.facing,
        deltaMs: delta,
      }
      this.reportSnapshot(snapshot)
    }
  }
}
