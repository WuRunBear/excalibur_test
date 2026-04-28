// src/game/resources.ts
import { ImageSource, Loader, Sound } from 'excalibur'
// 加载 Tiled 地图或大型 BGM
import { TiledResource } from '@excaliburjs/plugin-tiled'

// 使用 import 引入，Vite 会返回正确的 URL
import playerPng from 'game/assets/sprites/player.png'
import speakWav from 'game/assets/sfx/speak.mp3'

/**
 * 资源清单（图片/音效/地图等）。
 *
 * 说明：
 * - 通过 Vite import 的资源会被处理为运行时可访问的 URL
 * - 以 /game/... 开头的路径通常来自 public 目录（运行时静态资源）
 */
export const Resources = {
  Player: new ImageSource(playerPng),
  speakSound: new Sound(speakWav),
  Level1Map: new TiledResource('/game/map/level1.json'),
  BGM: new Sound('/game/music/background.mp3'),
}

/**
 * Excalibur Loader：用于在引擎启动时统一预加载资源。
 */
export const loader = new Loader(Object.values(Resources))
