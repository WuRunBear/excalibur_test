<template>
  <div class="rounded border border-neutral-700/40 bg-black/60 p-1.5 backdrop-blur text-white w-56">
    <div class="flex items-center justify-between">
      <span class="text-[10px] font-semibold">🔨 合成</span>
      <button
        class="text-[9px] text-neutral-400 cursor-pointer hover:text-white"
        @click="$emit('close')"
      >
        ✕
      </button>
    </div>

    <div class="mt-1 flex flex-col gap-1 max-h-72 overflow-y-auto">
      <div
        v-for="recipe in recipes"
        :key="recipe.id"
        class="flex items-center justify-between rounded border border-neutral-700/40 bg-neutral-900/40 px-1.5 py-1 cursor-pointer hover:border-neutral-400"
        :title="costsLabel(recipe)"
        @click="$emit('craftItem', recipe.id)"
      >
        <span class="text-[10px] leading-none">
          {{ itemIcon(recipe.produces.kind) }} {{ recipe.name }}
        </span>
        <span class="text-[9px] text-neutral-400 leading-none">
          {{ recipe.stationType === 1 ? '🔥' : '' }}{{ costsLabel(recipe) }}
        </span>
      </div>
    </div>

    <div class="mt-1 text-[8px] text-neutral-500">
      点击合成 · 失败无提示，以状态变化为准 · 🔥 = 需在火堆旁
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'CraftPanel' })

import { ITEM_ICONS, ITEM_NAMES, RECIPES, type RecipeInfo } from 'game/net/types'

defineEmits<{
  (e: 'close'): void
  (e: 'craftItem', recipe: string): void
}>()

function itemIcon(kind: string) {
  return ITEM_ICONS[kind] ?? '📦'
}

function costsLabel(recipe: RecipeInfo) {
  return recipe.costs.map((c) => `${ITEM_NAMES[c.kind] ?? c.kind}×${c.count}`).join(' ')
}

const recipes = RECIPES
</script>
