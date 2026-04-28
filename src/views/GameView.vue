<template>
  <div class="w-screen h-screen flex items-center justify-center">
    <GameUI :bridge="bridge">
      <template #content="{ slotClass }">
        <canvas
          ref="gameCanvas"
          id="gameCanvas"
          :class="slotClass"
        ></canvas>
      </template>
    </GameUI>
  </div>
</template>

<script setup lang="ts">
import type { GameBridge } from 'game/type'
import { destroyGame, initGame } from 'game/index'
import { onMounted, onUnmounted, ref } from 'vue'
import GameUI from 'components/GameUI/Index.vue'

const gameCanvas = ref<HTMLCanvasElement | null>(null)
const bridge = ref<GameBridge | undefined>(undefined)

onMounted(async () => {
  if (gameCanvas.value) {
    const controller = await initGame(gameCanvas.value)
    bridge.value = controller.bridge
  }
})

onUnmounted(() => {
  bridge.value = undefined
  destroyGame()
})
</script>
