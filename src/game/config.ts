import { Color, DisplayMode } from "excalibur";

export interface Config {
    width: number,
    height: number,
    backgroundColor: Color,
    displayMode: DisplayMode,
}
export const config: Config = {
    width: 1280,
    height: 720,
    backgroundColor: Color.Black,
    displayMode: DisplayMode.FitScreen,
}
