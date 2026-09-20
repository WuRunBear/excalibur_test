import { main } from './main'

/**
 * 场景注册表：由游戏引擎在启动时统一 add 进 Engine。
 */
export const sceneList = {
  main: main,
}

/**
 * 场景名联合类型（与 sceneList 保持同步）。
 */
export type sceneName = keyof typeof sceneList
