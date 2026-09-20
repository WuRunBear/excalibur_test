<template>
  <div class="pointer-events-auto">
    <div class="flex items-end gap-1">
      <div
        v-for="(slot, idx) in slots"
        :key="idx"
        class="flex flex-col items-center gap-0.5"
      >
        <button
          type="button"
          class="relative flex h-10 w-10 select-none items-center justify-center border-2 bg-px-panel text-base leading-none focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-px-primary"
          :class="
            idx === activeSlot
              ? 'border-px-primary bg-px-primary/10 text-px-text'
              : 'border-px-border text-px-text hover:border-px-border-hover'
          "
          :title="slot.kind ? itemName(slot.kind) : '空槽'"
          :aria-label="`热键 ${idx + 1}`"
          @click="onUse(idx)"
        >
          <span
            class="leading-none"
            :class="slot.kind ? '' : 'text-px-muted'"
            >{{ slot.kind ? slotIcon(slot.kind) : '·' }}</span
          >
          <span
            v-if="slot.kind && slot.count > 1"
            class="absolute bottom-0 right-0.5 text-[9px] leading-none text-px-muted"
          >
            {{ slot.count }}
          </span>
        </button>
        <span
          class="text-[10px] leading-none"
          :class="idx === activeSlot ? 'text-px-primary' : 'text-px-muted'"
        >
          {{ idx + 1 }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'ActionBar' })

import { computed } from 'vue'
import { ITEM_ICONS, ITEM_NAMES } from 'net/types'
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

function itemName(kind: string) {
  return ITEM_NAMES[kind] ?? kind
}

function onUse(idx: number) {
  const slot = props.inventory[idx]
  if (slot && slot.kind) {
    emit('useItem', idx)
  }
}
</script>
