import type { GameBridge, GameCommand, GameUIEvent, GameUIState, Unsubscribe } from './type'

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

  function setState(next: GameUIState) {
    state = next
    emit({ type: 'state', state })
  }

  function emitMessage(text: string) {
    emit({ type: 'message', text })
  }

  function destroy() {
    listeners.clear()
  }

  return { bridge, setState, emitMessage, destroy }
}
