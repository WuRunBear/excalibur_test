<template>
  <div class="relative inline-block select-none">
    <slot name="content" :slotClass="['block', 'relative', 'z-0', 'rounded-lg']"></slot>

    <div class="absolute inset-0 z-[1] pointer-events-none">
      <div class="absolute left-3 top-3 flex items-start gap-3 pointer-events-auto">
        <PlayerStatusPanel
          :player-name="playerName"
          :zone="zone"
          :level="level"
          :hp="hp"
          :hp-max="hpMax"
          :mp="mp"
          :mp-max="mpMax"
          :coins="coins"
        />

        <ControlPanel
          :is-paused="isPaused"
          :show-debug="showDebug"
          :fps="fps"
          :position="position"
          :facing="facing"
          :active-quest="activeQuest"
          @togglePause="togglePause"
          @reset="resetDemoState"
          @openSettings="showSettings = true"
          @toggleDebug="showDebug = !showDebug"
          @clearMessages="messages = []"
        />
      </div>

      <div class="absolute right-3 top-3 grid gap-2 pointer-events-auto">
        <TipsPanel />
        <MessagePanel :messages="messages" @add="pushMessage" />
      </div>

      <ActionBar
        :show-quest-panel="showQuestPanel"
        :show-mini-map="showMiniMap"
        @dealDamage="dealDamage"
        @heal="heal"
        @spendMana="spendMana"
        @recoverMana="recoverMana"
        @earnCoins="earnCoins"
        @toggleQuestPanel="toggleQuestPanel"
        @toggleMiniMap="toggleMiniMap"
      />

      <MiniMapPanel v-if="showMiniMap" @close="toggleMiniMap" />

      <QuestPanel
        v-if="showQuestPanel"
        :active-quest="activeQuest"
        :quest-desc="questDesc"
        :quest-progress="questProgress"
        :quest-goal="questGoal"
        :quest-percent="questPercent"
        @close="toggleQuestPanel"
        @advance="advanceQuest"
        @complete="completeQuest"
      />

      <SettingsModal
        v-if="showSettings"
        :graphics-quality="graphicsQuality"
        :graphics-quality-label="graphicsQualityLabel"
        :volume="volume"
        @close="showSettings = false"
        @reset="resetSettings"
        @save="showSettings = false"
        @updateQuality="graphicsQuality = $event"
        @updateVolume="volume = $event"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'GameUI' })

import { computed, ref } from 'vue'
import ActionBar from './components/ActionBar.vue'
import ControlPanel from './components/ControlPanel.vue'
import MessagePanel from './components/MessagePanel.vue'
import MiniMapPanel from './components/MiniMapPanel.vue'
import PlayerStatusPanel from './components/PlayerStatusPanel.vue'
import QuestPanel from './components/QuestPanel.vue'
import SettingsModal from './components/SettingsModal.vue'
import TipsPanel from './components/TipsPanel.vue'

const playerName = ref('测试玩家')
const zone = ref('新手村')
const level = ref(7)

const hpMax = 100
const mpMax = 80

const hp = ref(86)
const mp = ref(52)
const coins = ref(128)

const isPaused = ref(false)
const showMiniMap = ref(true)
const showQuestPanel = ref(false)
const showSettings = ref(false)
const showDebug = ref(false)

const fps = ref(60)
const position = ref({ x: 128, y: 64 })
const facing = ref<'上' | '下' | '左' | '右'>('下')

const activeQuest = ref('寻找遗失的齿轮')
const questDesc = ref('在地图上收集 5 个齿轮并返回村口交付。')
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

const messages = ref<{ id: string; text: string }[]>([])
let msgId = 0

function togglePause() {
  isPaused.value = !isPaused.value
}

function toggleMiniMap() {
  showMiniMap.value = !showMiniMap.value
}

function toggleQuestPanel() {
  showQuestPanel.value = !showQuestPanel.value
}

function resetDemoState() {
  hp.value = 86
  mp.value = 52
  coins.value = 128
  isPaused.value = false
  showMiniMap.value = true
  showQuestPanel.value = false
  showSettings.value = false
  showDebug.value = false
  questProgress.value = 2
  messages.value = []
  msgId = 0
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function dealDamage() {
  hp.value = clamp(hp.value - 12, 0, hpMax)
  pushMessage(`受到伤害 -12，生命剩余 ${hp.value}/${hpMax}`)
}

function heal() {
  hp.value = clamp(hp.value + 15, 0, hpMax)
  pushMessage(`使用治疗 +15，生命变为 ${hp.value}/${hpMax}`)
}

function spendMana() {
  if (mp.value <= 0) {
    pushMessage('能量不足，无法施法')
    return
  }
  mp.value = clamp(mp.value - 10, 0, mpMax)
  pushMessage(`施法消耗 -10，能量剩余 ${mp.value}/${mpMax}`)
}

function recoverMana() {
  mp.value = clamp(mp.value + 12, 0, mpMax)
  pushMessage(`回复能量 +12，能量变为 ${mp.value}/${mpMax}`)
}

function earnCoins() {
  coins.value += 25
  pushMessage(`拾取金币 +25，总计 ${coins.value}`)
}

function pushMessage(text?: string) {
  msgId += 1
  const now = new Date()
  const stamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const base = text ?? `新的事件已触发（${stamp}）`
  messages.value = [{ id: String(msgId), text: base }, ...messages.value].slice(0, 30)
}

function advanceQuest() {
  questProgress.value = clamp(questProgress.value + 1, 0, questGoal)
  pushMessage(`任务进度 +1（${questProgress.value}/${questGoal}）`)
}

function completeQuest() {
  questProgress.value = questGoal
  pushMessage('任务已完成：奖励 +100 金币')
  coins.value += 100
}

function resetSettings() {
  graphicsQuality.value = 'high'
  volume.value = 70
}
</script>
