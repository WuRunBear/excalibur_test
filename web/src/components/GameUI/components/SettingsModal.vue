<template>
  <div class="absolute inset-0 grid place-items-center bg-px-text/40 pointer-events-auto">
    <div class="px-panel w-[min(400px,calc(100%-2rem))] p-3 text-px-text">
      <div class="flex items-center justify-between gap-2 border-b-2 border-px-text pb-2">
        <div class="flex items-center gap-2">
          <IconSliders
            :size="16"
            class="text-px-primary"
          />
          <span class="text-sm tracking-wider">设置</span>
        </div>
        <Button
          shape="square"
          size="small"
          variant="text"
          theme="danger"
          :aria-label="'关闭设置'"
          @click="$emit('close')"
        >
          <template #icon>
            <IconClose :size="12" />
          </template>
        </Button>
      </div>

      <div class="mt-3 grid gap-2">
        <div class="border border-px-line bg-px-soft p-2">
          <div class="flex items-center justify-between text-xs">
            <span>画面质量</span>
            <span class="text-px-muted">{{ graphicsQualityLabel }}</span>
          </div>
          <div class="mt-2 flex gap-2">
            <Button
              v-for="q in qualityOptions"
              :key="q.value"
              size="small"
              :variant="graphicsQuality === q.value ? 'plain' : 'outline'"
              @click="$emit('updateQuality', q.value)"
            >
              {{ q.label }}
            </Button>
          </div>
        </div>

        <div class="border border-px-line bg-px-soft p-2">
          <div class="flex items-center justify-between text-xs">
            <span>主音量</span>
            <span class="text-px-muted">{{ volume }}%</span>
          </div>
          <Slider
            class="mt-2"
            :model-value="volume"
            :min="0"
            :max="100"
            :step="1"
            @update:model-value="onVolumeChange"
          />
        </div>

        <div class="border border-px-line bg-px-soft p-2">
          <div class="flex items-center justify-between text-xs">
            <span>碰撞调试</span>
            <span class="text-px-muted"
              >tick {{ debug.tick }} | {{ debug.colliderCount }}/{{ debug.pairCount }}</span
            >
          </div>
          <div class="mt-2 grid gap-2">
            <div class="flex items-center justify-between">
              <span class="text-xs">调试</span>
              <Switch
                shape="rect"
                size="small"
                :model-value="debug.enabled"
                active-label="开"
                inactive-label="关"
                @update:model-value="$emit('toggleDebugEnabled')"
              />
            </div>
            <div class="flex items-center justify-between">
              <span class="text-xs">地图碰撞</span>
              <Switch
                shape="rect"
                size="small"
                :model-value="debug.showMapColliders"
                @update:model-value="$emit('toggleMapColliders')"
              />
            </div>
            <div class="flex items-center justify-between">
              <span class="text-xs">实体碰撞</span>
              <Switch
                shape="rect"
                size="small"
                :model-value="debug.showEntityColliders"
                @update:model-value="$emit('toggleEntityColliders')"
              />
            </div>
            <div class="flex items-center justify-between">
              <span class="text-xs">自动刷新</span>
              <Switch
                shape="rect"
                size="small"
                :model-value="debug.autoRefresh"
                @update:model-value="$emit('toggleAutoRefresh')"
              />
            </div>
            <Button
              size="small"
              variant="outline"
              block
              @click="$emit('refreshDebug')"
            >
              <template #icon>
                <IconReload :size="12" />
              </template>
              刷新
            </Button>
          </div>
        </div>
      </div>

      <div class="mt-3 flex items-center justify-end gap-2">
        <Button
          size="small"
          variant="outline"
          @click="$emit('reset')"
        >
          恢复默认
        </Button>
        <Button
          size="small"
          variant="plain"
          theme="success"
          @click="$emit('save')"
        >
          <template #icon>
            <IconCheck :size="12" />
          </template>
          保存
        </Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'SettingsModal' })

import { Button, Slider, Switch } from '@pixelium/web-vue/es'
import { IconCheck, IconClose, IconReload, IconSliders } from '@pixelium/web-vue/icon-pa/es'
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

const qualityOptions: Array<{ label: string; value: 'low' | 'medium' | 'high' }> = [
  { label: '低', value: 'low' },
  { label: '中', value: 'medium' },
  { label: '高', value: 'high' },
]

function onVolumeChange(value: number | [number, number]) {
  const raw = Array.isArray(value) ? (value[0] ?? props.volume) : value
  const next = Math.round(raw)
  emit('updateVolume', Math.max(0, Math.min(100, next)))
}
</script>
