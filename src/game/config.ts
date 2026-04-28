import { Color, DisplayMode } from 'excalibur'

/**
 * 游戏引擎配置（画布尺寸、背景色、显示模式等）。
 */
export interface Config {
  width: number
  height: number
  backgroundColor: Color
  displayMode: DisplayMode
}

/**
 * 默认游戏配置。
 */
export const config: Config = {
  width: 1280,
  height: 720,
  backgroundColor: Color.Black,
  displayMode: DisplayMode.FitScreen,
}
