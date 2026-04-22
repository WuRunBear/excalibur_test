<template>
  <div class="row items-center justify-evenly">
    <canvas id="gameCanvas" class="w-full h-full"></canvas>
  </div>
</template>

<script setup lang="ts">
import { initGame } from 'src/game/index';
import { onMounted } from 'vue';

onMounted(() => {
  initGame(document.getElementById('gameCanvas') as HTMLCanvasElement);
})
</script>
