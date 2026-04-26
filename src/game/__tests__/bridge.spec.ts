import { describe, expect, it, vi } from 'vitest'

import { createGameBridge } from '../bridge'
import type { GameUIState } from '../type'

function createInitialState(): GameUIState {
  return {
    fps: 60,
    isPaused: false,
    player: { x: 0, y: 0, facing: '下' },
    stats: {
      name: 'tester',
      zone: 'zone',
      level: 1,
      hp: 10,
      hpMax: 10,
      mp: 5,
      mpMax: 5,
      coins: 0,
    },
  }
}

describe('createGameBridge', () => {
  it('subscribe 时会立刻收到一次 state 事件，并且能收到后续更新', () => {
    const onCommand = vi.fn()
    const { bridge, setState } = createGameBridge({ initialState: createInitialState(), onCommand })

    const events: unknown[] = []
    const unsub = bridge.subscribe((e) => events.push(e))

    expect(events.length).toBe(1)
    expect(events[0]).toMatchObject({ type: 'state' })

    setState({ ...createInitialState(), fps: 30 })
    expect(events.length).toBe(2)
    expect(events[1]).toMatchObject({ type: 'state', state: { fps: 30 } })

    unsub()
    setState({ ...createInitialState(), fps: 10 })
    expect(events.length).toBe(2)
  })

  it('dispatch 会转发到 onCommand', () => {
    const onCommand = vi.fn()
    const { bridge } = createGameBridge({ initialState: createInitialState(), onCommand })

    bridge.dispatch({ type: 'togglePause' })
    expect(onCommand).toHaveBeenCalledWith({ type: 'togglePause' })
  })
})
