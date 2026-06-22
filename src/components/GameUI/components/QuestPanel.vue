<template>
  <div class="rounded-lg border border-neutral-200 bg-white/85 shadow-sm backdrop-blur">
    <div class="flex items-center justify-between px-3 py-2">
      <div class="text-xs font-semibold text-neutral-700">任务</div>
      <Button size="small" variant="text" @click="$emit('toggleCollapse')">
        {{ collapsed ? '展开' : '收起' }}
      </Button>
    </div>

    <div v-if="!collapsed" class="px-3 pb-3 text-xs text-neutral-700">
      <div class="rounded-md bg-white/50 px-3 py-2">
        <div class="font-semibold">{{ activeQuest }}</div>
        <div class="mt-1 text-neutral-600">{{ questDesc }}</div>
        <div class="mt-2">
          <div class="flex items-center justify-between text-[11px] text-neutral-600">
            <span>进度</span>
            <span>{{ questProgress }}/{{ questGoal }}</span>
          </div>
          <div class="mt-1 h-2 w-full overflow-hidden rounded bg-neutral-200">
            <div
              class="h-full bg-emerald-500 transition-[width] duration-200"
              :style="{ width: questPercent + '%' }"
            ></div>
          </div>
        </div>
      </div>
      <div class="mt-2 flex items-center justify-end gap-2">
        <Button size="small" variant="text" @click="$emit('advance')">
          推进
        </Button>
        <Button size="small" @click="$emit('complete')">
          完成
        </Button>
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
