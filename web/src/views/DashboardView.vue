<template>
  <div class="dash">
    <header class="dash-header">
      <div>
        <h1 class="dash-title">仪表盘</h1>
        <p class="dash-sub">游戏服务端双实例的运行状态与日志</p>
      </div>
      <div class="dash-tools">
        <span
          class="dash-conn"
          :class="`dash-conn--${store.connection}`"
        >
          <i class="dash-conn__dot"></i>{{ CONNECTION_TEXT[store.connection] }}
        </span>
        <el-button
          size="small"
          :loading="refreshing"
          @click="onRefresh"
        >
          刷新
        </el-button>
      </div>
    </header>

    <section class="dash-grid">
      <el-card
        v-for="card in cards"
        :key="card.role"
        class="dash-card"
        shadow="never"
      >
        <template #header>
          <div class="dash-card__head">
            <div class="dash-card__naming">
              <span class="dash-card__kicker">{{ card.role }}</span>
              <h2 class="dash-card__name">{{ card.name }}</h2>
            </div>
            <span
              class="admin-status-badge"
              :class="card.status ? `admin-status-badge--${card.status}` : ''"
            >
              <i class="admin-status-badge__dot"></i>{{ statusText(card) }}
            </span>
          </div>
        </template>

        <el-alert
          v-if="crashDetail(card)"
          class="dash-card__alert"
          :title="crashDetail(card)"
          type="error"
          :closable="false"
          show-icon
        />

        <template v-if="card.snap">
          <div class="dash-card__meta">
            <div class="dash-card__cell">
              <span class="dash-card__label">端口</span>
              <span class="dash-card__value">{{ card.snap.port }}</span>
            </div>
            <div class="dash-card__cell">
              <span class="dash-card__label">PID</span>
              <span class="dash-card__value">{{ card.snap.pid ?? '—' }}</span>
            </div>
            <div class="dash-card__cell">
              <span class="dash-card__label">启动时间</span>
              <span class="dash-card__value">
                {{ card.snap.startedAt ? formatDateTime(card.snap.startedAt) : '—' }}
              </span>
            </div>
            <div class="dash-card__cell">
              <span class="dash-card__label">运行时长</span>
              <span class="dash-card__value">{{ uptimeText(card) }}</span>
            </div>
          </div>

          <div class="dash-card__actions">
            <el-button
              type="primary"
              :disabled="actionDisabled(card.role, 'start')"
              :loading="store.isPending(card.role, 'start')"
              @click="onAction(card.role, 'start')"
            >
              启动
            </el-button>
            <el-button
              :disabled="actionDisabled(card.role, 'restart')"
              :loading="store.isPending(card.role, 'restart')"
              @click="onAction(card.role, 'restart')"
            >
              重启
            </el-button>
            <el-button
              type="danger"
              plain
              :disabled="actionDisabled(card.role, 'stop')"
              :loading="store.isPending(card.role, 'stop')"
              @click="onAction(card.role, 'stop')"
            >
              停止
            </el-button>
          </div>
        </template>

        <el-alert
          v-else-if="store.lastLoadError"
          class="dash-card__alert"
          title="加载实例状态失败"
          type="error"
          :closable="false"
        >
          <div class="dash-card__retry">
            <span>{{ store.lastLoadError }}</span>
            <el-button
              size="small"
              @click="onRefresh"
            >
              重试
            </el-button>
          </div>
        </el-alert>

        <el-skeleton
          v-else
          :rows="4"
          animated
        />
      </el-card>
    </section>

    <section class="dash-grid">
      <LogConsole role="official" />
      <LogConsole role="preview" />
    </section>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'DashboardView' })

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import LogConsole from 'components/admin/LogConsole.vue'
import { INSTANCE_ROLE_LABELS, INSTANCE_STATUS_TEXT } from '@/api/admin'
import type { InstanceRole, InstanceSnapshot, InstanceStatus } from '@/api/admin'
import { useInstanceStore } from '@/stores/instance'
import type { AdminConnectionState, InstanceActionName } from '@/stores/instance'
import { formatDateTime, formatDuration } from '@/utils/format'

const store = useInstanceStore()

/** 连接状态文案。 */
const CONNECTION_TEXT: Record<AdminConnectionState, string> = {
  connecting: '连接中…',
  online: '实时推送',
  polling: '轮询中（5 秒）',
}

interface CardModel {
  role: InstanceRole
  name: string
  status: InstanceStatus | null
  snap: InstanceSnapshot | null
}

const roles = ['official', 'preview'] as const

const cards = computed<CardModel[]>(() =>
  roles.map((role) => ({
    role,
    name: INSTANCE_ROLE_LABELS[role],
    status: store.snapshots[role]?.status ?? null,
    snap: store.snapshots[role],
  })),
)

function statusText(card: CardModel): string {
  return card.status ? INSTANCE_STATUS_TEXT[card.status] : '获取中'
}

/**
 * 崩溃说明文案：进程异常退出，退出码 X / 信号 Y。
 * spawn 失败（如 ENOENT）时后端不记录退出码与信号，给出兜底表述。
 */
function crashDetail(card: CardModel): string | null {
  const snap = card.snap
  if (!snap || snap.status !== 'crashed') return null
  const parts: string[] = []
  if (snap.lastExitCode !== null) parts.push(`退出码 ${snap.lastExitCode}`)
  if (snap.lastSignal !== null) parts.push(`信号 ${snap.lastSignal}`)
  return parts.length > 0
    ? `进程异常退出，${parts.join(' / ')}`
    : '进程异常退出，未记录退出码或信号'
}

/** 运行 / 启动中且已记录启动时间时展示相对时长，其余显示占位符。 */
function uptimeText(card: CardModel): string {
  const snap = card.snap
  if (!snap || !snap.startedAt) return '—'
  if (snap.status !== 'running' && snap.status !== 'starting') return '—'
  return formatDuration(Math.max(0, now.value - snap.startedAt))
}

function actionDisabled(role: InstanceRole, action: InstanceActionName): boolean {
  return store.isBusy(role) || !store.isActionAllowed(role, action)
}

function onAction(role: InstanceRole, action: InstanceActionName): void {
  void store.performAction(role, action)
}

const refreshing = ref(false)

async function onRefresh(): Promise<void> {
  refreshing.value = true
  try {
    await store.refresh()
  } finally {
    refreshing.value = false
  }
}

/** 秒级时钟：仅在任一实例处于 running / starting 时驱动「运行时长」刷新。 */
const now = ref(Date.now())
let clockTimer: number | null = null

watch(
  cards,
  () => {
    const active = cards.value.some(
      (card) => card.status === 'running' || card.status === 'starting',
    )
    if (active && clockTimer === null) {
      clockTimer = window.setInterval(() => {
        now.value = Date.now()
      }, 1000)
    } else if (!active && clockTimer !== null) {
      clearInterval(clockTimer)
      clockTimer = null
    }
  },
  { immediate: true },
)

onMounted(() => {
  void store.ensureLoaded()
})

onBeforeUnmount(() => {
  if (clockTimer !== null) {
    clearInterval(clockTimer)
    clockTimer = null
  }
})
</script>

<style scoped>
.dash {
  max-width: 1440px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  /* 管理内容统一用 Element Plus 系统字体栈，页面标题保留像素字体作品牌呼应 */
  font-family: var(--el-font-family);
}

.dash-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.dash-title {
  font-family: var(--font-pixel);
  font-size: 22px;
  letter-spacing: 2px;
  color: #26292e;
}

.dash-sub {
  margin-top: 2px;
  font-size: 12px;
  color: #8a919c;
}

.dash-tools {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 连接状态胶囊：实时推送=绿 / 轮询=琥珀 / 连接中=灰 */
.dash-conn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 10px;
  border-radius: 999px;
  border: 1px solid var(--admin-status-stopped-border);
  background: var(--admin-status-stopped-bg);
  color: var(--admin-status-stopped);
  font-size: 12px;
  line-height: 20px;
  white-space: nowrap;
}

.dash-conn__dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--admin-dot-stopped);
}

.dash-conn--online {
  color: var(--admin-status-running);
  background: var(--admin-status-running-bg);
  border-color: var(--admin-status-running-border);
}

.dash-conn--online .dash-conn__dot {
  background: var(--admin-dot-running);
}

.dash-conn--polling {
  color: #9a6a08;
  background: #fdf5e7;
  border-color: #efdcb3;
}

.dash-conn--polling .dash-conn__dot {
  background: #d9860c;
}

/* 双列布局：宽屏并列，窄屏纵排 */
.dash-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
}

@media (min-width: 1024px) {
  .dash-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.dash-card :deep(.el-card__header) {
  padding: 12px 16px;
}

.dash-card :deep(.el-card__body) {
  padding: 16px;
}

.dash-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.dash-card__kicker {
  font-family: var(--admin-font-mono);
  font-size: 10px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: #9aa3ad;
}

.dash-card__name {
  margin-top: 2px;
  font-size: 16px;
  color: #26292e;
}

.dash-card__alert {
  margin-bottom: 12px;
}

.dash-card__retry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.dash-card__meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 12px;
}

.dash-card__cell {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  background: #f7f8f9;
  border: 1px solid #eef0f2;
  border-radius: 4px;
}

.dash-card__label {
  font-size: 12px;
  color: #8a919c;
}

.dash-card__value {
  font-family: var(--admin-font-mono);
  font-size: 13px;
  color: #26292e;
  font-variant-numeric: tabular-nums;
}

.dash-card__actions {
  margin-top: 14px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* 入场：双卡轻微上浮渐现，错开 60ms */
.dash-grid > * {
  animation: dash-rise 0.28s ease both;
}

.dash-grid > *:nth-child(2) {
  animation-delay: 60ms;
}

@keyframes dash-rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .dash-grid > * {
    animation: none;
  }
}
</style>
