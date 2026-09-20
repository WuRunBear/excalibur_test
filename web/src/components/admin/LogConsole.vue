<template>
  <section class="log-console">
    <header class="log-console__bar">
      <div class="log-console__heading">
        <h3 class="log-console__title">{{ consoleTitle }}</h3>
        <span class="log-console__count">{{ rows.length }} 行</span>
        <span
          v-if="paused && pendingCount > 0"
          class="log-console__hold"
        >
          暂停中，已缓冲 {{ pendingCount }} 条
        </span>
      </div>
      <div class="log-console__tools">
        <el-radio-group
          size="small"
          :model-value="filter"
          @update:model-value="onFilterChange"
        >
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="info">信息</el-radio-button>
          <el-radio-button value="warn">警告</el-radio-button>
          <el-radio-button value="error">错误</el-radio-button>
        </el-radio-group>
        <el-button
          size="small"
          text
          @click="togglePause"
        >
          {{ paused ? `继续（${pendingCount}）` : '暂停' }}
        </el-button>
        <el-button
          size="small"
          text
          @click="clearView"
        >
          清屏
        </el-button>
      </div>
    </header>

    <div
      ref="scrollerRef"
      class="log-console__body"
      :style="{ height }"
      @scroll.passive="onScroll"
    >
      <p
        v-if="displayedRows.length === 0"
        class="log-console__empty"
      >
        {{ loading ? '正在回填最近日志…' : '暂无日志，等待实例输出' }}
      </p>
      <div
        v-for="row in displayedRows"
        :key="row.id"
        class="log-console__line"
      >
        <span class="log-console__time">{{ formatClock(row.ts) }}</span>
        <span
          class="log-console__source"
          :class="`log-console__source--${row.source}`"
          >{{ row.source }}</span
        >
        <span
          v-if="row.bucket !== 'info'"
          class="log-console__level"
          :class="`log-console__level--${row.bucket}`"
          >{{ row.bucket === 'warn' ? '警告' : '错误' }}</span
        >
        <span class="log-console__text">{{ row.text }}</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
defineOptions({ name: 'LogConsole' })

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { fetchRecentLogs, subscribeAdminChannel } from '@/api/admin'
import type { AdminSocketHandle, InstanceRole, LogMessage, LogSource } from '@/api/admin'
import { formatClock } from '@/utils/format'

/** 级别归一后的三类桶（debug / 未知级别并入 info）。 */
type LevelBucket = 'info' | 'warn' | 'error'
type FilterKey = 'all' | LevelBucket

interface LogRow {
  id: number
  ts: number
  source: LogSource
  bucket: LevelBucket
  text: string
}

const props = withDefaults(
  defineProps<{
    /** 实例角色（决定 WS 日志频道与回填接口） */
    role: InstanceRole
    /** 控制台标题，缺省按角色生成 */
    title?: string
    /** 日志区高度（任意 CSS 高度值） */
    height?: string
    /** 进页回填的最近行数 */
    backfillLines?: number
  }>(),
  { title: '', height: '380px', backfillLines: 200 },
)

/** 本地视图行数上限：超出丢最旧。 */
const MAX_ROWS = 1000
/** 暂停期间的后台缓冲上限，防止极端场景内存膨胀。 */
const MAX_PENDING = 5000
/** 判定「吸底」的滚动容差（px）。 */
const SCROLL_EPSILON = 24

const consoleTitle = computed(
  () => props.title || (props.role === 'official' ? '正式实例日志' : '预览实例日志'),
)

const rows = ref<LogRow[]>([])
const filter = ref<FilterKey>('all')
const paused = ref(false)
const pendingCount = ref(0)
const loading = ref(false)

const displayedRows = computed(() => {
  const key = filter.value
  if (key === 'all') return rows.value
  return rows.value.filter((row) => row.bucket === key)
})

const scrollerRef = ref<HTMLElement | null>(null)
const stickToBottom = ref(true)

let rowSeq = 0
let backfillDone = false
let backfillInFlight = false
let socketHandle: AdminSocketHandle | null = null
/** 回填完成前到达的 WS 消息缓冲（保证「先历史后增量」的顺序）。 */
const liveBuffer: LogMessage[] = []
/** 暂停期间的后台缓冲，恢复时一次性补上。 */
const pausedBuffer: LogMessage[] = []

function levelBucket(level: string | undefined): LevelBucket {
  return level === 'warn' || level === 'error' ? level : 'info'
}

/** 消息去重键（时间戳 + 来源 + 文本）。 */
function messageKey(msg: LogMessage): string {
  return `${msg.ts}|${msg.source}|${msg.text}`
}

function toRow(msg: LogMessage): LogRow {
  rowSeq += 1
  return {
    id: rowSeq,
    ts: msg.ts,
    source: msg.source,
    bucket: levelBucket(msg.level),
    text: msg.text,
  }
}

/** 追加消息（保序、超限丢最旧），吸底时自动滚动到底。 */
function appendMessages(messages: readonly LogMessage[]): void {
  if (messages.length === 0) return
  const merged = rows.value.concat(messages.map(toRow))
  rows.value = merged.length > MAX_ROWS ? merged.slice(merged.length - MAX_ROWS) : merged
  if (stickToBottom.value && !paused.value) void scrollToBottom()
}

function onScroll(): void {
  const el = scrollerRef.value
  if (!el) return
  // 用户上滚离开底部 → 暂停吸底；回到底部 → 恢复吸底。
  stickToBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_EPSILON
}

async function scrollToBottom(): Promise<void> {
  await nextTick()
  const el = scrollerRef.value
  if (el) el.scrollTop = el.scrollHeight
}

function onWsMessage(payload: unknown): void {
  if (typeof payload !== 'object' || payload === null) return
  const msg = payload as Partial<LogMessage>
  if (msg.role !== props.role || typeof msg.text !== 'string' || typeof msg.ts !== 'number') return
  const normalized: LogMessage = {
    role: msg.role,
    source: msg.source === 'file' || msg.source === 'stderr' ? msg.source : 'stdout',
    ...(msg.level === undefined ? {} : { level: msg.level }),
    text: msg.text,
    ts: msg.ts,
  }
  if (!backfillDone) {
    liveBuffer.push(normalized)
    if (liveBuffer.length > MAX_ROWS) liveBuffer.splice(0, liveBuffer.length - MAX_ROWS)
    return
  }
  if (paused.value) {
    pausedBuffer.push(normalized)
    if (pausedBuffer.length > MAX_PENDING) {
      pausedBuffer.splice(0, pausedBuffer.length - MAX_PENDING)
    }
    pendingCount.value = pausedBuffer.length
    return
  }
  appendMessages([normalized])
}

/**
 * REST 回填。initial：进页 / 首连，先历史后增量（与 liveBuffer 去重合并）；
 * merge：WS 断线重连后的补洞，仅追加本地缺失的行。
 */
async function backfill(mode: 'initial' | 'merge'): Promise<void> {
  if (backfillInFlight) return
  backfillInFlight = true
  if (mode === 'initial') loading.value = true
  try {
    const detail = await fetchRecentLogs(props.role, props.backfillLines)
    if (mode === 'initial') {
      const buffered = liveBuffer.splice(0)
      const keys = new Set(detail.lines.map(messageKey))
      appendMessages([...detail.lines, ...buffered.filter((msg) => !keys.has(messageKey(msg)))])
      backfillDone = true
    } else {
      const keys = new Set(rows.value.map((row) => `${row.ts}|${row.source}|${row.text}`))
      appendMessages(detail.lines.filter((msg) => !keys.has(messageKey(msg))))
    }
  } catch {
    // 回填失败不阻塞 WS 增量；重连成功会自动重试。
  } finally {
    backfillInFlight = false
    if (mode === 'initial') loading.value = false
  }
}

/** 暂停 / 继续。暂停期间 WS 消息仍进后台缓冲，恢复时一次性补上并回到吸底。 */
function togglePause(): void {
  if (!paused.value) {
    paused.value = true
    return
  }
  paused.value = false
  const buffered = pausedBuffer.splice(0)
  pendingCount.value = 0
  if (buffered.length > 0) {
    stickToBottom.value = true
    appendMessages(buffered)
    void scrollToBottom()
  }
}

/** 清屏：仅清本地视图，不影响服务端环形缓冲。 */
function clearView(): void {
  rows.value = []
  pausedBuffer.splice(0)
  pendingCount.value = 0
}

function onFilterChange(value: string | number | boolean | undefined): void {
  filter.value = value as FilterKey
}

watch(filter, () => {
  // 切换级别过滤后保持吸底视角。
  if (stickToBottom.value) void scrollToBottom()
})

onMounted(() => {
  socketHandle = subscribeAdminChannel(`instance:log:${props.role}`, {
    onMessage: onWsMessage,
    onOpen: () => {
      // 首连未完成回填 → 补做；之后的 open 视为断线重连 → 增量补洞。
      void backfill(backfillDone ? 'merge' : 'initial')
    },
  })
  void backfill('initial')
})

onBeforeUnmount(() => {
  socketHandle?.close()
  socketHandle = null
})
</script>

<style scoped>
/* 浅色工具栏 + 深色日志视窗：与仪表盘浅色卡片衔接，日志区保持控制室观感 */
.log-console {
  display: flex;
  flex-direction: column;
  border: 1px solid #e2e5ea;
  border-radius: 6px;
  background: #ffffff;
  overflow: hidden;
}

.log-console__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  background: #f7f8f9;
  border-bottom: 1px solid #e2e5ea;
}

.log-console__heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.log-console__title {
  font-size: 13px;
  font-weight: 600;
  color: #2b2f36;
}

.log-console__count {
  font-size: 12px;
  color: #8a919c;
  font-variant-numeric: tabular-nums;
}

.log-console__hold {
  font-size: 12px;
  color: #d9860c;
}

.log-console__tools {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.log-console__body {
  flex: 1;
  overflow-y: auto;
  background: #101a18;
  padding: 10px 12px;
  font-family: var(--admin-font-mono);
  font-size: 12px;
  line-height: 1.75;
}

.log-console__line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  white-space: pre-wrap;
  word-break: break-all;
}

.log-console__time {
  flex-shrink: 0;
  color: #6e8580;
  font-variant-numeric: tabular-nums;
}

.log-console__source {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: 3px;
  font-size: 10px;
  line-height: 18px;
}

.log-console__source--file {
  color: #9db8b1;
  background: rgba(157, 184, 177, 0.14);
}

.log-console__source--stdout {
  color: #7ed3ae;
  background: rgba(126, 211, 174, 0.1);
}

.log-console__source--stderr {
  color: #ff9d92;
  background: rgba(255, 157, 146, 0.12);
}

.log-console__level {
  flex-shrink: 0;
  font-size: 11px;
}

.log-console__level--warn {
  color: #ffc46b;
}

.log-console__level--error {
  color: #ff8a80;
}

.log-console__text {
  color: #d9e5e1;
}

.log-console__empty {
  padding: 56px 0;
  text-align: center;
  color: #5f7a74;
  font-size: 12px;
}

/* 深色底滚动条 */
.log-console__body::-webkit-scrollbar {
  width: 8px;
}

.log-console__body::-webkit-scrollbar-thumb {
  background: #2b3b37;
  border-radius: 4px;
}

.log-console__body::-webkit-scrollbar-track {
  background: transparent;
}
</style>
