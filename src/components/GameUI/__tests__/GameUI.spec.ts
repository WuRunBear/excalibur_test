import { defineComponent } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('@pixelium/web-vue/es', () => {
  const Button = defineComponent({ name: 'PxButton', template: '<button></button>' })
  const Avatar = defineComponent({ name: 'PxAvatar', template: '<div></div>' })
  return { Button, Avatar }
})

const PlayerStatusPanelStub = defineComponent({
  name: 'PlayerStatusPanel',
  props: {
    playerName: { type: String, required: true },
    zone: { type: String, required: true },
    hp: { type: Number, required: true },
    hpMax: { type: Number, required: true },
    needs: { type: Array, required: true },
    hour: { type: Number, required: true },
    phase: { type: Number, required: true },
  },
  emits: ['openSettings'],
  template: '<div data-test="player-status"></div>',
})

const ActionBarStub = defineComponent({
  name: 'ActionBar',
  props: {
    inventory: { type: Array, required: true },
    activeSlot: { type: Number, required: true },
  },
  emits: ['useItem'],
  template: '<div data-test="action-bar"></div>',
})

const MiniMapPanelStub = defineComponent({
  name: 'MiniMapPanel',
  emits: ['close'],
  template: '<div data-test="mini-map"></div>',
})

const QuestPanelStub = defineComponent({
  name: 'QuestPanel',
  emits: ['toggleCollapse'],
  props: {
    collapsed: { type: Boolean, required: true },
    quests: { type: Array, required: true },
  },
  template: '<div data-test="quest"></div>',
})

const SettingsModalStub = defineComponent({
  name: 'SettingsModal',
  emits: [
    'close',
    'reset',
    'save',
    'updateQuality',
    'updateVolume',
    'toggleDebugEnabled',
    'toggleMapColliders',
    'toggleEntityColliders',
    'toggleAutoRefresh',
    'refreshDebug',
  ],
  props: {
    graphicsQuality: { type: String, required: true },
    graphicsQualityLabel: { type: String, required: true },
    volume: { type: Number, required: true },
    debug: { type: Object, required: true },
  },
  template: '<div data-test="settings"></div>',
})

async function mountGameUI() {
  const { default: GameUI } = await import('../Index.vue')
  return mount(GameUI, {
    slots: { content: '<div data-test="content"></div>' },
    global: {
      stubs: {
        PlayerStatusPanel: PlayerStatusPanelStub,
        ActionBar: ActionBarStub,
        MiniMapPanel: MiniMapPanelStub,
        QuestPanel: QuestPanelStub,
        CraftPanel: true,
        DialoguePanel: true,
        InventoryPanel: true,
        SettingsModal: SettingsModalStub,
      },
    },
  })
}

describe('GameUI', () => {
  it('默认显示小地图并可通过事件隐藏', async () => {
    const wrapper = await mountGameUI()

    expect(wrapper.find('[data-test="mini-map"]').exists()).toBe(true)

    wrapper.findComponent(MiniMapPanelStub).vm.$emit('close')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-test="mini-map"]').exists()).toBe(false)
  })

  it('任务面板默认折叠，可切换', async () => {
    const wrapper = await mountGameUI()

    expect(wrapper.findComponent(QuestPanelStub).props('collapsed')).toBe(true)

    wrapper.findComponent(QuestPanelStub).vm.$emit('toggleCollapse')
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent(QuestPanelStub).props('collapsed')).toBe(false)
  })

  it('打开设置弹窗并传递 debug 状态', async () => {
    const wrapper = await mountGameUI()

    wrapper.findComponent(PlayerStatusPanelStub).vm.$emit('openSettings')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-test="settings"]').exists()).toBe(true)
    const debug = wrapper.findComponent(SettingsModalStub).props('debug')
    expect(debug).toBeDefined()
    expect(debug.enabled).toBe(false)
  })
})
