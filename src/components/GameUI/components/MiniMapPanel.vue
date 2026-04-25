<template>
  <div
    class="absolute bottom-20 left-3 w-44 overflow-hidden rounded-lg border border-neutral-200 bg-white/85 shadow-sm backdrop-blur pointer-events-auto"
    aria-label="小地图"
  >
    <div class="flex items-center justify-between px-3 py-2">
      <div class="text-xs font-semibold text-neutral-700">小地图</div>
      <Button size="small" variant="text" @click="$emit('close')">关闭</Button>
    </div>
    <div
      class="h-32 bg-[radial-gradient(circle_at_30%_30%,rgba(59,130,246,0.25),transparent_55%),radial-gradient(circle_at_70%_60%,rgba(16,185,129,0.22),transparent_60%),linear-gradient(135deg,rgba(0,0,0,0.04),rgba(0,0,0,0))]"
    ></div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'MiniMapPanel' })

import { Button } from '@pixelium/web-vue/es'

defineEmits<{
  (e: 'close'): void
}>()
</script>
