<template>
  <div class="rounded border border-neutral-700/40 bg-black/60 p-1.5 backdrop-blur text-white w-56">
    <div class="flex items-center justify-between">
      <span class="text-[10px] font-semibold">🎒 背包</span>
      <button
        class="text-[9px] text-neutral-400 cursor-pointer hover:text-white"
        @click="$emit('close')"
      >
        ✕
      </button>
    </div>

    <div class="mt-1 grid grid-cols-6 gap-1">
      <div
        v-for="(slot, idx) in inventory"
        :key="idx"
        class="relative flex aspect-square items-center justify-center rounded border border-neutral-700/50 bg-neutral-900/60 text-sm cursor-pointer select-none"
        :class="{
          'border-amber-400': idx === sourceSlot,
          'border-sky-500/70': idx === selectedSlot,
          'hover:border-neutral-400': true,
        }"
        :title="slot.kind ? itemName(slot.kind) : ''"
        @click="onSlotClick(idx)"
        @contextmenu.prevent="$emit('dropItem', idx)"
      >
        <span
          v-if="slot.kind"
          class="leading-none"
          >{{ itemIcon(slot.kind) }}</span
        >
        <span
          v-else
          class="text-neutral-700 text-[9px] leading-none"
          >—</span
        >
        <span
          v-if="slot.kind && slot.count > 1"
          class="absolute bottom-0 right-0.5 text-[8px] font-semibold leading-none drop-shadow"
          >{{ slot.count }}</span
        >
        <span class="absolute top-0 left-0.5 text-[7px] text-neutral-500 leading-none">{{
          idx + 1
        }}</span>
      </div>
    </div>

    <div
      v-if="equipment"
      class="mt-1.5 flex items-center gap-1 text-[9px] text-neutral-300"
    >
      <span class="text-neutral-500">装备:</span>
      <span>⚔️ {{ equipLabel(equipment.weaponSlot) }}</span>
      <span>⛏️ {{ equipLabel(equipment.toolSlot) }}</span>
      <span>🛡️ {{ equipLabel(equipment.armorSlot) }}</span>
    </div>

    <div class="mt-1 text-[8px] text-neutral-500">
      左键使用 · 右键丢弃 · 先点源槽再点目标槽 = 转移
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'InventoryPanel' })

import { ref } from 'vue'
import { ITEM_ICONS, ITEM_NAMES } from 'game/net/types'
import type { UIStateEquipment, UIStateInventorySlot } from 'game/type'

const props = defineProps<{
  inventory: UIStateInventorySlot[]
  equipment: UIStateEquipment
  selectedSlot?: number
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'useItem', slot: number): void
  (e: 'dropItem', slot: number): void
  (e: 'transferItem', payload: { slot: number; toSlot: number }): void
}>()

const sourceSlot = ref<number | null>(null)

function onSlotClick(idx: number) {
  const slot = props.inventory[idx]
  if (!slot || !slot.kind) {
    sourceSlot.value = null
    return
  }
  if (sourceSlot.value === null) {
    sourceSlot.value = idx
    return
  }
  if (sourceSlot.value !== idx) {
    const from = sourceSlot.value
    sourceSlot.value = null
    if (props.inventory[from]?.kind) {
      emit('transferItem', { slot: from, toSlot: idx })
    }
    return
  }
  sourceSlot.value = null
  emit('useItem', idx)
}

function itemIcon(kind: string) {
  return ITEM_ICONS[kind] ?? '📦'
}

function itemName(kind: string) {
  return ITEM_NAMES[kind] ?? kind
}

function equipLabel(slotIndex: number) {
  if (slotIndex < 0) return '空'
  const slot = props.inventory[slotIndex]
  return slot?.kind ? itemName(slot.kind) : '空'
}
</script>
