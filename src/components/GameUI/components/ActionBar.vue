<template>
  <div class="absolute bottom-2 left-1/2 -translate-x-1/2 pointer-events-auto">
    <div class="flex items-end gap-1">
      <div
        v-for="(slot, idx) in slots"
        :key="idx"
        class="flex flex-col items-center gap-1"
      >
        <Button
          shape="rect"
          size="small"
          :variant="idx === activeSlot ? 'plain' : 'outline'"
          :title="slot.kind ? itemName(slot.kind) : '空槽'"
          :aria-label="`热键 ${idx + 1}`"
          @click="onUse(idx)"
        >
          <template #icon>
            <span class="text-sm leading-none">{{ slot.kind ? slotIcon(slot.kind) : '·' }}</span>
          </template>
          <span class="text-[10px] leading-none">
            {{ slot.kind ? itemName(slot.kind) : '空' }}<template v-if="slot.kind && slot.count > 1">×{{ slot.count }}</template>
          </span>
        </Button>
        <span
          class="text-[8px] leading-none"
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
import { Button } from '@pixelium/web-vue/es'
import { ITEM_ICONS, ITEM_NAMES } from 'game/net/types'
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
