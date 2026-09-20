<template>
  <div
    class="px-panel flex items-center gap-1 px-2 py-1 text-px-text"
    :class="{ 'status-strip--night': isNight }"
  >
    <div class="relative w-32">
      <Progress
        :percentage="hpPercent"
        theme="danger"
        :size="10"
      />
      <span class="absolute inset-0 flex items-center justify-center">
        <span class="bg-px-text px-0.5 text-[8px] leading-none tabular-nums text-px-panel">{{
          hpText
        }}</span>
      </span>
    </div>

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
      :class="{ 'status-strip__clock--night': isNight }"
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
defineOptions({ name: 'StatusStrip' })

import { computed } from 'vue'
import { Button, Progress } from '@pixelium/web-vue/es'
import { IconMoon, IconSliders, IconSun } from '@pixelium/web-vue/icon-pa/es'
import type { UIStateNeeds } from 'game/type'

const props = defineProps<{
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

const hpText = computed(() => Math.round(props.hp))

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
.status-strip--night {
  border-color: var(--color-notice);
}

.status-strip__clock--night {
  color: var(--color-notice);
}
</style>
