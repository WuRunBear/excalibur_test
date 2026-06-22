<template>
  <div class="rounded-lg border border-neutral-200 bg-white/85 px-3 py-3 shadow-sm backdrop-blur">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <Avatar bordered :size="28" aria-label="玩家头像">
          <span class="text-xs font-semibold">P</span>
        </Avatar>
        <div class="min-w-0">
          <div class="truncate text-sm font-semibold text-neutral-900">{{ playerName }}</div>
          <div class="text-xs text-neutral-500">Lv. {{ level }} · {{ zone }}</div>
        </div>
      </div>
      <Button size="small" variant="text" @click="$emit('openSettings')">
        ⚙
      </Button>
    </div>

    <div class="mt-3 grid gap-2">
      <div>
        <div class="flex items-center justify-between text-[11px] text-neutral-600">
          <span>生命</span>
          <span>{{ hp }}/{{ hpMax }}</span>
        </div>
        <div class="mt-1 h-2 w-56 overflow-hidden rounded bg-neutral-200">
          <div class="h-full bg-rose-500 transition-[width] duration-200" :style="{ width: hpPercent + '%' }"></div>
        </div>
      </div>

      <div>
        <div class="flex items-center justify-between text-[11px] text-neutral-600">
          <span>能量</span>
          <span>{{ mp }}/{{ mpMax }}</span>
        </div>
        <div class="mt-1 h-2 w-56 overflow-hidden rounded bg-neutral-200">
          <div class="h-full bg-sky-500 transition-[width] duration-200" :style="{ width: mpPercent + '%' }"></div>
        </div>
      </div>

      <div class="flex items-center justify-between gap-2 text-xs text-neutral-700">
        <span>金币</span>
        <span class="font-semibold tabular-nums">{{ coins }}</span>
      </div>
    </div>
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

const hpPercent = computed(() => {
  if (props.hpMax <= 0) return 0
  return clamp((props.hp / props.hpMax) * 100, 0, 100)
})

const mpPercent = computed(() => {
  if (props.mpMax <= 0) return 0
  return clamp((props.mp / props.mpMax) * 100, 0, 100)
})
</script>
