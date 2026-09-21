import { describe, expect, it, vi } from 'vitest'

import { createGameBridge } from '../bridge'
import type { GameUIState } from '../type'

function createInitialState(): GameUIState {
  return {
    fps: 60,
    isPaused: false,
    player: { x: 0, y: 0, facing: '下' },
    world: { hour: 8, phase: 0, mapId: 'generated-map' },
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
    needs: [{ name: 'hunger', current: 80, max: 100 }],
    inventory: Array.from({ length: 12 }, (_, i) => ({
      kind: i === 0 ? 'wood' : '',
      count: i === 0 ? 3 : 0,
    })),
    equipment: { weaponSlot: -1, toolSlot: -1, armorSlot: -1 },
    quests: [],
    dialogue: null,
    debug: {
      enabled: false,
      showMapColliders: true,
      showEntityColliders: true,
      autoRefresh: true,
      colliderCount: 0,
      pairCount: 0,
      tick: 0,
    },
  }
}

describe('createGameBridge', () => {
  it('subscribe 时会立刻收到 state 与 connection 事件，并且能收到后续更新', () => {
    const onCommand = vi.fn()
    const { bridge, setState } = createGameBridge({ initialState: createInitialState(), onCommand })

    const events: Parameters<typeof bridge.subscribe>[0][] = []
    const unsub = bridge.subscribe((e) => events.push(e))

    // state + connection（当前连接状态）各推送一次
    expect(events.length).toBe(2)
    expect(events[0]).toMatchObject({ type: 'state' })
    expect(events[1]).toMatchObject({ type: 'connection', status: 'idle' })

    setState({ ...createInitialState(), fps: 30 })
    expect(events.length).toBe(3)
    expect(events[2]).toMatchObject({ type: 'state', state: { fps: 30 } })

    unsub()
    setState({ ...createInitialState(), fps: 10 })
    expect(events.length).toBe(3)
  })

  it('emitConnectionStatus 推送连接状态，subscribe 立即补发最近一次状态', () => {
    const onCommand = vi.fn()
    const { bridge, emitConnectionStatus } = createGameBridge({
      initialState: createInitialState(),
      onCommand,
    })

    emitConnectionStatus('connecting')
    emitConnectionStatus('connected')

    const events: unknown[] = []
    bridge.subscribe((e) => events.push(e))
    // 订阅时立即推送当前状态（state + connection=connected）
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ type: 'connection', status: 'connected' })

    emitConnectionStatus('disconnected')
    expect(events).toHaveLength(3)
    expect(events[2]).toMatchObject({ type: 'connection', status: 'disconnected' })
  })

  it('dispatch 会转发到 onCommand', () => {
    const onCommand = vi.fn()
    const { bridge } = createGameBridge({ initialState: createInitialState(), onCommand })

    bridge.dispatch({ type: 'togglePause' })
    expect(onCommand).toHaveBeenCalledWith({ type: 'togglePause' })
  })
})
