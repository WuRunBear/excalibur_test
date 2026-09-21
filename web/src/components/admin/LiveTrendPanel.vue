<template>
  <section class="trend">
    <header class="trend__bar">
      <div class="trend__heading">
        <h3 class="trend__title">运行趋势</h3>
        <span class="trend__sub"
          >游戏实例每秒采样：tick 速率与实体总数（观察者可见实体数，最近
          {{ LIVE_WINDOW }} 点）</span
        >
      </div>
      <div class="trend__tools">
        <span
          class="trend__conn"
          :class="`trend__conn--${connTone}`"
        >
          <i class="trend__conn__dot"></i>{{ connText }}
        </span>
        <el-radio-group
          size="small"
          :model-value="view"
          @update:model-value="onViewChange"
        >
          <el-radio-button value="both">双列并排</el-radio-button>
          <el-radio-button value="official">正式</el-radio-button>
          <el-radio-button value="preview">预览</el-radio-button>
        </el-radio-group>
      </div>
    </header>

    <div class="trend__charts">
      <div
        v-for="panel in panels"
        :key="panel.key"
        class="trend__panel"
      >
        <div class="trend__panel-head">
          <span class="trend__panel-title">{{ panel.title }}</span>
          <span class="trend__panel-unit">{{ panel.unit }}</span>
        </div>
        <div class="trend__plot">
          <div
            :ref="panel.setPlotEl"
            class="trend__canvas"
          ></div>

          <!-- 实例停止：图表冻结并在图上标注 -->
          <span
            v-if="frozenText"
            class="trend__frozen"
          >
            <i class="trend__frozen__dot"></i>{{ frozenText }}
          </span>

          <!-- 空态 / 回填态 -->
          <p
            v-if="emptyText"
            class="trend__empty"
          >
            {{ emptyText }}
          </p>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
defineOptions({ name: 'LiveTrendPanel' })

import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { ECharts, EChartsCoreOption } from 'echarts/core'
import type { ComponentPublicInstance, Ref } from 'vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { INSTANCE_ROLE_LABELS } from '@/api/admin'
import type { InstanceRole, LiveSample } from '@/api/admin'
import { LIVE_WINDOW, useLiveStore } from '@/stores/live'
import { useInstanceStore } from '@/stores/instance'
import { formatClock } from '@/utils/format'

// ECharts 按需引入：仅 Line + 必要组件（体积与加载时间友好）
echarts.use([
  LineChart,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  CanvasRenderer,
])

/** 趋势视图：双列并排（双角色同图）或单角色。 */
type TrendView = 'both' | InstanceRole

/** 墨青体系系列色：正式=墨青主色 / 预览=琥珀点缀（同仪表盘状态色系）。 */
const SERIES_COLORS: Record<InstanceRole, string> = {
  official: '#0f766e',
  preview: '#d9860c',
}

const AXIS_LABEL = '#8a919c'
const SPLIT_LINE = '#eef0f2'
const TOOLTIP_BG = '#101a18'
const TOOLTIP_BORDER = '#2b3b37'
const TOOLTIP_TEXT = '#d9e5e1'

const store = useLiveStore()
const instanceStore = useInstanceStore()

const view = ref<TrendView>('both')

const selectedRoles = computed<InstanceRole[]>(() =>
  view.value === 'both' ? ['official', 'preview'] : [view.value],
)

function onViewChange(value: string | number | boolean | undefined): void {
  view.value = (value as TrendView) ?? 'both'
}

/** 图表面板描述（两张图共用一套构建逻辑）。 */
interface PanelSpec {
  key: 'tickRate' | 'entityCount'
  title: string
  unit: string
  pick: (sample: LiveSample) => number
  baseline: number | null
  area: boolean
  plotEl: Ref<HTMLDivElement | null>
  /** 稳定的函数 ref：v-for 中必须用函数 ref（对象 ref 会被 Vue 3.5 的 setRef 收集成数组）。 */
  setPlotEl: (el: Element | ComponentPublicInstance | null) => void
  chart: ECharts | null
}

const tickPlotEl = ref<HTMLDivElement | null>(null)
const entityPlotEl = ref<HTMLDivElement | null>(null)

/** 把模板函数 ref 收到的元素写入 panel.plotEl（卸载时收到 null）。 */
function makePlotRefSetter(panel: PanelSpec): PanelSpec['setPlotEl'] {
  return (el) => {
    panel.plotEl.value = el instanceof HTMLDivElement ? el : null
  }
}

const panels: PanelSpec[] = [
  {
    key: 'tickRate',
    title: 'tick 速率',
    unit: 'tick/s',
    pick: (s) => s.tickRate,
    baseline: 20,
    area: false,
    plotEl: tickPlotEl,
    setPlotEl: null as unknown as PanelSpec['setPlotEl'],
    chart: null,
  },
  {
    key: 'entityCount',
    title: '实体总数',
    unit: '个',
    pick: (s) => s.entityCount,
    baseline: null,
    area: true,
    plotEl: entityPlotEl,
    setPlotEl: null as unknown as PanelSpec['setPlotEl'],
    chart: null,
  },
]

// 函数 ref 必须是稳定引用：组件因响应式数据重渲染时，换新函数会先以 null 回调旧 ref、
// 再以元素回调新 ref，导致 plotEl 抖动。panels 为静态数组，这里一次性绑定。
for (const panel of panels) panel.setPlotEl = makePlotRefSetter(panel)

/** WS 通道聚合状态：任一选中角色断开 → offline；任一未回填 → connecting。 */
const connTone = computed(() => {
  const roles = selectedRoles.value
  if (roles.some((role) => store.wsState[role] === 'offline')) return 'offline'
  if (roles.some((role) => !store.backfillDone[role])) return 'connecting'
  return 'online'
})

const connText = computed(
  () => ({ connecting: '连接中…', online: '实时推送', offline: '已断开，重连中' })[connTone.value],
)

/**
 * 实例停止标注：选中的角色中存在「已知且非运行/启动中」的实例时，
 * 图表不再有新采样（冻结），在图上直接标注。
 */
const frozenRoles = computed<InstanceRole[]>(() =>
  selectedRoles.value.filter((role) => {
    const status = instanceStore.snapshots[role]?.status
    return status !== undefined && status !== null && status !== 'running' && status !== 'starting'
  }),
)

const frozenText = computed(() => {
  if (frozenRoles.value.length === 0) return ''
  const names = frozenRoles.value.map((role) => INSTANCE_ROLE_LABELS[role])
  return `${names.join('、')}未运行，数据已冻结`
})

/** 空态：回填中 / 已回填但无采样。 */
const emptyText = computed(() => {
  const roles = selectedRoles.value
  if (roles.some((role) => store.windowOf(role).length > 0)) return ''
  if (roles.some((role) => !store.backfillDone[role])) return '正在回填采样数据…'
  if (connTone.value === 'offline') return '连接已断开，等待重连后补拉数据…'
  return '暂无采样数据，等待实例产生采样'
})

function buildOption(panel: PanelSpec): EChartsCoreOption {
  const roles = selectedRoles.value
  const single = roles.length === 1
  const series = roles.map((role) => {
    const color = SERIES_COLORS[role]
    return {
      name: single ? panel.title : INSTANCE_ROLE_LABELS[role],
      type: 'line' as const,
      smooth: true,
      showSymbol: false,
      lineStyle: { width: 1.5, color },
      itemStyle: { color },
      ...(panel.area
        ? { areaStyle: { color: hexToRgba(color, 0.16), origin: 'start' as const } }
        : {}),
      ...(panel.baseline !== null
        ? {
            markLine: {
              silent: true,
              symbol: 'none',
              lineStyle: { color: '#b9c6c3', type: 'dashed' as const, width: 1 },
              label: {
                formatter: `基线 ${panel.baseline}`,
                color: AXIS_LABEL,
                fontSize: 10,
                position: 'insideEndTop' as const,
              },
              data: [{ yAxis: panel.baseline }],
            },
          }
        : {}),
      data: store.windowOf(role).map((sample) => [sample.ts, panel.pick(sample)]),
    }
  })

  return {
    animationDurationUpdate: 220,
    grid: { left: 46, right: 18, top: single ? 26 : 34, bottom: 26 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: TOOLTIP_BG,
      borderColor: TOOLTIP_BORDER,
      textStyle: { color: TOOLTIP_TEXT, fontSize: 12 },
      formatter: (params: unknown) => {
        const list = (Array.isArray(params) ? params : [params]) as {
          seriesName: string
          value: [number, number]
          color: string
        }[]
        const first = list[0]
        if (!first) return ''
        const head = formatClock(first.value[0])
        const rows = list
          .map(
            (item) =>
              `<div style="display:flex;align-items:center;gap:6px;margin-top:2px">` +
              `<span style="width:8px;height:8px;border-radius:2px;background:${item.color}"></span>` +
              `<span>${item.seriesName}</span>` +
              `<span style="margin-left:auto;padding-left:14px;font-variant-numeric:tabular-nums">${item.value[1]}</span>` +
              `<span style="color:#8a919c">${panel.unit}</span></div>`,
          )
          .join('')
        return `<div style="min-width:150px">${head}${rows}</div>`
      },
    },
    legend: {
      show: !single,
      top: 0,
      left: 'right',
      icon: 'rect',
      itemWidth: 12,
      itemHeight: 3,
      itemGap: 14,
      textStyle: { color: AXIS_LABEL, fontSize: 11 },
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: '#dcdfe4' } },
      axisTick: { show: false },
      axisLabel: {
        color: AXIS_LABEL,
        fontSize: 10,
        hideOverlap: true,
        formatter: (value: number) => formatClock(value),
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      name: panel.unit,
      nameTextStyle: { color: AXIS_LABEL, fontSize: 10, padding: [0, 24, 0, 0] },
      axisLabel: { color: AXIS_LABEL, fontSize: 10 },
      splitLine: { lineStyle: { color: SPLIT_LINE } },
      scale: true,
    },
    series,
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** 增量更新：仅 setOption 推新数据，不重建图表实例（新点推入、旧点滑出）。 */
function renderPanels(): void {
  for (const panel of panels) {
    if (!panel.chart) continue
    try {
      panel.chart.setOption(buildOption(panel), { notMerge: false })
    } catch (error) {
      // 单图更新失败只降级该图，不中断采样推送循环
      console.error(`[LiveTrendPanel] 更新图表失败（${panel.key}）:`, error)
    }
  }
}

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  // 双角色都订阅并回填（切换视图无需重建数据流，WS 消息量级为每角色 1 条/秒）
  store.ensureRole('official')
  store.ensureRole('preview')

  for (const panel of panels) {
    const el = panel.plotEl.value
    // 前置校验：v-for ref 未就绪或被收集成数组时绝不把非法值喂给 echarts，
    // 单图初始化失败也不允许炸掉整个 mounted（会中断 post-flush 队列、连累页面其余加载）。
    if (!(el instanceof HTMLElement)) continue
    try {
      panel.chart = echarts.init(el)
      panel.chart.setOption(buildOption(panel))
    } catch (error) {
      console.error(`[LiveTrendPanel] 初始化图表失败（${panel.key}）:`, error)
    }
  }

  renderPanels()

  resizeObserver = new ResizeObserver(() => {
    for (const panel of panels) panel.chart?.resize()
  })
  for (const panel of panels) {
    const el = panel.plotEl.value
    if (el instanceof HTMLElement) resizeObserver.observe(el)
  }
})

// 采样缓冲原地追加（环形）+ 视图切换 → 增量 setOption，不重建图表实例
watch([() => store.samples, view], () => renderPanels(), { deep: true })

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  // 释放 ECharts 实例，避免容器卸载后内存泄漏
  for (const panel of panels) {
    panel.chart?.dispose()
    panel.chart = null
  }
})
</script>

<style scoped>
.trend {
  display: flex;
  flex-direction: column;
  border: 1px solid #e2e5ea;
  border-radius: 6px;
  background: #ffffff;
  overflow: hidden;
}

.trend__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  background: #f7f8f9;
  border-bottom: 1px solid #e2e5ea;
}

.trend__heading {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.trend__title {
  font-size: 13px;
  font-weight: 600;
  color: #2b2f36;
}

.trend__sub {
  font-size: 12px;
  color: #8a919c;
}

.trend__tools {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* WS 状态胶囊：与仪表盘连接态同语义（绿=实时 / 蓝=连接中 / 琥珀=断开重连） */
.trend__conn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 10px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 20px;
  white-space: nowrap;
  border: 1px solid #dcdfe4;
  color: #5f6670;
  background: #f2f3f5;
}

.trend__conn__dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: #9aa0a8;
}

.trend__conn--online {
  color: var(--admin-status-running);
  background: var(--admin-status-running-bg);
  border-color: var(--admin-status-running-border);
}

.trend__conn--online .trend__conn__dot {
  background: var(--admin-dot-running);
}

.trend__conn--connecting {
  color: var(--admin-status-starting);
  background: var(--admin-status-starting-bg);
  border-color: var(--admin-status-starting-border);
}

.trend__conn--connecting .trend__conn__dot {
  background: var(--admin-dot-starting);
  animation: trend-blink 1.2s ease-in-out infinite;
}

.trend__conn--offline {
  color: #9a6a08;
  background: #fdf5e7;
  border-color: #efdcb3;
}

.trend__conn--offline .trend__conn__dot {
  background: #d9860c;
  animation: trend-blink 0.9s steps(2, start) infinite;
}

@keyframes trend-blink {
  50% {
    opacity: 0.3;
  }
}

/* 双列并排：宽屏两图并排，窄屏纵排 */
.trend__charts {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0;
}

@media (min-width: 1024px) {
  .trend__charts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .trend__panel + .trend__panel {
    border-left: 1px solid #eef0f2;
  }
}

.trend__panel {
  padding: 10px 12px 12px;
}

.trend__panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}

.trend__panel-title {
  font-size: 12px;
  font-weight: 600;
  color: #4b5158;
}

.trend__panel-unit {
  font-family: var(--admin-font-mono);
  font-size: 10px;
  letter-spacing: 1px;
  color: #9aa3ad;
}

.trend__plot {
  position: relative;
}

.trend__canvas {
  width: 100%;
  height: 240px;
}

.trend__frozen {
  position: absolute;
  top: 6px;
  left: 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 10px;
  border-radius: 999px;
  border: 1px solid var(--admin-status-crashed-border);
  background: var(--admin-status-crashed-bg);
  color: var(--admin-status-crashed);
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
}

.trend__frozen__dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--admin-dot-crashed);
}

.trend__empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  font-size: 12px;
  color: #8a919c;
  background: rgba(255, 255, 255, 0.6);
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .trend__conn__dot {
    animation: none !important;
  }
}
</style>
