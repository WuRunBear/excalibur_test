<template>
  <div class="px-panel w-56 p-2 text-px-text">
    <div class="flex items-center justify-between gap-2">
      <span class="px-panel__title inline-flex items-center gap-1">
        <IconPlus :size="12" />
        <span>合成</span>
      </span>
      <Button
        shape="square"
        size="small"
        variant="text"
        theme="danger"
        aria-label="关闭合成"
        @click="$emit('close')"
      >
        <template #icon>
          <IconClose :size="12" />
        </template>
      </Button>
    </div>

    <div class="mt-2 flex max-h-72 flex-col gap-1 overflow-y-auto">
      <Button
        v-for="recipe in recipes"
        :key="recipe.id"
        shape="rect"
        size="small"
        variant="outline"
        class="w-full"
        :title="costsLabel(recipe)"
        @click="$emit('craftItem', recipe.id)"
      >
        <span class="flex w-full items-center justify-between gap-1">
          <span class="flex min-w-0 items-center gap-1">
            <span class="text-sm leading-none">{{ itemIcon(recipe.produces.kind) }}</span>
            <span class="truncate text-[10px] leading-none">{{ recipe.name }}</span>
          </span>
          <span class="flex shrink-0 items-center gap-1">
            <Tag
              v-if="recipe.stationType === 1"
              size="small"
              variant="plain"
              theme="warning"
            >
              火
            </Tag>
            <span class="text-[9px] leading-none text-px-muted">{{ costsLabel(recipe) }}</span>
          </span>
        </span>
      </Button>
    </div>

    <div class="mt-1 text-[8px] text-px-muted">
      点击合成 · 失败无提示，以状态变化为准 · 火 = 需在火堆旁
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'CraftPanel' })

import { Button, Tag } from '@pixelium/web-vue/es'
import { IconClose, IconPlus } from '@pixelium/web-vue/icon-pa/es'
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
