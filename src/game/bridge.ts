import type { GameBridge, GameCommand, GameUIEvent, GameUIState, Unsubscribe } from './type'

/**
 * 创建 UI ↔ 游戏 的桥接层实现（纯 TS，不依赖 Vue/Pinia）。
 *
 * 设计目标：
 * - UI 只通过事件订阅获取状态与消息
 * - UI 只通过指令派发表达意图，不直接修改游戏内部状态
 *
 * @param options.initialState 初始化状态；subscribe 后会立即推送一次该状态
 * @param options.onCommand 指令回调；由游戏侧实现具体响应逻辑
 * @returns bridge：给 UI 使用的协议对象；setState/emitMessage：给游戏侧使用的状态与消息推送方法
 */
export function createGameBridge(options: {
  initialState: GameUIState
  onCommand: (command: GameCommand) => void
}) {
  let state = options.initialState
  const listeners = new Set<(event: GameUIEvent) => void>()

  function emit(event: GameUIEvent) {
    for (const listener of listeners) listener(event)
  }

  const bridge: GameBridge = {
    getState() {
      return state
    },
    subscribe(listener) {
      listeners.add(listener)
      listener({ type: 'state', state })
      const unsubscribe: Unsubscribe = () => listeners.delete(listener)
      return unsubscribe
    },
    dispatch(command) {
      options.onCommand(command)
    },
  }

  /**
   * 由游戏侧调用，用于推送新的状态快照。
   */
  function setState(next: GameUIState) {
    state = next
    emit({ type: 'state', state })
  }

  /**
   * 由游戏侧调用，用于推送短消息提示。
   */
  function emitMessage(text: string) {
    emit({ type: 'message', text })
  }

  /**
   * 销毁桥接层：清理全部订阅者，避免页面卸载后泄漏。
   */
  function destroy() {
    listeners.clear()
  }

  return { bridge, setState, emitMessage, destroy }
}
