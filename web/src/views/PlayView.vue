<template>
  <div class="ov">
    <header class="ov-bar">
      <div class="ov-bar__row">
        <div class="ov-brand">
          <span class="ov-brand__kicker">OBSERVER</span>
          <h1 class="ov-brand__title">游戏观察</h1>
        </div>

        <div class="ov-tools">
          <!-- 实例目标切换器：切换 = 销毁当前游戏实例并以新目标重建 -->
          <div
            class="ov-switch"
            role="tablist"
            aria-label="观察实例切换"
          >
            <button
              v-for="item in targets"
              :key="item.value"
              type="button"
              role="tab"
              class="ov-switch__btn"
              :class="{ 'ov-switch__btn--active': item.value === currentTarget }"
              :aria-selected="item.value === currentTarget"
              :disabled="busy"
              @click="switchTarget(item.value)"
            >
              {{ item.label }}<span class="ov-switch__port">:{{ item.port }}</span>
            </button>
          </div>

          <i
            class="ov-divider"
            aria-hidden="true"
          />

          <span
            class="ov-endpoint"
            :title="`当前观察实例地址：${endpoint}`"
            >{{ endpoint }}</span
          >

          <span
            class="ov-status"
            :class="`ov-status--${connTone}`"
          >
            <i class="ov-status__dot" />{{ connText }}
          </span>

          <button
            v-if="connState === 'disconnected'"
            type="button"
            class="ov-reconnect"
            :disabled="busy"
            @click="reconnect"
          >
            重连
          </button>
        </div>
      </div>

      <div class="ov-bar__hint">
        <p>WASD / 方向键 移动 · E 交互 · 空格 攻击 · T 对话 · 拖拽画布平移视角 · 滚轮缩放</p>
        <p class="ov-bar__note">加入观察会在游戏内创建一个玩家实体</p>
      </div>
    </header>

    <main class="ov-stage">
      <GameUI
        v-if="!fatalError"
        :bridge="bridge"
      >
        <template #content="{ slotClass }">
          <canvas
            ref="gameCanvas"
            id="gameCanvas"
            :class="slotClass"
          ></canvas>
        </template>
      </GameUI>

      <!-- 初始化 / 切换实例期间的全屏遮罩（销毁重建链路进行中） -->
      <Transition name="veil">
        <div
          v-if="veilText"
          class="ov-veil"
        >
          <span
            class="ov-veil__spinner"
            aria-hidden="true"
          />
          <p class="ov-veil__text">{{ veilText }}</p>
        </div>
      </Transition>

      <!-- 引擎初始化失败的兜底空态（不白屏，可重试） -->
      <div
        v-if="fatalError"
        class="ov-fatal"
        role="alert"
      >
        <p class="ov-fatal__title">游戏实例加载失败</p>
        <p class="ov-fatal__detail">{{ fatalError }}</p>
        <button
          type="button"
          class="ov-fatal__retry"
          @click="retryBoot"
        >
          重试
        </button>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'PlayView' })

import type { GameBridge, GameConnectionStatus, GameController } from 'game/type'
import { destroyGame, initGame } from 'game/index'
import GameUI from 'components/GameUI/Index.vue'
import { resolveServerUrl } from 'net/config'
import type { InstanceTarget } from 'net/config'
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'

/** 目标持久化键：回到页面恢复上次选择。 */
const TARGET_STORAGE_KEY = 'admin:play:target'

interface TargetOption {
  value: InstanceTarget
  label: string
  port: string
}

/** 从 ws 端点提取展示端口（默认端口回退协议缺省值）。 */
function portOf(wsUrl: string): string {
  try {
    const parsed = new URL(wsUrl)
    if (parsed.port) return parsed.port
    return parsed.protocol === 'wss:' ? '443' : '80'
  } catch {
    return '?'
  }
}

function restoreTarget(): InstanceTarget {
  try {
    const raw = localStorage.getItem(TARGET_STORAGE_KEY)
    if (raw === 'official' || raw === 'preview') return raw
  } catch {
    // localStorage 不可用时回退默认目标
  }
  return 'official'
}

function persistTarget(target: InstanceTarget): void {
  try {
    localStorage.setItem(TARGET_STORAGE_KEY, target)
  } catch {
    // 持久化失败不影响本次会话
  }
}

const gameCanvas = ref<HTMLCanvasElement | null>(null)
const bridge = ref<GameBridge | undefined>(undefined)
const currentTarget = ref<InstanceTarget>(restoreTarget())
/** 连接状态（由游戏实例经 bridge 推送；idle/connecting 统一显示「连接中」）。 */
const connState = ref<GameConnectionStatus>('idle')
const booting = ref(true)
const switching = ref(false)
const fatalError = ref('')

const busy = computed(() => booting.value || switching.value)

/** 初始化 / 切换期间的遮罩文案（销毁重建链路进行中）。 */
const veilText = computed(() => {
  if (fatalError.value) return ''
  if (booting.value) return `正在启动 ${targetLabel(currentTarget.value)}…`
  if (switching.value) return `正在切换到 ${targetLabel(currentTarget.value)}…`
  return ''
})

function targetLabel(target: InstanceTarget): string {
  return target === 'official' ? '正式实例' : '预览实例'
}

const targets = computed<TargetOption[]>(() => [
  { value: 'official', label: '正式', port: portOf(resolveServerUrl('official')) },
  { value: 'preview', label: '预览', port: portOf(resolveServerUrl('preview')) },
])

const endpoint = computed(() => resolveServerUrl(currentTarget.value))

const connText = computed(() =>
  connState.value === 'connected'
    ? '已连接'
    : connState.value === 'disconnected'
      ? '已断开'
      : '连接中',
)

/** 语义色调：连接中=蓝（启动中）/ 已连接=绿（运行中）/ 已断开=红（崩溃），对齐管理平台状态色。 */
const connTone = computed(() =>
  connState.value === 'connected'
    ? 'connected'
    : connState.value === 'disconnected'
      ? 'disconnected'
      : 'connecting',
)

let unsubscribeBridge: (() => void) | null = null

function bindBridge(controller: GameController): void {
  bridge.value = controller.bridge
  unsubscribeBridge?.()
  // subscribe 会立即推送一次当前状态与连接状态，无需等待下一条事件。
  unsubscribeBridge = bridge.value.subscribe((event) => {
    if (event.type === 'connection') {
      connState.value = event.status
    }
  })
}

/** 以指定目标启动观察实例（initGame 内部连接 resolveServerUrl 对应端点）。 */
async function boot(target: InstanceTarget): Promise<void> {
  fatalError.value = ''
  if (!gameCanvas.value) {
    fatalError.value = '游戏画布尚未就绪'
    return
  }
  try {
    const controller = await initGame(gameCanvas.value, {
      serverUrl: resolveServerUrl(target),
    })
    bindBridge(controller)
  } catch (err) {
    destroyGame()
    bridge.value = undefined
    fatalError.value = err instanceof Error ? err.message : String(err)
  }
}

async function retryBoot(): Promise<void> {
  booting.value = true
  await boot(currentTarget.value)
  booting.value = false
}

/**
 * 实例切换核心链路：
 * destroyGame() 销毁当前实例（停止引擎 + 离开房间 + 清理订阅）→
 * 以 resolveServerUrl(新目标) 重新 initGame（经 initGame options 注入连接地址）。
 */
async function switchTarget(target: InstanceTarget): Promise<void> {
  if (busy.value || target === currentTarget.value) return
  switching.value = true
  persistTarget(target)
  currentTarget.value = target
  connState.value = 'idle'
  try {
    destroyGame()
    bridge.value = undefined
    // 等一帧让旧实例的清理落地，再在同一 canvas 上重建
    await nextTick()
    await boot(target)
  } finally {
    switching.value = false
  }
}

/** 断线重连：经 bridge 下发 reconnect 指令，由游戏实例按同一目标地址重新连接。 */
function reconnect(): void {
  bridge.value?.dispatch({ type: 'reconnect' })
}

onMounted(async () => {
  await boot(currentTarget.value)
  booting.value = false
})

onUnmounted(() => {
  unsubscribeBridge?.()
  unsubscribeBridge = null
  bridge.value = undefined
  destroyGame()
})
</script>

<style scoped>
/* 观察室底色：深墨青 + 轻微晕影，让游戏画布成为视觉主体 */
.ov {
  position: relative;
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background:
    radial-gradient(120% 90% at 50% 0%, rgba(15, 118, 110, 0.16), transparent 55%),
    radial-gradient(100% 100% at 50% 100%, rgba(0, 0, 0, 0.55), transparent 60%), #0a0f0e;
  color: #cfe0dc;
}

/* ---- 顶部观察控制栏 ---- */
.ov-bar {
  position: relative;
  z-index: 20;
  flex-shrink: 0;
  padding: 8px 20px 7px;
  background: rgba(10, 15, 14, 0.92);
  border-bottom: 1px solid rgba(15, 118, 110, 0.38);
  box-shadow:
    0 1px 0 rgba(15, 118, 110, 0.12),
    0 8px 24px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(8px);
}

.ov-bar__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px 16px;
}

.ov-brand {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.ov-brand__kicker {
  font-family: var(--admin-font-mono);
  font-size: 10px;
  letter-spacing: 3px;
  color: #4f7d76;
}

.ov-brand__title {
  font-family: var(--font-pixel);
  font-size: 17px;
  letter-spacing: 2px;
  color: #e6f2ef;
}

.ov-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

/* 分段切换器（正式 / 预览），墨青高亮激活项 */
.ov-switch {
  display: inline-flex;
  padding: 2px;
  border: 1px solid rgba(15, 118, 110, 0.45);
  border-radius: 6px;
  background: rgba(15, 118, 110, 0.1);
}

.ov-switch__btn {
  appearance: none;
  border: 0;
  background: transparent;
  padding: 3px 12px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 18px;
  color: #7f958f;
  cursor: pointer;
  transition:
    color 140ms ease,
    background-color 140ms ease;
}

.ov-switch__btn:hover:not(:disabled) {
  color: #d8ece8;
}

.ov-switch__btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ov-switch__btn--active {
  background: #0f766e;
  color: #f2fbf9;
}

.ov-switch__port {
  margin-left: 4px;
  font-family: var(--admin-font-mono);
  font-size: 11px;
  opacity: 0.78;
}

.ov-divider {
  width: 1px;
  height: 18px;
  background: rgba(127, 149, 143, 0.28);
}

.ov-endpoint {
  font-family: var(--admin-font-mono);
  font-size: 11px;
  color: #6f8a84;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* 连接状态胶囊：语义色对齐管理平台（连接中=蓝 / 已连接=绿 / 已断开=红） */
.ov-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 10px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 20px;
  white-space: nowrap;
  border: 1px solid transparent;
}

.ov-status__dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: currentColor;
}

.ov-status--connecting {
  color: #8db4f2;
  border-color: rgba(139, 180, 242, 0.35);
  background: rgba(59, 118, 210, 0.14);
}

.ov-status--connecting .ov-status__dot {
  animation: ov-pulse 1.2s ease-in-out infinite;
}

.ov-status--connected {
  color: #7fd8a8;
  border-color: rgba(127, 216, 168, 0.35);
  background: rgba(46, 158, 91, 0.16);
}

.ov-status--disconnected {
  color: #f19999;
  border-color: rgba(241, 153, 153, 0.35);
  background: rgba(214, 69, 69, 0.16);
}

@keyframes ov-pulse {
  50% {
    opacity: 0.3;
  }
}

.ov-reconnect {
  appearance: none;
  border: 1px solid rgba(214, 69, 69, 0.55);
  border-radius: 4px;
  background: rgba(214, 69, 69, 0.14);
  color: #f6b3b3;
  font-size: 12px;
  line-height: 20px;
  padding: 1px 12px;
  cursor: pointer;
  transition:
    background-color 140ms ease,
    color 140ms ease;
}

.ov-reconnect:hover:not(:disabled) {
  background: rgba(214, 69, 69, 0.28);
  color: #ffd4d4;
}

.ov-reconnect:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

/* 操作提示行 */
.ov-bar__hint {
  margin-top: 5px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 2px 16px;
}

.ov-bar__hint p {
  margin: 0;
  font-size: 11px;
  line-height: 16px;
  color: #5f7a74;
  letter-spacing: 0.5px;
}

.ov-bar__note {
  color: #4c635e;
}

/* ---- 游戏舞台 ---- */
.ov-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 16px 16px;
}

/* 切换 / 启动遮罩 */
.ov-veil {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(8, 12, 11, 0.66);
  backdrop-filter: blur(2px);
}

.ov-veil__spinner {
  width: 26px;
  height: 26px;
  border-radius: 999px;
  border: 3px solid rgba(15, 118, 110, 0.25);
  border-top-color: #14b8a6;
  animation: ov-spin 0.9s linear infinite;
}

.ov-veil__text {
  margin: 0;
  font-size: 13px;
  color: #a9c4be;
  letter-spacing: 1px;
}

@keyframes ov-spin {
  to {
    transform: rotate(360deg);
  }
}

.veil-enter-active,
.veil-leave-active {
  transition: opacity 180ms ease;
}

.veil-enter-from,
.veil-leave-to {
  opacity: 0;
}

/* 引擎初始化失败的兜底空态 */
.ov-fatal {
  position: absolute;
  z-index: 31;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 26px 34px;
  border: 1px solid rgba(214, 69, 69, 0.4);
  border-radius: 8px;
  background: rgba(15, 12, 12, 0.92);
  text-align: center;
}

.ov-fatal__title {
  margin: 0;
  font-size: 15px;
  color: #f2b8b8;
}

.ov-fatal__detail {
  margin: 0;
  max-width: 420px;
  font-family: var(--admin-font-mono);
  font-size: 12px;
  color: #8a919c;
  word-break: break-all;
}

.ov-fatal__retry {
  appearance: none;
  border: 1px solid rgba(15, 118, 110, 0.6);
  border-radius: 4px;
  background: #0f766e;
  color: #f2fbf9;
  font-size: 13px;
  line-height: 22px;
  padding: 2px 18px;
  cursor: pointer;
  margin-top: 4px;
}

.ov-fatal__retry:hover {
  background: #0b5d57;
}

@media (prefers-reduced-motion: reduce) {
  .ov-veil__spinner {
    animation-duration: 2.4s;
  }

  .ov-status--connecting .ov-status__dot {
    animation: none;
  }

  .veil-enter-active,
  .veil-leave-active {
    transition: none;
  }
}
</style>
