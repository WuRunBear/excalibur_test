<template>
  <div
    class="relative h-20 w-28 rounded border border-neutral-700/40 bg-black/60 backdrop-blur"
    aria-label="小地图"
  >
    <div
      class="h-full w-full bg-[radial-gradient(circle_at_30%_30%,rgba(59,130,246,0.25),transparent_55%),radial-gradient(circle_at_70%_60%,rgba(16,185,129,0.22),transparent_60%)]"
    />
    <Button
      size="small"
      variant="text"
      class="!absolute !top-0 !right-0 !text-[8px] !p-0 !min-w-3 !h-3"
      @click="$emit('close')"
    >
      ✕
    </Button>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'MiniMapPanel' })

import { Button } from '@pixelium/web-vue/es'

defineEmits<{
  (e: 'close'): void
}>()
</script>
