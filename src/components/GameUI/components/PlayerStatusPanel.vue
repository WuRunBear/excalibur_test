<template>
  <div class="flex items-center gap-1.5 rounded border border-neutral-700/40 bg-black/60 px-1.5 py-1 backdrop-blur text-white">
    <Avatar bordered :size="16" aria-label="玩家头像" class="shrink-0">
      <span class="text-[8px] font-semibold">P</span>
    </Avatar>

    <span class="text-[10px] leading-none font-semibold max-w-[60px] truncate">{{ playerName }}</span>
    <span class="text-[9px] text-neutral-400 leading-none">Lv.{{ level }}</span>

    <div class="w-20 h-1.5 rounded-full bg-neutral-700 overflow-hidden">
      <div class="h-full bg-rose-500 transition-[width] duration-200" :style="{ width: hpPercent + '%' }" />
    </div>
    <span class="text-[9px] text-neutral-300 leading-none w-10 text-right tabular-nums">{{ hp }}</span>

    <div class="w-14 h-1.5 rounded-full bg-neutral-700 overflow-hidden">
      <div class="h-full bg-sky-500 transition-[width] duration-200" :style="{ width: mpPercent + '%' }" />
    </div>
    <span class="text-[9px] text-neutral-300 leading-none w-10 text-right tabular-nums">{{ mp }}</span>

    <span class="text-[10px] leading-none tabular-nums">🪙{{ coins }}</span>

    <Button size="small" variant="text" class="!text-[10px] !p-0 !min-w-4 !h-4" @click="$emit('openSettings')">
      ⚙
    </Button>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'PlayerStatusPanel' })

import { computed } from 'vue'
import { Avatar, Button } from '@pixelium/web-vue/es'

const props = defineProps<{
  playerName: string
  zone: string
  level: number
  hp: number
  hpMax: number
  mp: number
  mpMax: number
  coins: number
}>()

defineEmits<{
  (e: 'openSettings'): void
}>()

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

const hpPercent = computed(() => props.hpMax <= 0 ? 0 : clamp((props.hp / props.hpMax) * 100, 0, 100))
const mpPercent = computed(() => props.mpMax <= 0 ? 0 : clamp((props.mp / props.mpMax) * 100, 0, 100))
</script>
