<template>
  <div class="absolute bottom-2 left-1/2 -translate-x-1/2 pointer-events-auto">
    <div class="flex items-center gap-1">
      <div
        v-for="(slot, idx) in slots"
        :key="idx"
        class="relative flex h-9 w-9 items-center justify-center rounded border border-neutral-700/50 bg-black/60 text-sm shadow-sm backdrop-blur transition-colors hover:border-neutral-400 cursor-pointer"
        :class="{ 'border-amber-400': idx === activeSlot }"
        @click="onUse(idx)"
      >
        <span v-if="slot.kind">{{ slotIcon(slot.kind) }}</span>
        <span
          v-if="slot.kind && slot.count > 1"
          class="absolute bottom-0 right-0.5 text-[8px] font-semibold text-white drop-shadow leading-none"
          >{{ slot.count }}</span
        >
        <span class="absolute -top-1.5 left-0.5 text-[7px] text-neutral-500 leading-none">{{
          idx + 1
        }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'ActionBar' })

import { computed } from 'vue'
import { ITEM_ICONS } from 'game/net/types'
import type { UIStateInventorySlot } from 'game/type'

const props = defineProps<{
  inventory: UIStateInventorySlot[]
  activeSlot: number
}>()

const emit = defineEmits<{
  (e: 'useItem', slot: number): void
}>()

const slots = computed(() => props.inventory.slice(0, 6))

function slotIcon(kind: string) {
  return ITEM_ICONS[kind] ?? '📦'
}

function onUse(idx: number) {
  const slot = props.inventory[idx]
  if (slot && slot.kind) {
    emit('useItem', idx)
  }
}
</script>
