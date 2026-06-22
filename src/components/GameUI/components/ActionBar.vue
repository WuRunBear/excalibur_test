<template>
  <div
    class="absolute bottom-3 left-1/2 w-[min(480px,calc(100%-1.5rem))] -translate-x-1/2 pointer-events-auto"
  >
    <div class="flex items-center justify-center gap-1">
      <div
        v-for="(slot, idx) in slots"
        :key="idx"
        class="relative flex h-12 w-12 items-center justify-center rounded border border-neutral-700 bg-neutral-900/70 text-lg shadow-sm backdrop-blur transition-colors hover:border-neutral-500"
        :class="{ 'border-amber-500': idx === activeSlot }"
        @click="activeSlot = idx"
      >
        <span v-if="slot">{{ slot.icon }}</span>
        <span
          v-if="slot?.count && slot.count > 1"
          class="absolute bottom-0.5 right-1 text-[10px] font-semibold text-white drop-shadow"
        >
          {{ slot.count }}
        </span>
        <span
          class="absolute -top-2 left-1 text-[9px] text-neutral-400"
        >
          {{ idx + 1 }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'ActionBar' })

import { ref } from 'vue'

interface ItemSlot {
  icon: string
  count?: number
}

const activeSlot = ref(0)

const slots = ref<(ItemSlot | null)[]>([
  { icon: '🧪', count: 5 },
  { icon: '🍖', count: 3 },
  { icon: '⚔️' },
  null,
  null,
  null,
  null,
  null,
])
</script>
