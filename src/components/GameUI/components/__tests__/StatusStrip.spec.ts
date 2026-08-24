import { defineComponent } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import StatusStrip from '../StatusStrip.vue'

vi.mock('@pixelium/web-vue/es', () => {
  const Button = defineComponent({ name: 'PxButton', template: '<button></button>' })
  const Progress = defineComponent({ name: 'PxProgress', template: '<div></div>' })
  return { Button, Progress }
})

describe('StatusStrip', () => {
  it('渲染 HP 数字、需求图标与时钟文本', () => {
    const wrapper = mount(StatusStrip, {
      props: {
        hp: 42,
        hpMax: 100,
        needs: [{ name: 'hunger', current: 4, max: 5 }],
        hour: 10,
        phase: 0,
      },
    })

    expect(wrapper.text()).toContain('42')
    expect(wrapper.text()).toContain('🍗')
    expect(wrapper.text()).toContain('10:00')
  })

  it('点击设置按钮触发 openSettings 事件', async () => {
    const wrapper = mount(StatusStrip, {
      props: {
        hp: 42,
        hpMax: 100,
        needs: [],
        hour: 10,
        phase: 0,
      },
    })

    await wrapper.find('[aria-label="设置"]').trigger('click')
    expect(wrapper.emitted('openSettings')).toBeTruthy()
  })

  it('hpMax=0 时 hpPercent 为 0（不除以零）', () => {
    const wrapper = mount(StatusStrip, {
      props: {
        hp: 0,
        hpMax: 0,
        needs: [],
        hour: 10,
        phase: 0,
      },
    })

    expect(wrapper.vm.hpPercent).toBe(0)
  })
})
