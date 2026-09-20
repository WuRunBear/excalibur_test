import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import QuestPanel from '../QuestPanel.vue'

function makeQuest(questId = '采集木材', state = 1, count = 2) {
  return { questId, state, count }
}

const GOAL_ROW = '.flex.items-center.justify-between.gap-1.px-2.py-1.text-xs'

afterEach(() => {
  vi.useRealTimers()
})

describe('QuestPanel', () => {
  it('折叠态显示单行当前目标', () => {
    const wrapper = mount(QuestPanel, {
      props: {
        collapsed: true,
        quests: [makeQuest()],
      },
    })

    expect(wrapper.text()).toContain('采集木材')
    expect(wrapper.text()).toContain('2')
    expect(wrapper.text()).not.toContain('暂无任务')
  })

  it('展开态显示完整任务列表', () => {
    const wrapper = mount(QuestPanel, {
      props: {
        collapsed: false,
        quests: [
          makeQuest('采集木材', 1, 2),
          makeQuest('击杀野猪', 2, 5),
          makeQuest('未接取任务', 0, 0),
        ],
      },
    })

    expect(wrapper.text()).toContain('采集木材')
    expect(wrapper.text()).toContain('击杀野猪')
    expect(wrapper.text()).toContain('可交 5')
    // state === 0 的任务不属于 activeQuests，不应渲染
    expect(wrapper.text()).not.toContain('未接取任务')
  })

  it('无任务时折叠态显示暂无任务', () => {
    const wrapper = mount(QuestPanel, {
      props: { collapsed: true, quests: [] },
    })

    expect(wrapper.text()).toContain('暂无任务')
  })

  it('首个目标变化时闪烁高亮并自动恢复', async () => {
    vi.useFakeTimers()
    const wrapper = mount(QuestPanel, {
      props: {
        collapsed: true,
        quests: [makeQuest()],
      },
    })

    // 初始挂载不应触发闪烁
    expect(wrapper.find(GOAL_ROW).classes()).not.toContain('border-px-notice')

    // 改变引用并更新 props（count 变化）→ 触发 watch
    await wrapper.setProps({ quests: [makeQuest('采集木材', 1, 3)] })

    expect(wrapper.find(GOAL_ROW).classes()).toContain('border-px-notice')

    // 1200ms 后闪烁结束
    vi.advanceTimersByTime(1200)
    await wrapper.vm.$nextTick()

    expect(wrapper.find(GOAL_ROW).classes()).not.toContain('border-px-notice')
  })
})
