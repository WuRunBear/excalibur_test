<template>
  <div class="rounded-lg border border-neutral-200 bg-white/85 px-3 py-2 shadow-sm backdrop-blur">
    <div class="text-xs font-semibold text-neutral-700">提示</div>
    <div class="mt-1 text-xs text-neutral-600">
      <div>WASD 移动 · J 攻击 · K 互动</div>
      <div class="mt-1">点击下方热键按钮可模拟状态变化</div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'TipsPanel' })
</script>
