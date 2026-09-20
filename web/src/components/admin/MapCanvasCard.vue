<template>
  <div
    class="map-card"
    :class="{ 'is-error': error !== null }"
  >
    <div class="map-card__head">
      <span class="map-card__source">{{ sourceLabel }}</span>
      <span
        v-if="view"
        class="map-card__version"
        :class="{ 'is-diff': versionHighlight }"
        :title="versionHighlight ? '两侧 version 不同：工作区改动尚未落到本体' : ''"
      >
        v-{{ versionSummary }}
      </span>
    </div>

    <div
      ref="stageRef"
      class="map-card__stage"
    >
      <canvas
        ref="canvasRef"
        class="map-card__canvas"
        @mousemove="onMouseMove"
        @mouseleave="hoveredPin = null"
      ></canvas>

      <div
        v-if="hoveredPin"
        class="map-card__tooltip"
        :style="{ left: `${hoveredPin.x}px`, top: `${hoveredPin.y}px` }"
      >
        {{ hoveredPin.label }}
      </div>

      <div
        v-if="loading"
        class="map-card__overlay"
      >
        <el-skeleton
          :rows="5"
          animated
        />
      </div>
      <div
        v-else-if="error"
        class="map-card__overlay"
      >
        <p class="map-card__error">{{ error }}</p>
      </div>
      <div
        v-else-if="!view"
        class="map-card__overlay"
      >
        <p class="map-card__error">选择左侧地图生成预览</p>
      </div>
    </div>

    <template v-if="view">
      <div class="map-card__meta">
        <span class="map-card__dim">尺寸 {{ view.width }} × {{ view.height }}</span>
        <span class="map-card__hint">深色为阻挡格；色块为区域着色</span>
      </div>
      <div
        v-if="view.regionAreas.length > 0"
        class="map-card__legend"
      >
        <span
          v-for="area in view.regionAreas"
          :key="area.index"
          class="map-card__legend-item"
        >
          <i
            class="map-card__legend-swatch"
            :style="{ background: regionColor(area.index) }"
          ></i>
          <span class="map-card__legend-name">{{ area.name }}</span>
          <span class="map-card__legend-count">{{ area.count }}</span>
        </span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'MapCanvasCard' })

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import {
  computeLayout,
  drawGeometry,
  regionColor,
  type DrawPin,
  type GeometryView,
} from '@/utils/mapCanvas'
import type { MapSource } from '@/api/admin'

const props = defineProps<{
  source: MapSource
  /** 已归一化的几何视图；null = 未生成 */
  view: GeometryView | null
  loading: boolean
  error: string | null
  /** 规则点位（cell 坐标，已解析区域质心） */
  pins?: DrawPin[]
  /** 对比模式下两侧 version 不同时高亮 */
  versionHighlight?: boolean
}>()

const SOURCE_LABEL: Record<MapSource, string> = {
  workspace: '工作区',
  official: '本体',
}

const sourceLabel = computed(() => SOURCE_LABEL[props.source])

const versionSummary = computed(() => {
  const version = props.view?.version ?? ''
  return version ? version.slice(0, 8) : '—'
})

// ---------------------------------------------------------------------------
// Canvas：尺寸测量 + 绘制
// ---------------------------------------------------------------------------

const stageRef = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const STAGE_HEIGHT = 440

function render(): void {
  const canvas = canvasRef.value
  const stage = stageRef.value
  const view = props.view
  if (!canvas || !stage) return

  const cssWidth = stage.clientWidth || 600
  const cssHeight = STAGE_HEIGHT
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.floor(cssWidth * dpr)
  canvas.height = Math.floor(cssHeight * dpr)
  canvas.style.width = `${cssWidth}px`
  canvas.style.height = `${cssHeight}px`

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssWidth, cssHeight)
  ctx.fillStyle = '#f7faf9'
  ctx.fillRect(0, 0, cssWidth, cssHeight)

  if (!view) return
  const layout = computeLayout(view.width, view.height, cssWidth, cssHeight)
  drawGeometry(ctx, view, layout, { pins: props.pins ?? [] })
  layoutPx.value = layout
}

let resizeTimer: number | null = null
function onWindowResize(): void {
  if (resizeTimer !== null) clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(() => render(), 120)
}

onMounted(() => {
  window.addEventListener('resize', onWindowResize)
  render()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
  if (resizeTimer !== null) clearTimeout(resizeTimer)
})

watch(
  () => [props.view, props.loading, props.error, props.pins] as const,
  () => render(),
)

// ---------------------------------------------------------------------------
// 点位悬停提示：按像素距离命中
// ---------------------------------------------------------------------------

interface HoveredPin {
  x: number
  y: number
  label: string
}

const hoveredPin = ref<HoveredPin | null>(null)
const layoutPx = ref<ReturnType<typeof computeLayout> | null>(null)

function onMouseMove(event: MouseEvent): void {
  const canvas = canvasRef.value
  const layout = layoutPx.value
  if (!canvas || !layout) return
  const rect = canvas.getBoundingClientRect()
  const mx = event.clientX - rect.left
  const my = event.clientY - rect.top

  let hit: HoveredPin | null = null
  for (const pin of props.pins ?? []) {
    const px = layout.offsetX + (pin.cx + 0.5) * layout.tile
    const py = layout.offsetY + (pin.cy + 0.5) * layout.tile
    if (Math.hypot(mx - px, my - py) <= Math.max(8, layout.tile)) {
      hit = { x: px, y: py, label: pin.label }
      break
    }
  }
  hoveredPin.value = hit
}
</script>

<style scoped>
.map-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid #e2e5ea;
  border-radius: 6px;
  background: #ffffff;
  padding: 12px;
  font-family: var(--el-font-family);
  min-width: 0;
}

.map-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.map-card__source {
  font-size: 13px;
  font-weight: 600;
  color: #26292e;
}

.map-card__version {
  font-family: var(--admin-font-mono);
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid #e2e5ea;
  background: #f7f8f9;
  color: #6b7280;
  font-variant-numeric: tabular-nums;
}

.map-card__version.is-diff {
  color: #9a6a08;
  background: #fdf5e7;
  border-color: #efdcb3;
}

.map-card__stage {
  position: relative;
  border: 1px solid #eef0f2;
  border-radius: 4px;
  overflow: hidden;
  background: #f7faf9;
}

.map-card__canvas {
  display: block;
}

.map-card__tooltip {
  position: absolute;
  transform: translate(-50%, calc(-100% - 8px));
  max-width: 280px;
  padding: 4px 8px;
  border-radius: 4px;
  background: rgba(38, 41, 46, 0.92);
  color: #f2f5f4;
  font-size: 11px;
  line-height: 1.5;
  white-space: nowrap;
  pointer-events: none;
  z-index: 3;
}

.map-card__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 24px;
  background: rgba(255, 255, 255, 0.92);
  z-index: 2;
}

.map-card__error {
  text-align: center;
  color: #8a919c;
  font-size: 13px;
}

.map-card__meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 12px;
}

.map-card__dim {
  font-family: var(--admin-font-mono);
  font-size: 12px;
  color: #3a4048;
  font-variant-numeric: tabular-nums;
}

.map-card__hint {
  font-size: 11px;
  color: #9aa3ad;
}

/* 区域图例：与画布着色同源 */
.map-card__legend {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 12px;
}

.map-card__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: #6b7280;
}

.map-card__legend-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  border: 1px solid rgba(0, 0, 0, 0.15);
}

.map-card__legend-name {
  color: #3a4048;
}

.map-card__legend-count {
  font-variant-numeric: tabular-nums;
}
</style>
