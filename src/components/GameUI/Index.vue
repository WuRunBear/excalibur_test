<template>
  <div class="relative inline-block select-none">
    <slot
      name="content"
      :slotClass="['block', 'relative', 'z-0', 'rounded-lg']"
    ></slot>

    <div
      class="absolute inset-0 z-[1] pointer-events-none"
      :class="{ 'opacity-90': isNightDim }"
    >
      <!-- 左上：角色状态 + 任务面板 -->
      <div class="absolute left-2 top-2 grid gap-1 pointer-events-auto">
        <PlayerStatusPanel
          :player-name="playerName"
          :zone="zone"
          :hp="hp"
          :hp-max="hpMax"
          :needs="needs"
          :hour="hour"
          :phase="phase"
          @open-settings="showSettings = true"
        />

        <QuestPanel
          :collapsed="questCollapsed"
          :quests="quests"
          @toggle-collapse="questCollapsed = !questCollapsed"
        />
      </div>

      <!-- 右上：小地图 -->
      <div
        v-if="showMiniMap"
        class="absolute right-2 top-2 pointer-events-auto"
      >
        <MiniMapPanel @close="showMiniMap = false" />
      </div>

      <!-- 左侧中部：背包 / 合成 -->
      <div class="absolute left-2 top-1/2 -translate-y-1/2 grid gap-1 pointer-events-auto">
        <button
          class="flex h-8 w-8 items-center justify-center rounded border border-neutral-700/50 bg-black/60 text-sm backdrop-blur hover:border-neutral-400 cursor-pointer"
          :title="showInventory ? '关闭背包' : '打开背包'"
          @click="showInventory = !showInventory"
        >
          🎒
        </button>
        <button
          class="flex h-8 w-8 items-center justify-center rounded border border-neutral-700/50 bg-black/60 text-sm backdrop-blur hover:border-neutral-400 cursor-pointer"
          :title="showCraft ? '关闭合成' : '打开合成 (C)'"
          @click="showCraft = !showCraft"
        >
          🔨
        </button>
      </div>

      <div
        v-if="showInventory"
        class="absolute left-12 top-1/2 -translate-y-1/2 pointer-events-auto"
      >
        <InventoryPanel
          :inventory="inventory"
          :equipment="equipment"
          :selected-slot="activeSlot"
          @close="showInventory = false"
          @use-item="dispatch({ type: 'useItem', slot: $event })"
          @drop-item="dispatch({ type: 'dropItem', slot: $event })"
          @transfer-item="
            dispatch({ type: 'transferItem', slot: $event.slot, toSlot: $event.toSlot })
          "
        />
      </div>

      <div
        v-if="showCraft"
        class="absolute left-12 top-1/2 -translate-y-1/2 pointer-events-auto"
      >
        <CraftPanel
          @close="showCraft = false"
          @craft-item="dispatch({ type: 'craftItem', recipe: $event })"
        />
      </div>

      <!-- 对话 -->
      <div
        v-if="dialogue && !dialogueDismissed"
        class="absolute bottom-16 left-1/2 -translate-x-1/2 pointer-events-auto"
      >
        <DialoguePanel
          :dialogue="dialogue"
          @close="dialogueDismissed = true"
          @dialogue-select="dispatch({ type: 'dialogueSelect', option: $event })"
        />
      </div>

      <!-- 底部：物品快捷栏 -->
      <div class="pointer-events-auto">
        <ActionBar
          :inventory="inventory"
          :active-slot="activeSlot"
          @use-item="dispatch({ type: 'useItem', slot: $event })"
        />
      </div>

      <!-- 设置弹窗 -->
      <SettingsModal
        v-if="showSettings"
        :graphics-quality="graphicsQuality"
        :graphics-quality-label="graphicsQualityLabel"
        :volume="volume"
        :debug="debugState"
        @close="showSettings = false"
        @reset="resetSettings"
        @save="showSettings = false"
        @updateQuality="graphicsQuality = $event"
        @updateVolume="volume = $event"
        @toggle-debug-enabled="toggleDebugEnabled"
        @toggle-map-colliders="toggleMapColliders"
        @toggle-entity-colliders="toggleEntityColliders"
        @toggle-auto-refresh="toggleAutoRefresh"
        @refresh-debug="refreshDebug"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'GameUI' })

import type { GameBridge, GameDebugState, GameUIEvent } from 'game/type'
import { computed, ref, watchEffect } from 'vue'
import ActionBar from './components/ActionBar.vue'
import CraftPanel from './components/CraftPanel.vue'
import DialoguePanel from './components/DialoguePanel.vue'
import InventoryPanel from './components/InventoryPanel.vue'
import MiniMapPanel from './components/MiniMapPanel.vue'
import PlayerStatusPanel from './components/PlayerStatusPanel.vue'
import QuestPanel from './components/QuestPanel.vue'
import SettingsModal from './components/SettingsModal.vue'

const props = defineProps<{
  bridge?: GameBridge
}>()

const playerName = ref('-')
const zone = ref('')
const hp = ref(0)
const hpMax = ref(100)
const needs = ref<Array<{ name: string; current: number; max: number }>>([])
const inventory = ref<Array<{ kind: string; count: number }>>([])
const equipment = ref<{ weaponSlot: number; toolSlot: number; armorSlot: number }>({
  weaponSlot: -1,
  toolSlot: -1,
  armorSlot: -1,
})
const quests = ref<Array<{ questId: string; state: number; count: number }>>([])
const dialogue = ref<{ npcId: number; treeId: string; nodeId: string; options: string[] } | null>(
  null,
)
const hour = ref(8)
const phase = ref(0)
const activeSlot = ref(0)

const showMiniMap = ref(true)
const showSettings = ref(false)
const showInventory = ref(false)
const showCraft = ref(false)
const questCollapsed = ref(true)
const dialogueDismissed = ref(false)
let lastDialogueKey = ''

const debugState = ref<GameDebugState>({
  enabled: false,
  showMapColliders: true,
  showEntityColliders: true,
  autoRefresh: true,
  colliderCount: 0,
  pairCount: 0,
  tick: 0,
})

const graphicsQuality = ref<'low' | 'medium' | 'high'>('high')
const volume = ref(70)

const graphicsQualityLabel = computed(() => {
  if (graphicsQuality.value === 'low') return '低'
  if (graphicsQuality.value === 'medium') return '中'
  return '高'
})

const isNightDim = computed(() => {
  const night = phase.value === 1 || hour.value < 5 || hour.value >= 19
  return night ? 'night' : ''
})

function dispatch(command: Parameters<GameBridge['dispatch']>[0]) {
  if (props.bridge) {
    props.bridge.dispatch(command)
  }
}

function applyGameEvent(event: GameUIEvent) {
  if (event.type === 'message') return

  const state = event.state
  hp.value = state.stats.hp
  hpMax.value = state.stats.hpMax
  playerName.value = state.stats.name
  zone.value = state.world.mapId
  needs.value = state.needs
  inventory.value = state.inventory
  equipment.value = state.equipment
  quests.value = state.quests
  hour.value = state.world.hour
  phase.value = state.world.phase
  debugState.value = state.debug

  if (state.dialogue) {
    const key = `${state.dialogue.treeId}|${state.dialogue.nodeId}`
    if (key !== lastDialogueKey) {
      dialogueDismissed.value = false
      lastDialogueKey = key
    }
    dialogue.value = state.dialogue
  } else {
    dialogue.value = null
  }
}

watchEffect((onCleanup) => {
  if (!props.bridge) return
  const unsubscribe = props.bridge.subscribe(applyGameEvent)
  onCleanup(() => unsubscribe())
})

function resetSettings() {
  graphicsQuality.value = 'high'
  volume.value = 70
}

function toggleDebugEnabled() {
  dispatch({ type: 'setDebugOptions', value: { enabled: !debugState.value.enabled } })
}

function toggleMapColliders() {
  dispatch({
    type: 'setDebugOptions',
    value: { showMapColliders: !debugState.value.showMapColliders },
  })
}

function toggleEntityColliders() {
  dispatch({
    type: 'setDebugOptions',
    value: { showEntityColliders: !debugState.value.showEntityColliders },
  })
}

function toggleAutoRefresh() {
  dispatch({ type: 'setDebugOptions', value: { autoRefresh: !debugState.value.autoRefresh } })
}

function refreshDebug() {
  dispatch({ type: 'refreshDebugOverlay' })
}
</script>
