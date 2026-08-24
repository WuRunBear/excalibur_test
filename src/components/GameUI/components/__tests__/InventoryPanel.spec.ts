import { defineComponent } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { IconMoon, IconSun } from '@pixelium/web-vue/icon-pa/es'
import InventoryPanel from '../InventoryPanel.vue'

// 真实 Button/Progress 使用 canvas 绘制，jsdom 无 canvas 实现会在挂载时抛出
// "Not implemented: HTMLCanvasElement.prototype.getContext" 噪音（用例仍会通过），
// 故按 GameUI.spec.ts:5-9 的既有模式本地 stub，仅替换绘制组件，不替换图标。
vi.mock('@pixelium/web-vue/es', () => {
  const Button = defineComponent({ name: 'PxButton', template: '<button></button>' })
  const Progress = defineComponent({
    name: 'PxProgress',
    props: {
      percentage: { type: Number, default: 0 },
      theme: { type: String, default: 'primary' },
      size: { type: [Number, String], default: 'medium' },
    },
    template: '<div class="px-progress"></div>',
  })
  return { Button, Progress }
})

function mountPanel(props: Record<string, unknown>) {
  return mount(InventoryPanel, {
    props: {
      inventory: [],
      equipment: { weaponSlot: -1, toolSlot: -1, armorSlot: -1 },
      ...props,
    },
  })
}

describe('InventoryPanel', () => {
  it('renders player info when optional props are provided (no NaN)', () => {
    const wrapper = mountPanel({
      playerName: '测试玩家',
      zone: 'demo',
      hp: 50,
      hpMax: 100,
      hour: 10,
      phase: 0,
    })

    const text = wrapper.text()
    expect(text).toContain('测试玩家')
    expect(text).toContain('demo')
    expect(text).toContain('10:00')
    expect(wrapper.findComponent(IconSun).exists()).toBe(true)
    expect(wrapper.findComponent(IconMoon).exists()).toBe(false)
    expect(text).not.toContain('NaN')
  })

  it('does not render NaN when optional props are absent (fallbacks work)', () => {
    const wrapper = mountPanel({})

    const text = wrapper.text()
    expect(text).not.toContain('NaN')
    expect(text).toContain('00:00')
  })

  it('shows moon icon at night (phase=1 or hour>=19)', () => {
    const wrapper = mountPanel({
      playerName: '夜行侠',
      hp: 5,
      hpMax: 100,
      hour: 21,
      phase: 0,
    })

    expect(wrapper.findComponent(IconMoon).exists()).toBe(true)
    expect(wrapper.findComponent(IconSun).exists()).toBe(false)
    expect(wrapper.text()).not.toContain('NaN')
  })
})
