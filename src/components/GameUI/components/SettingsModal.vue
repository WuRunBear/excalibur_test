<template>
  <div class="absolute inset-0 grid place-items-center bg-black/40 pointer-events-auto">
    <div class="w-[min(400px,calc(100%-2rem))] rounded-xl border border-neutral-700 bg-neutral-900 p-4 shadow-lg text-neutral-100">
      <div class="flex items-center justify-between">
        <div class="text-sm font-semibold">设置</div>
        <Button size="small" variant="text" @click="$emit('close')">关闭</Button>
      </div>

      <div class="mt-3 grid gap-3">
        <div class="rounded-md bg-neutral-800 px-3 py-2">
          <div class="flex items-center justify-between text-xs">
            <span class="font-semibold">画面质量</span>
            <span class="text-neutral-400">{{ graphicsQualityLabel }}</span>
          </div>
          <div class="mt-2 flex gap-2">
            <Button size="small" variant="text" :class="graphicsQuality === 'low' ? 'bg-neutral-600 text-white' : ''" @click="$emit('updateQuality', 'low')">低</Button>
            <Button size="small" variant="text" :class="graphicsQuality === 'medium' ? 'bg-neutral-600 text-white' : ''" @click="$emit('updateQuality', 'medium')">中</Button>
            <Button size="small" variant="text" :class="graphicsQuality === 'high' ? 'bg-neutral-600 text-white' : ''" @click="$emit('updateQuality', 'high')">高</Button>
          </div>
        </div>

        <div class="rounded-md bg-neutral-800 px-3 py-2">
          <div class="flex items-center justify-between text-xs">
            <span class="font-semibold">主音量</span>
            <span class="text-neutral-400">{{ volume }}%</span>
          </div>
          <input :value="volume" type="range" min="0" max="100" class="mt-2 w-full" @input="onVolumeInput" />
        </div>

        <div class="rounded-md bg-neutral-800 px-3 py-2">
          <div class="flex items-center justify-between text-xs">
            <span class="font-semibold">碰撞调试</span>
            <span class="text-neutral-400">tick {{ debug.tick }} | {{ debug.colliderCount }}/{{ debug.pairCount }}</span>
          </div>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <Button size="small" variant="text" :class="debug.enabled ? 'bg-emerald-600 text-white' : ''" @click="$emit('toggleDebugEnabled')">{{ debug.enabled ? '调试开' : '调试关' }}</Button>
            <Button size="small" variant="text" :class="debug.showMapColliders ? 'bg-sky-600 text-white' : ''" @click="$emit('toggleMapColliders')">地图</Button>
            <Button size="small" variant="text" :class="debug.showEntityColliders ? 'bg-violet-600 text-white' : ''" @click="$emit('toggleEntityColliders')">实体</Button>
            <Button size="small" variant="text" :class="debug.autoRefresh ? 'bg-amber-600 text-white' : ''" @click="$emit('toggleAutoRefresh')">{{ debug.autoRefresh ? '自动' : '手动' }}</Button>
            <Button size="small" variant="text" @click="$emit('refreshDebug')">刷新</Button>
          </div>
        </div>
      </div>

      <div class="mt-4 flex items-center justify-end gap-2">
        <Button size="small" variant="text" @click="$emit('reset')">恢复默认</Button>
        <Button size="small" @click="$emit('save')">保存</Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'SettingsModal' })

import { Button } from '@pixelium/web-vue/es'
import type { GameDebugState } from 'game/type'

const props = defineProps<{
  graphicsQuality: 'low' | 'medium' | 'high'
  graphicsQualityLabel: string
  volume: number
  debug: GameDebugState
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'reset'): void
  (e: 'save'): void
  (e: 'updateQuality', value: 'low' | 'medium' | 'high'): void
  (e: 'updateVolume', value: number): void
  (e: 'toggleDebugEnabled'): void
  (e: 'toggleMapColliders'): void
  (e: 'toggleEntityColliders'): void
  (e: 'toggleAutoRefresh'): void
  (e: 'refreshDebug'): void
}>()

function onVolumeInput(e: Event) {
  const el = e.target as HTMLInputElement | null
  const raw = el?.value ?? String(props.volume)
  const next = Number(raw)
  emit('updateVolume', Number.isFinite(next) ? next : props.volume)
}
</script>
