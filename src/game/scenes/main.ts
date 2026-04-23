import { Scene, Engine } from "excalibur";
import { Player } from "game/actors/player";

export class Main extends Scene {
    override onInitialize(engine: Engine<any>): void {
        this.add(new Player())
    }
}

export const main = new Main();