<template>
  <div class="games">
    <header class="games-header">
      <div>
        <h1 class="games-title">游戏管理</h1>
        <p class="games-sub">注册游戏的导入、同步与移除；切换管理目标请使用侧栏的「当前游戏」</p>
      </div>
      <div class="games-tools">
        <el-button
          size="small"
          :loading="store.loading"
          @click="refreshList"
        >
          刷新
        </el-button>
        <el-button
          type="primary"
          @click="importVisible = true"
        >
          导入游戏
        </el-button>
      </div>
    </header>

    <!-- 列表加载失败（无旧数据可展示时整页呈现） -->
    <el-alert
      v-if="store.lastError && store.games.length === 0"
      class="games-alert"
      :title="store.lastError"
      type="error"
      :closable="false"
      show-icon
    >
      <el-button
        size="small"
        @click="refreshList"
      >
        重试
      </el-button>
    </el-alert>

    <!-- 空态：尚无注册游戏（理论不可达——默认游戏始终存在，防御性呈现） -->
    <div
      v-else-if="!store.loading && store.games.length === 0"
      class="games-empty"
    >
      <p class="games-empty__text">尚无注册游戏</p>
      <el-button
        type="primary"
        @click="importVisible = true"
      >
        导入第一个游戏
      </el-button>
    </div>

    <!-- 游戏卡片列表 -->
    <section
      v-else
      class="games-grid"
      aria-label="注册游戏列表"
    >
      <button
        v-for="game in store.games"
        :key="game.id"
        type="button"
        class="games-card"
        :class="{ 'games-card--active': game.id === selectedId }"
        :aria-pressed="game.id === selectedId"
        @click="choose(game.id)"
      >
        <span class="games-card__head">
          <i
            class="games-card__dot"
            :class="`games-card__dot--${stateOf(game)}`"
          ></i>
          <span class="games-card__name">{{ game.name }}</span>
          <span
            v-if="game.isDefault"
            class="games-card__tag"
            >默认</span
          >
          <span
            v-if="game.id === store.currentGameId"
            class="games-card__tag games-card__tag--current"
            >管理中</span
          >
          <span
            v-if="game.isImporting"
            class="games-card__tag games-card__tag--warn"
            >同步中</span
          >
        </span>
        <span class="games-card__meta">
          <span class="games-card__mono">{{ game.id }}</span>
          <span class="games-card__mono"
            >端口 {{ game.ports.official }} / {{ game.ports.preview }}</span
          >
        </span>
        <span
          class="games-card__source games-card__mono"
          :title="formatSourceLine(game.source)"
          >{{ sourceTypeText(game.source) }} · {{ formatSourceLine(game.source) }}</span
        >
        <span class="games-card__synced">同步于 {{ formatTimestamp(game.resolved.syncedAt) }}</span>
      </button>
    </section>

    <!-- 详情：面向「正在查看的游戏」，可与当前管理目标不同 -->
    <section
      v-if="selectedId"
      class="games-detail"
      aria-label="游戏详情"
    >
      <el-skeleton
        v-if="!detail && store.detailLoading"
        class="games-detail__skeleton"
        :rows="5"
        animated
      />

      <el-alert
        v-else-if="!detail && store.detailError"
        class="games-alert"
        :title="store.detailError"
        type="error"
        :closable="false"
        show-icon
      >
        <el-button
          size="small"
          @click="reloadDetail"
        >
          重试
        </el-button>
      </el-alert>

      <template v-else-if="detail">
        <div class="games-detail__head">
          <div class="games-detail__naming">
            <span class="games-detail__kicker">游戏详情</span>
            <h2 class="games-detail__name">{{ detail.name }}</h2>
          </div>
          <div class="games-detail__badges">
            <span
              v-if="detail.isDefault"
              class="games-card__tag"
              >默认</span
            >
            <span
              v-if="detail.id === store.currentGameId"
              class="games-card__tag games-card__tag--current"
              >管理中</span
            >
            <span
              class="admin-status-badge"
              :class="sidecarTone ? `admin-status-badge--${sidecarTone}` : ''"
            >
              <i class="admin-status-badge__dot"></i>{{ sidecarText }}
            </span>
          </div>
          <div class="games-detail__actions">
            <el-button
              size="small"
              type="primary"
              plain
              :loading="syncing"
              @click="onSync"
            >
              {{ syncButtonText }}
            </el-button>
            <el-button
              v-if="detail.source.type === 'local'"
              size="small"
              :disabled="syncing"
              @click="openPathDialog"
            >
              修改路径
            </el-button>
            <el-tooltip
              v-if="detail.isDefault"
              content="默认游戏不可移除（服务端守卫）：需要先把 isDefault 转移给其他游戏"
              placement="top"
            >
              <span class="games-detail__guard">
                <el-button
                  size="small"
                  type="danger"
                  plain
                  disabled
                >
                  移除游戏
                </el-button>
              </span>
            </el-tooltip>
            <el-button
              v-else
              size="small"
              type="danger"
              plain
              :loading="removing"
              :disabled="syncing"
              @click="onRemove"
            >
              移除游戏
            </el-button>
          </div>
        </div>
        <p
          v-if="detail.source.type === 'git'"
          class="games-detail__hint"
        >
          git 源同步包含 fetch、依赖指纹比对与清单重探测，可能需要数分钟。
        </p>

        <el-alert
          v-if="syncNotes"
          class="games-alert"
          type="info"
          :closable="true"
          @close="syncNotes = null"
        >
          <template #title> 最近一次同步的补充说明 </template>
          <ul class="games-detail__notes">
            <li
              v-for="note in syncNotes"
              :key="note"
            >
              {{ note }}
            </li>
          </ul>
        </el-alert>

        <div class="games-detail__grid">
          <!-- 注册信息 -->
          <section class="games-panel">
            <h3 class="games-panel__title">注册信息</h3>
            <div class="games-panel__cells">
              <div class="games-cell">
                <span class="games-cell__label">游戏 ID</span>
                <span class="games-cell__value games-cell__value--mono">{{ detail.id }}</span>
              </div>
              <div class="games-cell">
                <span class="games-cell__label">来源</span>
                <span
                  class="games-cell__value games-cell__value--mono games-cell__value--wrap"
                  :title="formatSourceLine(detail.source)"
                  >{{ sourceTypeText(detail.source) }} · {{ formatSourceLine(detail.source) }}</span
                >
              </div>
              <div class="games-cell">
                <span class="games-cell__label">端口（正式 / 预览）</span>
                <span class="games-cell__value games-cell__value--mono">
                  {{ detail.ports.official }} / {{ detail.ports.preview }}
                </span>
              </div>
              <div class="games-cell">
                <span class="games-cell__label">commit</span>
                <span
                  class="games-cell__value games-cell__value--mono"
                  :title="detail.resolved.commit || undefined"
                  >{{ shortCommit(detail.resolved.commit) }}</span
                >
              </div>
              <div class="games-cell">
                <span class="games-cell__label">同步时间</span>
                <span class="games-cell__value">{{
                  formatTimestamp(detail.resolved.syncedAt)
                }}</span>
              </div>
              <div class="games-cell">
                <span class="games-cell__label">注册时间</span>
                <span class="games-cell__value">{{ formatTimestamp(detail.createdAt) }}</span>
              </div>
            </div>
          </section>

          <!-- sidecar 状态 -->
          <section class="games-panel">
            <h3 class="games-panel__title">sidecar（游戏桥进程）</h3>
            <div class="games-panel__cells">
              <div class="games-cell">
                <span class="games-cell__label">状态</span>
                <span class="games-cell__value">{{ sidecarText }}</span>
              </div>
              <div class="games-cell">
                <span class="games-cell__label">进程 PID</span>
                <span class="games-cell__value games-cell__value--mono">
                  {{ detail.sidecar.client.pid ?? '—' }}
                </span>
              </div>
              <div class="games-cell">
                <span class="games-cell__label">指纹来源</span>
                <span class="games-cell__value">{{ fingerprintSourceText }}</span>
              </div>
              <div class="games-cell">
                <span class="games-cell__label">指纹</span>
                <span
                  class="games-cell__value games-cell__value--mono"
                  :title="detail.sidecar.fingerprint"
                  >{{ shortFingerprint }}</span
                >
              </div>
              <div
                v-if="detail.sidecar.client.spawnFailures > 0"
                class="games-cell"
              >
                <span class="games-cell__label">连续启动失败</span>
                <span class="games-cell__value games-cell__value--mono">
                  {{ detail.sidecar.client.spawnFailures }} 次
                </span>
              </div>
              <div
                v-if="detail.sidecar.client.unavailable"
                class="games-cell games-cell--wide"
              >
                <span class="games-cell__label">不可用原因</span>
                <span class="games-cell__value games-cell__value--danger">
                  {{ detail.sidecar.client.unavailable }}
                </span>
              </div>
            </div>
          </section>
        </div>

        <!-- 接入清单（manifest）：缺失时呈劣化态，引导重新探测 -->
        <section class="games-panel">
          <h3 class="games-panel__title">接入清单（manifest）</h3>
          <template v-if="detail.manifest">
            <div class="games-panel__cells">
              <div class="games-cell">
                <span class="games-cell__label">配置目录 / 入口</span>
                <span class="games-cell__value games-cell__value--mono">
                  {{ detail.manifest.configDir }}/{{ detail.manifest.configEntry }}
                </span>
              </div>
              <div class="games-cell">
                <span class="games-cell__label">存档目录</span>
                <span class="games-cell__value games-cell__value--mono">
                  {{ detail.manifest.savesDir }}
                </span>
              </div>
              <div class="games-cell">
                <span class="games-cell__label">日志目录</span>
                <span class="games-cell__value games-cell__value--mono">
                  {{ detail.manifest.logsDir }}
                </span>
              </div>
              <div class="games-cell">
                <span class="games-cell__label">env 文件</span>
                <span class="games-cell__value games-cell__value--mono">
                  {{ detail.manifest.envFile }}
                </span>
              </div>
              <div class="games-cell">
                <span class="games-cell__label">观察插件</span>
                <span class="games-cell__value games-cell__value--mono">
                  {{ detail.manifest.observer.plugin }}
                </span>
              </div>
              <div class="games-cell">
                <span class="games-cell__label">能力（整装校验 / 地图几何 / 注册表）</span>
                <span class="games-cell__value">
                  {{ capabilityText(detail.manifest) }}
                </span>
              </div>
              <div
                v-if="detail.manifest.observer.clientSchema"
                class="games-cell games-cell--wide"
              >
                <span class="games-cell__label">观察客户端 schema</span>
                <span class="games-cell__value games-cell__value--mono">
                  {{ detail.manifest.observer.clientSchema.source }} →
                  {{ detail.manifest.observer.clientSchema.stateDir }}
                </span>
              </div>
            </div>
            <p class="games-panel__note">
              schema 路由表共 {{ detail.manifest.schemaRoutes.length }} 条，在下方高级字段中编辑。
            </p>
          </template>
          <el-alert
            v-else
            class="games-alert games-alert--inline"
            type="warning"
            :closable="false"
            show-icon
          >
            <template #title> 该游戏尚未生成接入清单（manifest） </template>
            <p class="games-alert__text">
              查看详情不会现场探测（保证读取零副作用）；领域功能在清单生成前不可用。 点击「{{
                syncButtonText
              }}」生成并落盘清单。
            </p>
            <el-button
              size="small"
              type="primary"
              :loading="syncing"
              @click="onSync"
            >
              {{ syncButtonText }}
            </el-button>
          </el-alert>
        </section>

        <!-- 高级字段（可编辑，走 PATCH） -->
        <section
          v-if="detail.manifest"
          class="games-panel"
        >
          <h3 class="games-panel__title">高级字段</h3>
          <p class="games-panel__note games-panel__note--lead">
            启动命令、preview 环境注入变量名、schema 路由表、观察房间名与安装脚本信任开关。
            改动只提交有变化的键，保存后 sidecar 上下文重建。
          </p>
          <GameAdvancedForm :manifest="detail.manifest" />
        </section>
      </template>
    </section>

    <div
      v-else
      class="games-detail games-detail--placeholder"
    >
      <p>从上方选择一个游戏查看详情</p>
    </div>

    <ImportGameDialog
      v-model="importVisible"
      @imported="onImported"
    />

    <!-- 修改路径（local 源）：PATCH source.path + 立即重新探测 -->
    <el-dialog
      v-model="pathDialogVisible"
      title="修改游戏路径"
      width="520px"
      :close-on-click-modal="false"
      @open="openPathDialog"
    >
      <el-form
        label-position="top"
        @submit.prevent
      >
        <el-form-item label="游戏目录路径">
          <el-input
            v-model="pathInput"
            :disabled="pathSaving"
            spellcheck="false"
            placeholder="如 ../game_server_test 或绝对路径"
          />
          <p class="games-path-hint">
            保存后立即按新路径重新探测接入清单与指纹；路径需存在且包含 framework/index.ts。
          </p>
        </el-form-item>
      </el-form>
      <el-alert
        v-if="pathError"
        class="games-alert games-alert--inline"
        :title="pathError"
        type="error"
        :closable="false"
        show-icon
      />
      <template #footer>
        <el-button
          :disabled="pathSaving"
          @click="pathDialogVisible = false"
        >
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="pathSaving"
          @click="confirmPathChange"
        >
          保存并重新探测
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'GamesView' })

import { computed, h, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import GameAdvancedForm from 'components/admin/GameAdvancedForm.vue'
import ImportGameDialog from 'components/admin/ImportGameDialog.vue'
import { AdminApiError } from '@/api/admin'
import type { GameDetail, GameListItem, GameManifest } from '@/api/admin'
import { useGamesStore } from '@/stores/games'
import {
  SIDECAR_STATE_TEXT,
  formatSourceLine,
  shortCommit,
  sidecarStateOf,
  sidecarStateTone,
  sourceTypeText,
} from '@/utils/games'
import { formatTimestamp } from '@/utils/format'

/**
 * 游戏管理页（T2.10）：注册游戏的列表 / 详情 / 导入 / 同步 / 移除。
 * - 列表卡片：名字、sidecar 状态点、来源、端口、同步时间；点选进入详情；
 * - 详情：注册信息与 sidecar 状态、接入清单（缺失时呈劣化态引导重新探测）、
 *   高级字段编辑（GameAdvancedForm，走 PATCH）；
 * - 动作：重新同步（git）/ 重新探测（local）、修改路径（local，PATCH + 重探测）、
 *   移除游戏（二次确认 + workspaces/backups 保留说明）。
 */
const store = useGamesStore()

const selectedId = ref<string | null>(null)
const importVisible = ref(false)
const syncing = ref(false)
const syncNotes = ref<string[] | null>(null)

/** 详情仅在指向当前选中游戏时呈现（避免切换选中后闪现旧游戏数据）。 */
const detail = computed<GameDetail | null>(() =>
  store.detail && store.detail.id === selectedId.value ? store.detail : null,
)

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

function refreshList(): void {
  void store.load()
}

function stateOf(game: GameListItem): string {
  return sidecarStateOf(game.sidecar)
}

/** 首次列表加载后自动选中默认游戏（用户未做过选择时）。 */
watch(
  () => store.loaded,
  (loaded) => {
    if (!loaded || selectedId.value !== null) return
    const target = store.games.find((game) => game.id === store.defaultGameId) ?? store.games[0]
    if (target) choose(target.id)
  },
  { immediate: true },
)

function choose(gameId: string): void {
  selectedId.value = gameId
  syncNotes.value = null
  void store.loadDetail(gameId)
}

function reloadDetail(): void {
  if (selectedId.value) void store.loadDetail(selectedId.value)
}

/** 导入/同步进行中轮询列表（状态点与「同步中」徽标保持新鲜）。 */
let pollTimer: number | null = null

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

watch([importVisible, () => store.importing], ([visible, importing]) => {
  if ((visible || importing) && pollTimer === null) {
    pollTimer = window.setInterval(() => {
      void store.load()
    }, 3000)
  } else if (!visible && !importing && pollTimer !== null) {
    stopPolling()
  }
})

onBeforeUnmount(() => {
  stopPolling()
})

async function onImported(gameId: string): Promise<void> {
  await store.load()
  choose(gameId)
}

// ---------------------------------------------------------------------------
// 详情：sidecar 与指纹文案
// ---------------------------------------------------------------------------

const sidecarText = computed(() =>
  detail.value ? SIDECAR_STATE_TEXT[sidecarStateOf(detail.value.sidecar.client)] : '—',
)

const sidecarTone = computed(() =>
  detail.value ? sidecarStateTone(sidecarStateOf(detail.value.sidecar.client)) : '',
)

const FINGERPRINT_SOURCE_TEXT: Record<string, string> = {
  git: 'git commit（平台 clone）',
  'git-head': 'git HEAD（源目录）',
  'dir-mtime': '目录 mtime（非 git 目录）',
}

const fingerprintSourceText = computed(() =>
  detail.value
    ? (FINGERPRINT_SOURCE_TEXT[detail.value.sidecar.fingerprintSource] ??
      detail.value.sidecar.fingerprintSource)
    : '—',
)

const shortFingerprint = computed(() => {
  const fp = detail.value?.sidecar.fingerprint ?? ''
  return fp ? (fp.length <= 12 ? fp : `${fp.slice(0, 12)}…`) : '—'
})

function capabilityText(manifest: GameManifest): string {
  const flags = [
    manifest.capabilities.wholeConfigValidation ? '整装校验 ✓' : '整装校验 ✗',
    manifest.capabilities.mapGeometry ? '地图几何 ✓' : '地图几何 ✗',
    `注册表 ${manifest.capabilities.registries.length} 类`,
  ]
  return flags.join(' · ')
}

// ---------------------------------------------------------------------------
// 同步 / 重新探测
// ---------------------------------------------------------------------------

const syncButtonText = computed(() => {
  const source = detail.value?.source
  return source && source.type === 'git' ? '重新同步' : '重新探测'
})

async function onSync(): Promise<void> {
  const id = selectedId.value
  if (!id || syncing.value) return
  syncing.value = true
  try {
    const result = await store.runSync(id)
    syncNotes.value = result.notes.length > 0 ? result.notes : null
    const message =
      result.action === 'noop'
        ? '游戏数据已是最新，未做变更'
        : result.action === 'imported'
          ? '接入清单已生成'
          : syncButtonText.value === '重新同步'
            ? '已重新同步'
            : '已重新探测'
    ElMessage.success(message)
  } catch (err) {
    ElMessage.error(err instanceof AdminApiError ? err.message : '同步失败，请稍后重试')
  } finally {
    syncing.value = false
  }
}

// ---------------------------------------------------------------------------
// 修改路径（local 源）
// ---------------------------------------------------------------------------

const pathDialogVisible = ref(false)
const pathInput = ref('')
const pathSaving = ref(false)
const pathError = ref('')

function openPathDialog(): void {
  const current = detail.value
  if (!current || current.source.type !== 'local') return
  pathInput.value = current.source.path
  pathError.value = ''
}

async function confirmPathChange(): Promise<void> {
  const id = selectedId.value
  const current = detail.value
  if (!id || !current || pathSaving.value) return
  const nextPath = pathInput.value.trim()
  if (!nextPath) {
    pathError.value = '路径不能为空'
    return
  }
  if (current.source.type === 'local' && nextPath === current.source.path) {
    pathDialogVisible.value = false
    return
  }
  pathSaving.value = true
  pathError.value = ''
  try {
    await store.savePatch(id, { source: { path: nextPath } })
    // 改路径后立即重新探测：清单与指纹按新路径重建（Q2「修改路径」全流程）
    await store.runSync(id)
    pathDialogVisible.value = false
    ElMessage.success('路径已更新并重新探测')
  } catch (err) {
    pathError.value = err instanceof AdminApiError ? err.message : '路径修改失败，请稍后重试'
  } finally {
    pathSaving.value = false
  }
}

// ---------------------------------------------------------------------------
// 移除游戏（二次确认 + 数据保留说明）
// ---------------------------------------------------------------------------

const removing = ref(false)

async function onRemove(): Promise<void> {
  const current = detail.value
  if (!current || removing.value || current.isDefault) return
  try {
    await ElMessageBox.confirm(
      h('div', { class: 'games-remove' }, [
        h(
          'p',
          null,
          `将移除游戏「${current.name}」（${current.id}）：注册项与平台侧 checkout 数据一并删除。`,
        ),
        h(
          'p',
          null,
          '该游戏的工作区与备份数据保留在服务器原处，不会随移除删除；如需彻底清理请手动处理。',
        ),
        h('p', { class: 'games-remove__warn' }, '此操作不可撤销。'),
      ]),
      {
        title: '移除游戏',
        confirmButtonText: '移除',
        cancelButtonText: '取消',
        type: 'warning',
        confirmButtonClass: 'el-button--danger',
      },
    )
  } catch {
    return // 用户取消
  }
  removing.value = true
  try {
    await store.remove(current.id)
    selectedId.value = null
    syncNotes.value = null
    ElMessage.success(`游戏「${current.name}」已移除`)
  } catch (err) {
    ElMessage.error(err instanceof AdminApiError ? err.message : '移除失败，请稍后重试')
  } finally {
    removing.value = false
  }
}
</script>

<style scoped>
.games {
  max-width: 1440px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  font-family: var(--el-font-family);
}

.games-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.games-title {
  font-family: var(--font-pixel);
  font-size: 22px;
  letter-spacing: 2px;
  color: #26292e;
}

.games-sub {
  margin-top: 2px;
  font-size: 12px;
  color: #8a919c;
}

.games-tools {
  display: flex;
  align-items: center;
  gap: 12px;
}

.games-alert {
  margin: 0;
}

.games-alert--inline {
  margin-top: 10px;
}

.games-alert__text {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.7;
  color: #8a919c;
}

/* 空态 */
.games-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 56px 0;
  border: 1px dashed #d6dbe1;
  border-radius: 8px;
  background: #fbfcfd;
}

.games-empty__text {
  margin: 0;
  font-size: 13px;
  color: #8a919c;
}

/* 卡片列表：自适应多列 */
.games-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}

.games-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border: 1px solid #e2e5ea;
  border-radius: 8px;
  background: #ffffff;
  text-align: left;
  cursor: pointer;
  transition:
    box-shadow 0.18s ease,
    border-color 0.18s ease,
    transform 0.18s ease;
  animation: games-rise 0.28s ease both;
}

.games-card:hover {
  border-color: #c6cdd5;
  box-shadow: 0 2px 10px rgba(38, 41, 46, 0.08);
  transform: translateY(-1px);
}

.games-card:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.games-card--active {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 1px var(--el-color-primary) inset;
}

.games-card__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.games-card__dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--admin-dot-stopped);
}

.games-card__dot--alive {
  background: var(--admin-dot-running);
}

.games-card__dot--unavailable {
  background: var(--admin-dot-crashed);
}

.games-card__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  font-weight: 600;
  color: #26292e;
}

.games-card__tag {
  flex: none;
  padding: 0 6px;
  border: 1px solid var(--el-color-primary-light-7);
  border-radius: 999px;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-size: 10px;
  line-height: 16px;
}

.games-card__tag--current {
  border-color: var(--el-color-success-light-7);
  background: var(--el-color-success-light-9);
  color: var(--el-color-success-dark-2);
}

.games-card__tag--warn {
  border-color: var(--el-color-warning-light-7);
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
}

.games-card__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.games-card__mono {
  font-family: var(--admin-font-mono);
  font-size: 11px;
  color: #6f7780;
  font-variant-numeric: tabular-nums;
}

.games-card__source {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.games-card__synced {
  font-size: 11px;
  color: #9aa3ad;
}

/* 详情区 */
.games-detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid #e2e5ea;
  border-radius: 8px;
  background: #ffffff;
  animation: games-rise 0.28s ease both;
}

.games-detail--placeholder {
  align-items: center;
  justify-content: center;
  padding: 40px 16px;
  border-style: dashed;
  color: #9aa3ad;
  font-size: 13px;
  animation: none;
}

.games-detail__skeleton {
  padding: 4px 2px;
}

.games-detail__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.games-detail__naming {
  min-width: 0;
}

.games-detail__kicker {
  font-family: var(--admin-font-mono);
  font-size: 10px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: #9aa3ad;
}

.games-detail__name {
  margin-top: 2px;
  font-size: 17px;
  color: #26292e;
}

.games-detail__badges {
  display: flex;
  align-items: center;
  gap: 8px;
}

.games-detail__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.games-detail__guard {
  display: inline-flex;
  cursor: not-allowed;
}

.games-detail__hint {
  margin: -4px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: #8a919c;
}

.games-detail__notes {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  font-size: 12px;
  line-height: 1.8;
  color: #5f6670;
}

.games-detail__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
}

@media (min-width: 1024px) {
  .games-detail__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

/* 信息面板 */
.games-panel {
  padding: 12px 14px 14px;
  border: 1px solid #eef0f2;
  border-radius: 6px;
  background: #fbfcfd;
}

.games-panel__title {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: #26292e;
}

.games-panel__cells {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 10px;
}

.games-cell {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid #eef0f2;
  border-radius: 4px;
  background: #ffffff;
  min-width: 0;
}

.games-cell--wide {
  grid-column: 1 / -1;
}

.games-cell__label {
  flex: none;
  font-size: 12px;
  color: #8a919c;
}

.games-cell__value {
  font-size: 12px;
  color: #26292e;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.games-cell__value--mono {
  font-family: var(--admin-font-mono);
  font-variant-numeric: tabular-nums;
}

.games-cell__value--wrap {
  white-space: normal;
  word-break: break-all;
}

.games-cell__value--danger {
  color: var(--el-color-danger);
}

.games-panel__note {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: #8a919c;
}

.games-panel__note--lead {
  margin: -4px 0 10px;
}

.games-path-hint {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: #8a919c;
}

/* 入场：卡片轻微上浮渐现 */
@keyframes games-rise {
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
  .games-card,
  .games-detail {
    animation: none;
    transition: none;
  }
}
</style>

<style>
/* ElMessageBox 内容非 scoped 渲染，移除确认段落样式放全局（类名前缀防碰撞） */
.games-remove p {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.7;
  color: #26292e;
}

.games-remove .games-remove__warn {
  color: var(--el-color-danger);
}
</style>
