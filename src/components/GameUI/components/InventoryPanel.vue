<template>
  <div class="px-panel w-56 p-2 text-px-text">
    <div class="flex items-center justify-between gap-2">
      <span class="px-panel__title inline-flex items-center gap-1">
        <IconShoppingBag :size="12" />
        <span>背包</span>
      </span>
      <Button
        shape="square"
        size="small"
        variant="text"
        theme="danger"
        aria-label="关闭背包"
        @click="$emit('close')"
      >
        <template #icon>
          <IconClose :size="12" />
        </template>
      </Button>
    </div>

    <div class="mt-1 flex items-center gap-1 text-xs">
      <span class="max-w-[60px] truncate leading-none">{{ playerName }}</span>

      <div class="relative w-24">
        <Progress
          :percentage="hpPercent"
          theme="danger"
          :size="10"
        />
        <span class="absolute inset-0 flex items-center justify-center">
          <span class="bg-px-text px-0.5 text-[8px] leading-none tabular-nums text-px-panel">{{
            hpText
          }}</span>
        </span>
      </div>
      <span class="text-px-muted max-w-[56px] truncate leading-none">{{ zone }}</span>

      <span class="flex items-center gap-1 leading-none tabular-nums">
        {{ clock }}
        <IconMoon
          v-if="isNight"
          :size="12"
        />
        <IconSun
          v-else
          :size="12"
        />
      </span>
    </div>

    <div class="mt-2 grid grid-cols-6 gap-1">
      <div
        v-for="(slot, idx) in inventory"
        :key="idx"
        class="relative flex aspect-square items-center justify-center border-2 border-px-border bg-px-panel text-sm cursor-pointer select-none hover:border-px-border-hover"
        :class="{
          'border-px-primary': idx === selectedSlot,
          'border-px-notice': idx === sourceSlot,
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
          class="text-px-muted text-[9px] leading-none"
          >·</span
        >
        <span
          v-if="slot.kind && slot.count > 1"
          class="absolute bottom-0 right-0.5 text-[8px] leading-none text-px-text"
          >{{ slot.count }}</span
        >
        <span class="absolute top-0 left-0.5 text-[7px] text-px-muted leading-none">{{
          idx + 1
        }}</span>
      </div>
    </div>

    <div
      v-if="equipment"
      class="mt-2 flex items-center gap-1 text-[10px] text-px-muted"
    >
      <span>装备:</span>
      <span>⚔️ {{ equipLabel(equipment.weaponSlot) }}</span>
      <span>⛏️ {{ equipLabel(equipment.toolSlot) }}</span>
      <span class="inline-flex items-center gap-0.5">
        <IconShield :size="10" />
        {{ equipLabel(equipment.armorSlot) }}
      </span>
    </div>

    <div class="mt-1 text-[8px] text-px-muted">左键使用 · 右键丢弃 · 先点源槽再点目标槽 = 转移</div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'InventoryPanel' })

import { computed, ref } from 'vue'
import { Button, Progress } from '@pixelium/web-vue/es'
import {
  IconClose,
  IconMoon,
  IconShield,
  IconShoppingBag,
  IconSun,
} from '@pixelium/web-vue/icon-pa/es'
import { ITEM_ICONS, ITEM_NAMES } from 'game/net/types'
import type { UIStateEquipment, UIStateInventorySlot } from 'game/type'

const props = defineProps<{
  inventory: UIStateInventorySlot[]
  equipment: UIStateEquipment
  selectedSlot?: number
  playerName?: string
  zone?: string
  hp?: number
  hpMax?: number
  hour?: number
  phase?: number
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'useItem', slot: number): void
  (e: 'dropItem', slot: number): void
  (e: 'transferItem', payload: { slot: number; toSlot: number }): void
}>()

const sourceSlot = ref<number | null>(null)

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

// 防御性兜底：任务 4 前这些 props 可能不存在，统一走 ?? 兜底避免 NaN
const max = computed(() => props.hpMax ?? 0)
const h = computed(() => props.hp ?? 0)
const hr = computed(() => props.hour ?? 0)
const ph = computed(() => props.phase ?? 0)

const hpPercent = computed(() => (max.value <= 0 ? 0 : clamp((h.value / max.value) * 100, 0, 100)))

const hpText = computed(() => Math.round(h.value))

const isNight = computed(() => ph.value === 1 || hr.value < 5 || hr.value >= 19)

const clock = computed(() => {
  const hourInt = Math.floor(hr.value) % 24
  const minuteInt = Math.floor((hr.value - Math.floor(hr.value)) * 60)
  return `${String(hourInt).padStart(2, '0')}:${String(minuteInt).padStart(2, '0')}`
})

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
