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

export interface DebugConfig {
  drawCollisionRects: boolean
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

/**
 * 调试配置。
 *
 * 约定：
 * - VITE_GAME_DEBUG_DRAW_COLLISION_RECTS=true/1：绘制服务端碰撞系统的“合并后矩形碰撞体”
 */
export const debugConfig: DebugConfig = {
  drawCollisionRects:
    (import.meta.env.VITE_GAME_DEBUG_DRAW_COLLISION_RECTS as string | undefined) === '1' ||
    (import.meta.env.VITE_GAME_DEBUG_DRAW_COLLISION_RECTS as string | undefined) === 'true',
}
