<template>
  <div class="px-panel w-48 text-px-text">
    <div
      class="flex items-center justify-between px-2 py-1 cursor-pointer select-none"
      @click="$emit('toggleCollapse')"
    >
      <span class="text-xs tracking-wider">任务</span>
      <Button
        shape="square"
        size="small"
        variant="text"
        :title="collapsed ? '展开任务' : '收起任务'"
        aria-label="切换任务面板"
        @click.stop="$emit('toggleCollapse')"
      >
        <template #icon>
          <IconChevronDown v-if="collapsed" :size="12" />
          <IconChevronUp v-else :size="12" />
        </template>
      </Button>
    </div>

    <div v-if="!collapsed" class="flex flex-col gap-1 px-2 pb-2">
      <div v-if="activeQuests.length === 0" class="text-xs text-px-muted">
        暂无任务
      </div>
      <div
        v-for="quest in activeQuests"
        :key="quest.questId"
        class="flex items-center justify-between border px-1"
        :class="quest.state === 2 ? 'border-px-success' : 'border-px-line'"
      >
        <span class="text-xs leading-none truncate">{{ quest.questId }}</span>
        <span
          class="text-xs leading-none"
          :class="quest.state === 2 ? 'text-px-success' : 'text-px-muted'"
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
import { Button } from '@pixelium/web-vue/es'
import { IconChevronDown, IconChevronUp } from '@pixelium/web-vue/icon-pa/es'
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
