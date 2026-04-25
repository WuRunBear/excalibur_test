import { defineComponent } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('@pixelium/web-vue/es', () => {
  const Button = defineComponent({
    name: 'PxButton',
    template: '<button></button>',
  })
  const DropDown = defineComponent({
    name: 'PxDropDown',
    template: '<div></div>',
  })
  const Avatar = defineComponent({
    name: 'PxAvatar',
    template: '<div></div>',
  })

  return { Button, DropDown, Avatar }
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
  template: '<div data-test="player-status"></div>',
})

const ActionBarStub = defineComponent({
  name: 'ActionBar',
  emits: [
    'toggleMiniMap',
    'toggleQuestPanel',
    'dealDamage',
    'heal',
    'spendMana',
    'recoverMana',
    'earnCoins',
  ],
  props: {
    showQuestPanel: { type: Boolean, required: true },
    showMiniMap: { type: Boolean, required: true },
  },
  template: '<div data-test="action-bar"></div>',
})

const MiniMapPanelStub = defineComponent({
  name: 'MiniMapPanel',
  emits: ['close'],
  template: '<div data-test="mini-map"></div>',
})

const MessagePanelStub = defineComponent({
  name: 'MessagePanel',
  emits: ['add'],
  props: {
    messages: { type: Array, required: true },
  },
  template: '<div data-test="messages"></div>',
})

const ControlPanelStub = defineComponent({
  name: 'ControlPanel',
  emits: ['togglePause', 'reset', 'openSettings', 'toggleDebug', 'clearMessages'],
  props: {
    isPaused: { type: Boolean, required: true },
    showDebug: { type: Boolean, required: true },
    fps: { type: Number, required: true },
    position: { type: Object, required: true },
    facing: { type: String, required: true },
    activeQuest: { type: String, required: true },
  },
  template: '<div data-test="control-panel"></div>',
})

const QuestPanelStub = defineComponent({
  name: 'QuestPanel',
  emits: ['close', 'advance', 'complete'],
  props: {
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

const TipsPanelStub = defineComponent({
  name: 'TipsPanel',
  template: '<div data-test="tips"></div>',
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
        ControlPanel: ControlPanelStub,
        MessagePanel: MessagePanelStub,
        ActionBar: ActionBarStub,
        MiniMapPanel: MiniMapPanelStub,
        QuestPanel: QuestPanelStub,
        SettingsModal: SettingsModalStub,
        TipsPanel: TipsPanelStub,
      },
    },
  })
}

describe('GameUI', () => {
  it('默认显示小地图，并能通过 ActionBar 事件切换', async () => {
    const wrapper = await mountGameUI()

    expect(wrapper.find('[data-test="mini-map"]').exists()).toBe(true)

    wrapper.findComponent(ActionBarStub).vm.$emit('toggleMiniMap')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-test="mini-map"]').exists()).toBe(false)
  })

  it('能响应 ActionBar 的伤害事件并更新玩家血量', async () => {
    const wrapper = await mountGameUI()

    const beforeHp = wrapper.findComponent(PlayerStatusPanelStub).props('hp')
    wrapper.findComponent(ActionBarStub).vm.$emit('dealDamage')
    await wrapper.vm.$nextTick()

    const afterHp = wrapper.findComponent(PlayerStatusPanelStub).props('hp')
    expect(typeof beforeHp).toBe('number')
    expect(typeof afterHp).toBe('number')
    expect(afterHp).toBeLessThan(beforeHp)
  })

  it('能通过 MessagePanel 的 add 事件追加消息并限制数量', async () => {
    const wrapper = await mountGameUI()

    for (let i = 0; i < 40; i += 1) {
      wrapper.findComponent(MessagePanelStub).vm.$emit('add', `msg-${i}`)
      await wrapper.vm.$nextTick()
    }

    const messages = wrapper.findComponent(MessagePanelStub).props('messages') as unknown[]
    expect(messages.length).toBe(30)
  })
})
