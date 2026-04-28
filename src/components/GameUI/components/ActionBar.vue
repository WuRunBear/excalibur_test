<template>
  <div
    class="absolute bottom-3 left-1/2 w-[min(720px,calc(100%-1.5rem))] -translate-x-1/2 pointer-events-auto"
  >
    <div class="rounded-lg border border-neutral-200 bg-white/85 px-3 py-3 shadow-sm backdrop-blur">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <Button
            size="small"
            @click="$emit('dealDamage')"
          >
            受伤
          </Button>
          <Button
            size="small"
            variant="text"
            @click="$emit('heal')"
          >
            治疗
          </Button>
          <Button
            size="small"
            @click="$emit('spendMana')"
          >
            施法
          </Button>
          <Button
            size="small"
            variant="text"
            @click="$emit('recoverMana')"
          >
            回蓝
          </Button>
          <Button
            size="small"
            variant="text"
            @click="$emit('earnCoins')"
          >
            拾取金币
          </Button>
        </div>

        <div class="flex items-center gap-2">
          <Button
            size="small"
            variant="text"
            @click="$emit('toggleQuestPanel')"
          >
            {{ showQuestPanel ? '隐藏任务' : '显示任务' }}
          </Button>
          <Button
            size="small"
            variant="text"
            @click="$emit('toggleMiniMap')"
          >
            {{ showMiniMap ? '隐藏小地图' : '显示小地图' }}
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'ActionBar' })

import { Button } from '@pixelium/web-vue/es'

defineProps<{
  showQuestPanel: boolean
  showMiniMap: boolean
}>()

defineEmits<{
  (e: 'dealDamage'): void
  (e: 'heal'): void
  (e: 'spendMana'): void
  (e: 'recoverMana'): void
  (e: 'earnCoins'): void
  (e: 'toggleQuestPanel'): void
  (e: 'toggleMiniMap'): void
}>()
</script>
