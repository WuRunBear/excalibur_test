// src/game/resources.ts
import { ImageSource, Loader, Sound } from 'excalibur'

// 使用 import 引入，Vite 会返回正确的 URL
import playerPng from './assets/sprites/player.png'
import speakWav from './assets/sfx/speak.mp3'

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
  BGM: new Sound('/game/music/background.mp3'),
}

/**
 * Excalibur Loader：用于在引擎启动时统一预加载资源。
 */
export const loader = new Loader(Object.values(Resources))
loader.suppressPlayButton = true

// 环境兼容：装载流程默认在 onUserAction / showPlayButton / onAfterLoad 里各做一次
// clock 延时（200ms + 500ms，纯节奏点缀，suppressPlayButton=true 本就无需用户交互）。
// 在 rAF 被暂停的嵌入式 / 未聚焦窗口里游戏时钟近乎冻结（实测 1ms/s），
// 这几次延时会拖住整个 engine.start() → /play 永远停在「正在启动」。
// 直接同步跳过：装载由网络请求与微任务驱动，不依赖时钟推进。
loader.onUserAction = async () => {}
loader.showPlayButton = async () => {}

// Excalibur Loader.dispose() 在 play 按钮 DOM 未创建（suppressPlayButton）时会读到
// null.parentElement 抛 TypeError → loader.load() 尾部被中断（_loaded 恒为 false、
// _loaderCompleteFuture 永不 resolve）。loader 是模块级单例：第二次 initGame（实例
// 切换 destroy→重建）时 Engine.load 复用它，isLoaded()=false → 再入 load() →
// 命中「_isLoading=true → 返回永不 resolve 的 future」→ 引擎装载永久挂起。
// 这里换成幂等的空安全清理，保证 load() 尾部完整走完。
const loaderDom = loader as unknown as {
  _playButtonRootElement: HTMLElement | null
  _playButtonElement: HTMLElement | null
  _styleBlock: HTMLStyleElement | null
  dispose: () => void
}
loaderDom.dispose = () => {
  try {
    loaderDom._playButtonRootElement?.remove()
    loaderDom._playButtonElement?.remove()
    loaderDom._styleBlock?.remove()
  } catch {
    // 装饰性 DOM 清理失败可忽略
  }
  loaderDom._playButtonRootElement = null
  loaderDom._playButtonElement = null
  loaderDom._styleBlock = null
}
