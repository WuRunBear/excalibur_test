<template>
  <div
    class="px-panel flex flex-wrap items-center gap-1 px-2 py-1 text-px-text"
    :class="{ 'player-panel--night': isNight }"
  >
    <span class="text-xs leading-none max-w-[60px] truncate">{{ playerName }}</span>

    <div class="w-20">
      <Progress
        :percentage="hpPercent"
        theme="danger"
        :size="8"
      />
    </div>
    <span class="text-xs text-px-muted leading-none w-8 text-right tabular-nums">{{ hp }}</span>

    <div
      v-for="need in needs"
      :key="need.name"
      class="flex items-center gap-1"
      :title="need.name"
    >
      <span class="text-xs leading-none">{{ needName(need.name) }}</span>
      <div class="w-8">
        <Progress
          :percentage="needPercent(need)"
          :theme="needTheme(need.name)"
          :size="6"
        />
      </div>
    </div>

    <span
      class="flex items-center gap-1 text-xs leading-none tabular-nums"
      :class="{ 'player-panel__clock--night': isNight }"
    >
      {{ clock }}
      <IconMoon
        v-if="isNight"
        :size="12"
      />
      <IconSun
        v-else
        :size="12"
      />
    </span>

    <span
      v-if="zone"
      class="text-xs text-px-muted leading-none max-w-[56px] truncate"
      >{{ zone }}</span
    >

    <Button
      shape="square"
      size="small"
      variant="text"
      title="设置"
      aria-label="设置"
      @click="$emit('openSettings')"
    >
      <template #icon>
        <IconSliders :size="16" />
      </template>
    </Button>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'PlayerStatusPanel' })

import { computed } from 'vue'
import { Button, Progress } from '@pixelium/web-vue/es'
import { IconMoon, IconSliders, IconSun } from '@pixelium/web-vue/icon-pa/es'
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

function needTheme(name: string): 'warning' | 'notice' {
  return name === 'hunger' ? 'warning' : 'notice'
}
</script>

<style scoped>
.player-panel--night {
  border-color: var(--color-notice);
}

.player-panel__clock--night {
  color: var(--color-notice);
}
</style>
