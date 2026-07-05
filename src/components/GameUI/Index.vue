<template>
  <div class="relative inline-block select-none">
    <slot
      name="content"
      :slotClass="['block', 'relative', 'z-0', 'rounded-lg']"
    ></slot>

    <div class="absolute inset-0 z-[1] pointer-events-none">
      <!-- 左上：角色状态 + 任务面板 -->
      <div class="absolute left-2 top-2 grid gap-1 pointer-events-auto">
        <PlayerStatusPanel
          :player-name="playerName"
          :zone="zone"
          :level="level"
          :hp="hp"
          :hp-max="hpMax"
          :mp="mp"
          :mp-max="mpMax"
          :coins="coins"
          @open-settings="showSettings = true"
        />

        <QuestPanel
          :collapsed="questCollapsed"
          :active-quest="activeQuest"
          :quest-desc="questDesc"
          :quest-progress="questProgress"
          :quest-goal="questGoal"
          :quest-percent="questPercent"
          @toggle-collapse="questCollapsed = !questCollapsed"
          @advance="advanceQuest"
          @complete="completeQuest"
        />
      </div>

      <!-- 右上：小地图 -->
      <div v-if="showMiniMap" class="absolute right-2 top-2 pointer-events-auto">
        <MiniMapPanel @close="showMiniMap = false" />
      </div>

      <!-- 底部：物品快捷栏 -->
      <ActionBar />

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
import MiniMapPanel from './components/MiniMapPanel.vue'
import PlayerStatusPanel from './components/PlayerStatusPanel.vue'
import QuestPanel from './components/QuestPanel.vue'
import SettingsModal from './components/SettingsModal.vue'

const props = defineProps<{
  bridge?: GameBridge
}>()

const playerName = ref('测试玩家')
const zone = ref('新手村')
const level = ref(7)

const hpMax = ref(100)
const mpMax = ref(80)

const hp = ref(86)
const mp = ref(52)
const coins = ref(128)

const showMiniMap = ref(true)
const showSettings = ref(false)
const questCollapsed = ref(true)

const debugState = ref<GameDebugState>({
  enabled: false,
  showMapColliders: true,
  showEntityColliders: true,
  autoRefresh: true,
  colliderCount: 0,
  pairCount: 0,
  tick: 0,
})

const activeQuest = ref('寻找遗失的齿轮')
const questDesc = ref('收集 5 个齿轮并返回村口。')
const questGoal = 5
const questProgress = ref(2)

const graphicsQuality = ref<'low' | 'medium' | 'high'>('high')
const volume = ref(70)

const graphicsQualityLabel = computed(() => {
  if (graphicsQuality.value === 'low') return '低'
  if (graphicsQuality.value === 'medium') return '中'
  return '高'
})

const questPercent = computed(() =>
  Math.max(0, Math.min(100, (questProgress.value / questGoal) * 100)),
)

function applyGameEvent(event: GameUIEvent) {
  if (event.type === 'message') return

  const state = event.state
  hp.value = state.stats.hp
  mp.value = state.stats.mp
  coins.value = state.stats.coins
  playerName.value = state.stats.name
  zone.value = state.stats.zone
  level.value = state.stats.level
  hpMax.value = state.stats.hpMax
  mpMax.value = state.stats.mpMax
  debugState.value = state.debug
}

watchEffect((onCleanup) => {
  if (!props.bridge) return
  const unsubscribe = props.bridge.subscribe(applyGameEvent)
  onCleanup(() => unsubscribe())
})

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function advanceQuest() {
  questProgress.value = clamp(questProgress.value + 1, 0, questGoal)
}

function completeQuest() {
  questProgress.value = questGoal
  coins.value += 100
}

function resetSettings() {
  graphicsQuality.value = 'high'
  volume.value = 70
}

function toggleDebugEnabled() {
  if (props.bridge) {
    props.bridge.dispatch({ type: 'setDebugOptions', value: { enabled: !debugState.value.enabled } })
    return
  }
  debugState.value = { ...debugState.value, enabled: !debugState.value.enabled }
}

function toggleMapColliders() {
  if (props.bridge) {
    props.bridge.dispatch({ type: 'setDebugOptions', value: { showMapColliders: !debugState.value.showMapColliders } })
    return
  }
  debugState.value = { ...debugState.value, showMapColliders: !debugState.value.showMapColliders }
}

function toggleEntityColliders() {
  if (props.bridge) {
    props.bridge.dispatch({ type: 'setDebugOptions', value: { showEntityColliders: !debugState.value.showEntityColliders } })
    return
  }
  debugState.value = { ...debugState.value, showEntityColliders: !debugState.value.showEntityColliders }
}

function toggleAutoRefresh() {
  if (props.bridge) {
    props.bridge.dispatch({ type: 'setDebugOptions', value: { autoRefresh: !debugState.value.autoRefresh } })
    return
  }
  debugState.value = { ...debugState.value, autoRefresh: !debugState.value.autoRefresh }
}

function refreshDebug() {
  if (props.bridge) {
    props.bridge.dispatch({ type: 'refreshDebugOverlay' })
  }
}
</script>
