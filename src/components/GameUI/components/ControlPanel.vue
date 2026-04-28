<template>
  <div class="rounded-lg border border-neutral-200 bg-white/85 p-2 shadow-sm backdrop-blur">
    <div class="flex items-center gap-2">
      <Button
        size="small"
        variant="text"
        :class="isPaused ? 'bg-neutral-900 text-white hover:bg-neutral-800' : ''"
        @click="$emit('togglePause')"
      >
        {{ isPaused ? '已暂停' : '暂停' }}
      </Button>
      <Button
        size="small"
        variant="text"
        @click="$emit('reset')"
      >
        重置
      </Button>
      <DropDown
        :options="moreOptions"
        trigger="click"
        placement="bottom-start"
        @select="onMoreSelect"
      >
        <Button
          size="small"
          variant="text"
          aria-label="更多"
        >
          更多 ▾
        </Button>
      </DropDown>
    </div>

    <div
      v-if="showDebug"
      class="mt-2 w-72 rounded-md bg-neutral-900/90 px-3 py-2 text-[11px] text-neutral-100"
    >
      <div class="flex items-center justify-between">
        <span>调试面板</span>
        <span class="text-neutral-300">FPS: {{ fps }}</span>
      </div>
      <div class="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-neutral-200">
        <div>坐标: {{ position.x }}, {{ position.y }}</div>
        <div>朝向: {{ facing }}</div>
        <div>状态: {{ isPaused ? '暂停' : '运行' }}</div>
        <div>任务: {{ activeQuest }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'ControlPanel' })

import { Button, DropDown } from '@pixelium/web-vue/es'

type MoreOptionIndex = 'settings' | 'debug' | 'clearMsg'

defineProps<{
  isPaused: boolean
  showDebug: boolean
  fps: number
  position: { x: number; y: number }
  facing: string
  activeQuest: string
}>()

const emit = defineEmits<{
  (e: 'togglePause'): void
  (e: 'reset'): void
  (e: 'openSettings'): void
  (e: 'toggleDebug'): void
  (e: 'clearMessages'): void
}>()

const moreOptions = [
  { index: 'settings', label: '设置' },
  { index: 'debug', label: '调试面板' },
  { index: 'clearMsg', label: '清空消息' },
]

function onMoreSelect(index: string | number | symbol) {
  const key = String(index) as MoreOptionIndex
  if (key === 'settings') {
    emit('openSettings')
    return
  }
  if (key === 'debug') {
    emit('toggleDebug')
    return
  }
  if (key === 'clearMsg') {
    emit('clearMessages')
  }
}
</script>
