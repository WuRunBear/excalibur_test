<template>
  <div class="w-64 rounded border border-neutral-700/40 bg-black/70 p-2 backdrop-blur text-white">
    <div class="flex items-center justify-between">
      <span class="text-[11px] font-semibold">💬 {{ dialogue.treeId || '对话' }}</span>
      <button
        class="text-[9px] text-neutral-400 cursor-pointer hover:text-white"
        @click="$emit('close')"
      >
        ✕
      </button>
    </div>

    <div
      v-if="dialogue.nodeId"
      class="mt-1 text-[9px] text-neutral-400"
    >
      节点: {{ dialogue.nodeId }}
    </div>

    <div
      v-if="dialogue.options.length"
      class="mt-1.5 flex flex-col gap-1"
    >
      <button
        v-for="(option, idx) in dialogue.options"
        :key="idx"
        class="rounded border border-neutral-700/50 bg-neutral-900/60 px-2 py-1 text-left text-[10px] hover:border-neutral-400 cursor-pointer"
        @click="$emit('dialogueSelect', idx)"
      >
        {{ option }}
      </button>
    </div>

    <div
      v-else
      class="mt-1.5 text-[10px] text-neutral-500"
    >
      （无选项）
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'DialoguePanel' })

import type { UIStateDialogue } from 'game/type'

defineProps<{
  dialogue: UIStateDialogue
}>()

defineEmits<{
  (e: 'close'): void
  (e: 'dialogueSelect', option: number): void
}>()
</script>
