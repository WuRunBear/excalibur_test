<template>
  <div
    class="px-panel relative h-20 w-28 overflow-hidden"
    aria-label="小地图"
  >
    <div class="pixelated grid h-full w-full grid-cols-7 grid-rows-5 pr-7">
      <div
        v-for="cell in 35"
        :key="cell"
        class="border-b border-r border-px-line"
      />
    </div>
    <span class="absolute right-0 top-0">
      <Button
        shape="square"
        size="small"
        variant="text"
        theme="danger"
        :aria-label="'关闭小地图'"
        @click="$emit('close')"
      >
        <template #icon>
          <IconClose :size="12" />
        </template>
      </Button>
    </span>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'MiniMapPanel' })

import { Button } from '@pixelium/web-vue/es'
import { IconClose } from '@pixelium/web-vue/icon-pa/es'

defineEmits<{
  (e: 'close'): void
}>()
</script>
