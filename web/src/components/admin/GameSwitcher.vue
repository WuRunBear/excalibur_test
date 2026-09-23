<template>
  <div
    class="gsw"
    :class="{ 'gsw--collapsed': collapsed }"
  >
    <template v-if="!collapsed">
      <div class="gsw__label">当前游戏</div>
      <el-dropdown
        trigger="click"
        placement="bottom-start"
        popper-class="gsw-popper"
        @visible-change="onVisibleChange"
        @command="onCommand"
      >
        <button
          type="button"
          class="gsw__trigger"
          :aria-label="`切换管理目标游戏（当前：${currentName}）`"
        >
          <i
            class="gsw__dot"
            :class="`gsw__dot--${state}`"
          ></i>
          <span class="gsw__name">{{ currentName }}</span>
          <span class="gsw__caret">▾</span>
        </button>
        <template #dropdown>
          <el-dropdown-menu class="gsw__menu">
            <el-dropdown-item
              v-if="loadFailed"
              :command="'__retry'"
            >
              <span class="gsw__item gsw__item--error">游戏列表加载失败，点击重试</span>
            </el-dropdown-item>
            <template v-else-if="games.length === 0">
              <el-dropdown-item :command="'__manage'">
                <span class="gsw__item">尚无注册游戏，去导入 →</span>
              </el-dropdown-item>
            </template>
            <template v-else>
              <el-dropdown-item
                v-for="game in games"
                :key="game.id"
                :command="game.id"
                :class="{ 'gsw__item--current': game.id === currentGameId }"
              >
                <span class="gsw__item">
                  <i
                    class="gsw__dot"
                    :class="`gsw__dot--${stateOf(game)}`"
                  ></i>
                  <span class="gsw__item__name">{{ game.name }}</span>
                  <span
                    v-if="game.isDefault"
                    class="gsw__tag"
                    >默认</span
                  >
                  <span
                    v-if="game.isImporting"
                    class="gsw__tag gsw__tag--warn"
                    >导入中</span
                  >
                  <span class="gsw__item__ports"
                    >{{ game.ports.official }}/{{ game.ports.preview }}</span
                  >
                </span>
              </el-dropdown-item>
              <li class="gsw__hint">切换只改变管理目标，不会启动或停止实例</li>
              <el-dropdown-item
                divided
                :command="'__manage'"
              >
                <span class="gsw__item gsw__item__manage">管理全部游戏 →</span>
              </el-dropdown-item>
            </template>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </template>

    <template v-else>
      <el-tooltip
        :content="`当前游戏：${currentName}（点击切换）`"
        placement="right"
      >
        <el-dropdown
          trigger="click"
          placement="right-start"
          popper-class="gsw-popper"
          @visible-change="onVisibleChange"
          @command="onCommand"
        >
          <button
            type="button"
            class="gsw__mini"
            aria-label="切换管理目标游戏"
          >
            <i
              class="gsw__dot"
              :class="`gsw__dot--${state}`"
            ></i>
            <span class="gsw__mini__text">{{ currentInitial }}</span>
          </button>
          <template #dropdown>
            <el-dropdown-menu class="gsw__menu">
              <el-dropdown-item
                v-for="game in games"
                :key="game.id"
                :command="game.id"
                :class="{ 'gsw__item--current': game.id === currentGameId }"
              >
                <span class="gsw__item">
                  <i
                    class="gsw__dot"
                    :class="`gsw__dot--${stateOf(game)}`"
                  ></i>
                  <span class="gsw__item__name">{{ game.name }}</span>
                  <span
                    v-if="game.isDefault"
                    class="gsw__tag"
                    >默认</span
                  >
                </span>
              </el-dropdown-item>
              <li class="gsw__hint">切换只改变管理目标，不会启动或停止实例</li>
              <el-dropdown-item
                divided
                :command="'__manage'"
              >
                <span class="gsw__item gsw__item__manage">管理全部游戏 →</span>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </el-tooltip>
    </template>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'GameSwitcher' })

import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'

import type { GameListItem } from '@/api/admin'
import { useGamesStore } from '@/stores/games'
import { sidecarStateOf, type SidecarState } from '@/utils/games'

/**
 * 游戏切换器（T2.10）：导航区全局组件。
 * 列出注册游戏（名字 / sidecar 状态点 / 端口），选中写入 games store 的
 * currentGameId——REST/WS 寻址全局生效。切换只改上下文，不触碰实例启停。
 */
defineProps<{
  /** 侧栏折叠（64px 图标栏）时渲染紧凑形态。 */
  collapsed?: boolean
}>()

const router = useRouter()
const store = useGamesStore()

onMounted(() => {
  void store.ensureLoaded()
})

const games = computed(() => store.games)
const currentGameId = computed(() => store.currentGameId)
const loadFailed = computed(() => store.lastError !== null && store.games.length === 0)

const currentGame = computed(() => store.currentGame)
const currentName = computed(() => currentGame.value?.name ?? '获取中…')
const currentInitial = computed(() => (currentGame.value?.id ?? '?').slice(0, 1).toUpperCase())

const state = computed<SidecarState>(() => {
  const game = currentGame.value
  if (!game) return 'idle'
  return sidecarStateOf(game.sidecar)
})

function stateOf(game: GameListItem): SidecarState {
  return sidecarStateOf(game.sidecar)
}

/** 下拉打开时静默刷新一次列表（状态点保持新鲜；失败静默保留旧数据）。 */
function onVisibleChange(visible: boolean): void {
  if (visible && store.loaded) void store.load()
}

function onCommand(command: string | number | object): void {
  const key = String(command)
  if (key === '__manage') {
    void router.push('/games')
    return
  }
  if (key === '__retry') {
    void store.load()
    return
  }
  if (!store.select(key)) return
  const game = store.gameById(key)
  ElMessage.success(`管理目标已切换到「${game?.name ?? key}」`)
}
</script>

<style scoped>
.gsw {
  padding: 0 8px 10px;
  border-bottom: 1px solid var(--px-border, rgba(38, 41, 46, 0.14));
}

.gsw__label {
  padding: 0 2px 4px;
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--px-muted, #6b7280);
}

/* 触发器：与像素壳同语言的硬边按钮 */
.gsw__trigger {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 2px solid var(--px-text, #26292e);
  background: var(--px-bg, #ffffff);
  color: var(--px-text, #26292e);
  font-size: 13px;
  line-height: 1.4;
  cursor: pointer;
  text-align: left;
}

.gsw__trigger:hover {
  background: var(--px-soft, #f3f4f6);
}

.gsw__trigger:focus-visible {
  outline: 2px solid var(--px-primary, #00a891);
  outline-offset: 1px;
}

.gsw__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gsw__caret {
  font-size: 10px;
  color: var(--px-muted, #6b7280);
}

/* 折叠态：方形小按钮 */
.gsw--collapsed {
  display: flex;
  justify-content: center;
  padding: 0 8px 10px;
}

.gsw__mini {
  display: inline-flex;
  width: 38px;
  height: 38px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  border: 2px solid var(--px-text, #26292e);
  background: var(--px-bg, #ffffff);
  color: var(--px-text, #26292e);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.gsw__mini:hover {
  background: var(--px-soft, #f3f4f6);
}

.gsw__mini:focus-visible {
  outline: 2px solid var(--px-primary, #00a891);
  outline-offset: 1px;
}

/* sidecar 状态点：语义复用管理平台状态色 */
.gsw__dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--admin-dot-stopped);
}

.gsw__dot--alive {
  background: var(--admin-dot-running);
}

.gsw__dot--unavailable {
  background: var(--admin-dot-crashed);
}

.gsw__dot--idle {
  background: var(--admin-dot-stopped);
}

/* 下拉项 */
.gsw__item {
  display: flex;
  width: 260px;
  align-items: center;
  gap: 8px;
}

.gsw__item__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gsw__item__ports {
  font-family: var(--admin-font-mono);
  font-size: 11px;
  color: #8a919c;
  font-variant-numeric: tabular-nums;
}

.gsw__item--current {
  color: var(--el-color-primary);
  font-weight: 600;
  background: var(--el-color-primary-light-9);
}

.gsw__tag {
  flex: none;
  padding: 0 6px;
  border: 1px solid var(--el-color-primary-light-7);
  border-radius: 999px;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-size: 10px;
  line-height: 16px;
}

.gsw__tag--warn {
  border-color: var(--el-color-warning-light-7);
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
}

.gsw__item--error {
  color: var(--el-color-danger);
  width: auto;
}

.gsw__hint {
  padding: 6px 16px 2px;
  font-size: 11px;
  line-height: 1.5;
  color: #9aa3ad;
  list-style: none;
  white-space: normal;
}

.gsw__item__manage {
  width: auto;
  color: var(--el-color-primary);
  font-size: 12px;
}
</style>
