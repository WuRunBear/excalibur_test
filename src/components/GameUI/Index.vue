<template>
  <div class="relative inline-block">
    <slot name="content" :slotClass="['block', 'relative', 'z-0']"></slot>
    <div class="absolute inset-0 z-[1]">
      游戏UI
    </div>
  </div>
</template>
