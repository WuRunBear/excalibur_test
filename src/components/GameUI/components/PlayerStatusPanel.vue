<template>
  <div
    class="flex items-center gap-1.5 rounded border border-neutral-700/40 bg-black/60 px-1.5 py-1 backdrop-blur text-white"
    :class="{ '!border-indigo-500/50': isNight }"
  >
    <span class="text-[10px] leading-none font-semibold max-w-[60px] truncate">{{
      playerName
    }}</span>

    <div class="w-20 h-1.5 rounded-full bg-neutral-700 overflow-hidden">
      <div
        class="h-full bg-rose-500 transition-[width] duration-200"
        :style="{ width: hpPercent + '%' }"
      />
    </div>
    <span class="text-[9px] text-neutral-300 leading-none w-8 text-right tabular-nums">{{
      hp
    }}</span>

    <div
      v-for="need in needs"
      :key="need.name"
      class="flex items-center gap-0.5"
      :title="needName(need.name)"
    >
      <span class="text-[8px] leading-none">{{ needName(need.name) }}</span>
      <div class="w-8 h-1.5 rounded-full bg-neutral-700 overflow-hidden">
        <div
          class="h-full transition-[width] duration-200"
          :class="needIconClass(need.name)"
          :style="{ width: needPercent(need) + '%' }"
        />
      </div>
    </div>

    <span
      class="text-[9px] leading-none tabular-nums"
      :class="{ 'text-indigo-300': isNight }"
    >
      {{ clock }} {{ isNight ? '🌙' : '☀️' }}
    </span>
    <span
      v-if="zone"
      class="text-[9px] text-neutral-500 leading-none max-w-[56px] truncate"
      >{{ zone }}</span
    >

    <Button
      size="small"
      variant="text"
      class="!text-[10px] !p-0 !min-w-4 !h-4"
      @click="$emit('openSettings')"
    >
      ⚙
    </Button>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'PlayerStatusPanel' })

import { computed } from 'vue'
import { Button } from '@pixelium/web-vue/es'
import type { UIStateNeeds } from 'game/type'

const props = defineProps<{
  playerName: string
  zone: string
  hp: number
  hpMax: number
  needs: UIStateNeeds[]
  hour: number
  phase: number
}>()

defineEmits<{
  (e: 'openSettings'): void
}>()

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

const hpPercent = computed(() =>
  props.hpMax <= 0 ? 0 : clamp((props.hp / props.hpMax) * 100, 0, 100),
)

const isNight = computed(() => props.phase === 1 || props.hour < 5 || props.hour >= 19)

const clock = computed(() => {
  const h = Math.floor(props.hour) % 24
  const m = Math.floor((props.hour - Math.floor(props.hour)) * 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
})

function needName(name: string) {
  if (name === 'hunger') return '🍗'
  if (name === 'thirst') return '💧'
  return name ? (name[0] ?? '?') : '?'
}

function needPercent(need: UIStateNeeds) {
  return need.max <= 0 ? 0 : clamp((need.current / need.max) * 100, 0, 100)
}

function needIconClass(name: string) {
  return name === 'hunger' ? 'bg-amber-500' : 'bg-sky-500'
}
</script>
