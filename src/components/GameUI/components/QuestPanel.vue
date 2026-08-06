<template>
  <div
    class="rounded border border-neutral-700/40 bg-black/60 px-1.5 py-1 backdrop-blur text-white text-[10px] w-48"
  >
    <div
      class="flex items-center justify-between cursor-pointer"
      @click="$emit('toggleCollapse')"
    >
      <span class="font-semibold">📋 任务</span>
      <span class="text-[9px] text-neutral-400">{{ collapsed ? '▸' : '▾' }}</span>
    </div>

    <div
      v-if="!collapsed"
      class="mt-1 flex flex-col gap-1"
    >
      <div
        v-if="activeQuests.length === 0"
        class="text-[9px] text-neutral-500"
      >
        暂无任务
      </div>
      <div
        v-for="quest in activeQuests"
        :key="quest.questId"
        class="flex items-center justify-between rounded border border-neutral-700/40 bg-neutral-900/40 px-1 py-0.5"
        :class="{ '!border-emerald-500/60': quest.state === 2 }"
      >
        <span class="text-[9px] leading-none truncate">{{ quest.questId }}</span>
        <span
          class="text-[9px] leading-none"
          :class="quest.state === 2 ? 'text-emerald-400' : 'text-neutral-400'"
        >
          {{ quest.state === 2 ? '可交' : '进行中' }} {{ quest.count }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'QuestPanel' })

import { computed } from 'vue'
import type { UIStateQuest } from 'game/type'

const props = defineProps<{
  collapsed: boolean
  quests: UIStateQuest[]
}>()

defineEmits<{
  (e: 'toggleCollapse'): void
}>()

const activeQuests = computed(() => props.quests.filter((q) => q.state === 1 || q.state === 2))
</script>
