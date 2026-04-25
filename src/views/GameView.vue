<template>
  <div class="w-screen h-screen flex items-center justify-center">
    <GameUI>
      <template #content="{ slotClass }">
        <canvas ref="gameCanvas" id="gameCanvas" :class="slotClass"></canvas>
      </template>
    </GameUI>
  </div>
</template>

<script setup lang="ts">
import { initGame } from 'game/index';
import { onMounted } from 'vue';
import GameUI from 'components/GameUI/Index.vue';
import { ref } from 'vue';

const gameCanvas = ref<HTMLCanvasElement | null>(null);

onMounted(() => {
  if (gameCanvas.value) {
    initGame(gameCanvas.value);
  }
})
</script>
