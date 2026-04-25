<template>
  <div class="rounded-lg border border-neutral-200 bg-white/85 px-3 py-2 shadow-sm backdrop-blur">
    <div class="flex items-center justify-between gap-2">
      <div class="text-xs font-semibold text-neutral-700">消息</div>
      <Button size="small" variant="text" @click="$emit('add')">新增</Button>
    </div>
    <div class="mt-2 max-h-28 w-72 overflow-auto rounded bg-white/40 p-2 text-xs text-neutral-700">
      <div v-if="messages.length === 0" class="text-neutral-500">暂无消息</div>
      <div v-for="msg in messages" :key="msg.id" class="flex items-start gap-2 py-1">
        <span class="mt-[2px] inline-block h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
        <span class="flex-1 leading-relaxed">{{ msg.text }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'MessagePanel' })

import { Button } from '@pixelium/web-vue/es'

defineProps<{
  messages: { id: string; text: string }[]
}>()

defineEmits<{
  (e: 'add'): void
}>()
</script>
