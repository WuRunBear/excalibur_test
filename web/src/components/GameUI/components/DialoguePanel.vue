<template>
  <div class="px-panel w-64 p-2 text-px-text">
    <div class="flex items-center justify-between gap-2">
      <span class="px-panel__title inline-flex items-center gap-1">
        <IconMessage :size="12" />
        <span>{{ dialogue.treeId || '对话' }}</span>
      </span>
      <Button
        shape="square"
        size="small"
        variant="text"
        theme="danger"
        :aria-label="'关闭对话'"
        @click="$emit('close')"
      >
        <template #icon>
          <IconClose :size="12" />
        </template>
      </Button>
    </div>

    <div
      v-if="dialogue.nodeId"
      class="mt-2 text-[10px] text-px-muted"
    >
      节点: {{ dialogue.nodeId }}
    </div>

    <div
      v-if="dialogue.options.length"
      class="mt-2 flex flex-col gap-1"
    >
      <Button
        v-for="(option, idx) in dialogue.options"
        :key="idx"
        shape="rect"
        size="small"
        variant="outline"
        class="w-full"
        @click="$emit('dialogueSelect', idx)"
      >
        {{ option }}
      </Button>
    </div>

    <div
      v-else
      class="mt-2 text-[10px] text-px-muted"
    >
      （无选项）
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'DialoguePanel' })

import { Button } from '@pixelium/web-vue/es'
import { IconClose, IconMessage } from '@pixelium/web-vue/icon-pa/es'
import type { UIStateDialogue } from 'game/type'

defineProps<{
  dialogue: UIStateDialogue
}>()

defineEmits<{
  (e: 'close'): void
  (e: 'dialogueSelect', option: number): void
}>()
</script>
