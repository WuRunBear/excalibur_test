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

      <div class="mt-3 rounded-md border border-neutral-700 bg-black/20 px-2 py-2">
        <div class="flex items-center justify-between">
          <span class="font-semibold text-neutral-100">碰撞调试</span>
          <span class="text-neutral-400">tick {{ debug.tick }}</span>
        </div>
        <div class="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-neutral-300">
          <div>碰撞体: {{ debug.colliderCount }}</div>
          <div>碰撞对: {{ debug.pairCount }}</div>
        </div>
        <div class="mt-2 flex flex-wrap gap-2">
          <Button
            size="small"
            variant="text"
            :class="debug.enabled ? 'bg-emerald-600 text-white hover:bg-emerald-500' : ''"
            @click="$emit('toggleDebugEnabled')"
          >
            {{ debug.enabled ? '调试开' : '调试关' }}
          </Button>
          <Button
            size="small"
            variant="text"
            :class="debug.showMapColliders ? 'bg-sky-600 text-white hover:bg-sky-500' : ''"
            @click="$emit('toggleMapColliders')"
          >
            地图
          </Button>
          <Button
            size="small"
            variant="text"
            :class="debug.showEntityColliders ? 'bg-violet-600 text-white hover:bg-violet-500' : ''"
            @click="$emit('toggleEntityColliders')"
          >
            实体
          </Button>
          <Button
            size="small"
            variant="text"
            :class="debug.autoRefresh ? 'bg-amber-600 text-white hover:bg-amber-500' : ''"
            @click="$emit('toggleAutoRefresh')"
          >
            {{ debug.autoRefresh ? '自动刷新' : '手动刷新' }}
          </Button>
          <Button
            size="small"
            variant="text"
            @click="$emit('refreshDebug')"
          >
            刷新
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'ControlPanel' })

import { Button, DropDown } from '@pixelium/web-vue/es'

import type { GameDebugState } from 'game/type'

type MoreOptionIndex = 'settings' | 'debug' | 'clearMsg'

defineProps<{
  isPaused: boolean
  showDebug: boolean
  fps: number
  position: { x: number; y: number }
  facing: string
  activeQuest: string
  debug: GameDebugState
}>()

const emit = defineEmits<{
  (e: 'togglePause'): void
  (e: 'reset'): void
  (e: 'openSettings'): void
  (e: 'toggleDebug'): void
  (e: 'clearMessages'): void
  (e: 'toggleDebugEnabled'): void
  (e: 'toggleMapColliders'): void
  (e: 'toggleEntityColliders'): void
  (e: 'toggleAutoRefresh'): void
  (e: 'refreshDebug'): void
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
