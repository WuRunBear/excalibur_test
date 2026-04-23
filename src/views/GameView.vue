<template>
  <GameUI>
    <canvas id="gameCanvas" class="w-full h-full"></canvas>
  </GameUI>
</template>

<script setup lang="ts">
import { initGame } from 'game/index';
import { onMounted } from 'vue';
import GameUI from 'components/GameUI/Index.vue';

onMounted(() => {
  initGame(document.getElementById('gameCanvas') as HTMLCanvasElement);
})
</script>
