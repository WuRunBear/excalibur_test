import { defineComponent } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('@pixelium/web-vue/es', () => {
  const Button = defineComponent({ name: 'PxButton', template: '<button></button>' })
  const Avatar = defineComponent({ name: 'PxAvatar', template: '<div></div>' })
  return { Button, Avatar }
})

const StatusStripStub = defineComponent({
  name: 'StatusStrip',
  props: {
    hp: { type: Number, required: true },
    hpMax: { type: Number, required: true },
    needs: { type: Array, required: true },
    hour: { type: Number, required: true },
    phase: { type: Number, required: true },
  },
  emits: ['openSettings'],
  template: '<div data-test="status-strip"></div>',
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

const InventoryPanelStub = defineComponent({
  name: 'InventoryPanel',
  template: '<div data-test="inventory-panel"></div>',
})

const CraftPanelStub = defineComponent({
  name: 'CraftPanel',
  template: '<div data-test="craft-panel"></div>',
})

async function mountGameUI() {
  const { default: GameUI } = await import('../Index.vue')
  return mount(GameUI, {
    slots: { content: '<div data-test="content"></div>' },
    global: {
      stubs: {
        StatusStrip: StatusStripStub,
        ActionBar: ActionBarStub,
        MiniMapPanel: MiniMapPanelStub,
        QuestPanel: QuestPanelStub,
        CraftPanel: CraftPanelStub,
        DialoguePanel: true,
        InventoryPanel: InventoryPanelStub,
        SettingsModal: SettingsModalStub,
      },
    },
  })
}

describe('GameUI', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

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

    wrapper.findComponent(StatusStripStub).vm.$emit('openSettings')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-test="settings"]').exists()).toBe(true)
    const debug = wrapper.findComponent(SettingsModalStub).props('debug')
    expect(debug).toBeDefined()
    expect(debug.enabled).toBe(false)
  })

  it('背包与合成互斥', async () => {
    // 面板在 <Transition name="panel"> 内，DOM 移除依赖 150ms leave 过渡：
    // 用假定时器推进过渡回调，避免负向 DOM 断言不稳
    vi.useFakeTimers()
    const wrapper = await mountGameUI()
    const vm = wrapper.vm as unknown as { showInventory: boolean; showCraft: boolean }

    await wrapper.find('[aria-label="背包"]').trigger('click')

    expect(vm.showInventory).toBe(true)
    expect(wrapper.findComponent(InventoryPanelStub).exists()).toBe(true)

    await wrapper.find('[aria-label="合成"]').trigger('click')
    vi.advanceTimersByTime(300)
    await wrapper.vm.$nextTick()

    expect(vm.showInventory).toBe(false)
    expect(vm.showCraft).toBe(true)
    expect(wrapper.findComponent(InventoryPanelStub).exists()).toBe(false)
    expect(wrapper.findComponent(CraftPanelStub).exists()).toBe(true)

    await wrapper.find('[aria-label="合成"]').trigger('click')
    vi.advanceTimersByTime(300)
    await wrapper.vm.$nextTick()

    expect(vm.showCraft).toBe(false)
  })

  it('状态条齿轮打开设置', async () => {
    const wrapper = await mountGameUI()

    wrapper.findComponent(StatusStripStub).vm.$emit('openSettings')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-test="settings"]').exists()).toBe(true)
  })
})
