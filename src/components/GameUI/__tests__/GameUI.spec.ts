import { defineComponent } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('@pixelium/web-vue/es', () => {
  const Button = defineComponent({
    name: 'PxButton',
    template: '<button></button>',
  })
  const Avatar = defineComponent({
    name: 'PxAvatar',
    template: '<div></div>',
  })

  return { Button, Avatar }
})

const PlayerStatusPanelStub = defineComponent({
  name: 'PlayerStatusPanel',
  props: {
    playerName: { type: String, required: true },
    zone: { type: String, required: true },
    level: { type: Number, required: true },
    hp: { type: Number, required: true },
    hpMax: { type: Number, required: true },
    mp: { type: Number, required: true },
    mpMax: { type: Number, required: true },
    coins: { type: Number, required: true },
  },
  emits: ['openSettings'],
  template: '<div data-test="player-status"></div>',
})

const ActionBarStub = defineComponent({
  name: 'ActionBar',
  template: '<div data-test="action-bar"></div>',
})

const MiniMapPanelStub = defineComponent({
  name: 'MiniMapPanel',
  emits: ['close'],
  template: '<div data-test="mini-map"></div>',
})

const QuestPanelStub = defineComponent({
  name: 'QuestPanel',
  emits: ['toggleCollapse', 'advance', 'complete'],
  props: {
    collapsed: { type: Boolean, required: true },
    activeQuest: { type: String, required: true },
    questDesc: { type: String, required: true },
    questProgress: { type: Number, required: true },
    questGoal: { type: Number, required: true },
    questPercent: { type: Number, required: true },
  },
  template: '<div data-test="quest"></div>',
})

const SettingsModalStub = defineComponent({
  name: 'SettingsModal',
  emits: ['close', 'reset', 'save', 'updateQuality', 'updateVolume'],
  props: {
    graphicsQuality: { type: String, required: true },
    graphicsQualityLabel: { type: String, required: true },
    volume: { type: Number, required: true },
  },
  template: '<div data-test="settings"></div>',
})

async function mountGameUI() {
  const { default: GameUI } = await import('../Index.vue')
  return mount(GameUI, {
    slots: {
      content: '<div data-test="content"></div>',
    },
    global: {
      stubs: {
        PlayerStatusPanel: PlayerStatusPanelStub,
        ActionBar: ActionBarStub,
        MiniMapPanel: MiniMapPanelStub,
        QuestPanel: QuestPanelStub,
        SettingsModal: SettingsModalStub,
      },
    },
  })
}

describe('GameUI', () => {
  it('默认显示小地图，并能通过 MiniMapPanel 关闭事件隐藏', async () => {
    const wrapper = await mountGameUI()

    expect(wrapper.find('[data-test="mini-map"]').exists()).toBe(true)

    wrapper.findComponent(MiniMapPanelStub).vm.$emit('close')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-test="mini-map"]').exists()).toBe(false)
  })

  it('能通过 QuestPanel 的 toggleCollapse 事件切换折叠状态', async () => {
    const wrapper = await mountGameUI()

    expect(wrapper.findComponent(QuestPanelStub).props('collapsed')).toBe(false)

    wrapper.findComponent(QuestPanelStub).vm.$emit('toggleCollapse')
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent(QuestPanelStub).props('collapsed')).toBe(true)
  })
})
