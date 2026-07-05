<template>
  <div class="rounded border border-neutral-700/40 bg-black/60 px-1.5 py-1 backdrop-blur text-white text-[10px] w-48">
    <div class="flex items-center justify-between" @click="$emit('toggleCollapse')">
      <span class="font-semibold">📋 {{ activeQuest }}</span>
      <span class="text-[9px] text-neutral-400 cursor-pointer">{{ collapsed ? '▸' : '▾' }}</span>
    </div>

    <div v-if="!collapsed" class="mt-1">
      <div class="h-1 rounded-full bg-neutral-700 overflow-hidden">
        <div class="h-full bg-emerald-500 transition-[width] duration-200" :style="{ width: questPercent + '%' }" />
      </div>
      <div class="mt-0.5 flex items-center justify-between text-[9px] text-neutral-400">
        <span>{{ questProgress }}/{{ questGoal }}</span>
        <span>{{ questDesc }}</span>
      </div>
      <div class="mt-1 flex items-center justify-end gap-1">
        <Button size="small" variant="text" class="!text-[9px] !py-0" @click.stop="$emit('advance')">推进</Button>
        <Button size="small" class="!text-[9px] !py-0" @click.stop="$emit('complete')">完成</Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'QuestPanel' })

import { Button } from '@pixelium/web-vue/es'

defineProps<{
  collapsed: boolean
  activeQuest: string
  questDesc: string
  questProgress: number
  questGoal: number
  questPercent: number
}>()

defineEmits<{
  (e: 'toggleCollapse'): void
  (e: 'advance'): void
  (e: 'complete'): void
}>()
</script>
