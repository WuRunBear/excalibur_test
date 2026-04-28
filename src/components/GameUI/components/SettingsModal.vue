<template>
  <div class="absolute inset-0 grid place-items-center bg-black/40 pointer-events-auto">
    <div
      class="w-[min(520px,calc(100%-2rem))] rounded-xl border border-neutral-200 bg-white p-4 shadow-lg"
    >
      <div class="flex items-center justify-between">
        <div class="text-sm font-semibold text-neutral-900">设置（测试）</div>
        <Button
          size="small"
          variant="text"
          @click="$emit('close')"
        >
          关闭
        </Button>
      </div>

      <div class="mt-3 grid gap-3">
        <div class="rounded-md bg-neutral-50 px-3 py-3">
          <div class="flex items-center justify-between">
            <div class="text-xs font-semibold text-neutral-700">画面质量</div>
            <div class="text-xs text-neutral-600">{{ graphicsQualityLabel }}</div>
          </div>
          <div class="mt-2 flex flex-wrap gap-2">
            <Button
              size="small"
              variant="text"
              :class="
                graphicsQuality === 'low' ? 'bg-neutral-900 text-white hover:bg-neutral-800' : ''
              "
              @click="$emit('updateQuality', 'low')"
            >
              低
            </Button>
            <Button
              size="small"
              variant="text"
              :class="
                graphicsQuality === 'medium' ? 'bg-neutral-900 text-white hover:bg-neutral-800' : ''
              "
              @click="$emit('updateQuality', 'medium')"
            >
              中
            </Button>
            <Button
              size="small"
              variant="text"
              :class="
                graphicsQuality === 'high' ? 'bg-neutral-900 text-white hover:bg-neutral-800' : ''
              "
              @click="$emit('updateQuality', 'high')"
            >
              高
            </Button>
          </div>
        </div>

        <div class="rounded-md bg-neutral-50 px-3 py-3">
          <div class="flex items-center justify-between">
            <div class="text-xs font-semibold text-neutral-700">主音量</div>
            <div class="text-xs text-neutral-600">{{ volume }}%</div>
          </div>
          <input
            :value="volume"
            type="range"
            min="0"
            max="100"
            class="mt-2 w-full"
            @input="onVolumeInput"
          />
        </div>
      </div>

      <div class="mt-4 flex items-center justify-end gap-2">
        <Button
          size="small"
          variant="text"
          @click="$emit('reset')"
        >
          恢复默认
        </Button>
        <Button
          size="small"
          @click="$emit('save')"
        >
          保存
        </Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'SettingsModal' })

import { Button } from '@pixelium/web-vue/es'

const props = defineProps<{
  graphicsQuality: 'low' | 'medium' | 'high'
  graphicsQualityLabel: string
  volume: number
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'reset'): void
  (e: 'save'): void
  (e: 'updateQuality', value: 'low' | 'medium' | 'high'): void
  (e: 'updateVolume', value: number): void
}>()

function onVolumeInput(e: Event) {
  const el = e.target as HTMLInputElement | null
  const raw = el?.value ?? String(props.volume)
  const next = Number(raw)
  emit('updateVolume', Number.isFinite(next) ? next : props.volume)
}
</script>
