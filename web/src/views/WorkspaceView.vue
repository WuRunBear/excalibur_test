<template>
  <div class="ws">
    <header class="ws-header">
      <div>
        <h1 class="ws-title">工作区</h1>
        <p class="ws-sub">工作区是本体游戏的隔离副本，所有修改只作用于副本，本体无痕。</p>
      </div>
      <el-button
        type="primary"
        :disabled="store.mutating"
        @click="openCreate"
      >
        新建工作区
      </el-button>
    </header>

    <el-alert
      v-if="store.lastError"
      class="ws-alert"
      type="error"
      :closable="false"
    >
      <div class="ws-alert__body">
        <span>{{ store.lastError }}</span>
        <el-button
          size="small"
          @click="store.load()"
        >
          重试
        </el-button>
      </div>
    </el-alert>

    <div
      v-if="store.loading && store.items.length === 0"
      class="ws-grid"
    >
      <el-card
        v-for="i in 2"
        :key="i"
        shadow="never"
      >
        <el-skeleton
          :rows="3"
          animated
        />
      </el-card>
    </div>

    <el-empty
      v-else-if="store.items.length === 0"
      description="还没有工作区，新建一个开始改配置"
    >
      <el-button
        type="primary"
        :disabled="store.mutating"
        @click="openCreate"
      >
        新建工作区
      </el-button>
    </el-empty>

    <div
      v-else
      class="ws-grid"
    >
      <el-card
        v-for="ws in store.items"
        :key="ws.id"
        class="ws-card"
        :class="{ 'is-active': ws.id === store.activeId }"
        shadow="never"
      >
        <div class="ws-card__head">
          <h2 class="ws-card__name">{{ ws.name }}</h2>
          <span
            v-if="ws.id === store.activeId"
            class="ws-active"
          >
            <i class="ws-active__dot"></i>活动中
          </span>
        </div>

        <dl class="ws-card__meta">
          <div class="ws-card__row">
            <dt>创建时间</dt>
            <dd>{{ formatCreatedAt(ws.createdAt) }}</dd>
          </div>
          <div class="ws-card__row">
            <dt>改动文件</dt>
            <dd>
              <button
                class="ws-changes"
                type="button"
                title="查看改动"
                @click="openChanges(ws)"
              >
                {{ ws.changedFiles }} 个
              </button>
            </dd>
          </div>
        </dl>

        <div class="ws-card__actions">
          <el-button
            size="small"
            type="primary"
            plain
            :disabled="ws.id === store.activeId || store.mutating"
            @click="onActivate(ws)"
          >
            切换
          </el-button>
          <el-button
            size="small"
            :disabled="store.mutating"
            @click="openRename(ws)"
          >
            重命名
          </el-button>
          <el-button
            size="small"
            :disabled="store.mutating"
            @click="openChanges(ws)"
          >
            查看改动
          </el-button>
          <el-button
            size="small"
            type="danger"
            plain
            :disabled="store.mutating"
            @click="onDelete(ws)"
          >
            删除
          </el-button>
        </div>
      </el-card>
    </div>

    <!-- S4-B：落盘审查 + 备份回滚（页内页签，不开新路由） -->
    <el-tabs
      v-model="activeTab"
      class="ws-tabs"
    >
      <el-tab-pane name="apply">
        <template #label>
          <span class="ws-tab">
            落盘审查
            <span
              v-if="pendingCount > 0"
              class="ws-tab__count"
              >{{ pendingCount }}</span
            >
          </span>
        </template>
        <ApplyReviewPanel />
      </el-tab-pane>
      <el-tab-pane
        lazy
        name="backups"
        label="备份与回滚"
      >
        <BackupsPanel />
      </el-tab-pane>
    </el-tabs>

    <el-dialog
      v-model="dialogVisible"
      :title="dialogMode === 'create' ? '新建工作区' : '重命名工作区'"
      width="420px"
      @closed="renameTarget = null"
      @close="dialogName = ''"
    >
      <el-input
        v-model="dialogName"
        maxlength="40"
        show-word-limit
        placeholder="工作区名称，例如：玩法实验-A"
        @keydown.enter="onDialogConfirm"
      />
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="store.mutating"
          :disabled="!dialogName.trim()"
          @click="onDialogConfirm"
        >
          {{ dialogMode === 'create' ? '创建' : '保存' }}
        </el-button>
      </template>
    </el-dialog>

    <el-drawer
      v-model="drawerVisible"
      :title="drawerTitle"
      size="440px"
    >
      <div
        v-loading="changesLoading"
        class="ws-drawer"
      >
        <el-empty
          v-if="!changesLoading && changes.length === 0"
          description="无改动文件"
        />
        <ul
          v-else
          class="ws-change-list"
        >
          <li
            v-for="change in changes"
            :key="change.path"
            class="ws-change"
          >
            <span class="ws-change__path">{{ change.path }}</span>
            <el-tag
              size="small"
              :type="workspaceChangeTagType(change.status)"
            >
              {{ WORKSPACE_CHANGE_TEXT[change.status] }}
            </el-tag>
          </li>
        </ul>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'WorkspaceView' })

import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import BackupsPanel from 'components/admin/BackupsPanel.vue'
import ApplyReviewPanel from 'components/admin/ApplyReviewPanel.vue'
import { fetchWorkspaceChanges } from '@/api/admin'
import type { WorkspaceChange, WorkspaceMeta } from '@/api/admin'
import { useWorkspaceStore } from '@/stores/workspace'
import { formatTimestamp } from '@/utils/format'
import { WORKSPACE_CHANGE_TEXT, workspaceChangeTagType } from '@/utils/workspace'

const store = useWorkspaceStore()

// S4-B：页签状态与改动数徽标
const activeTab = ref<'apply' | 'backups'>('apply')
const pendingCount = computed(() => store.activeWorkspace?.changedFiles ?? 0)

onMounted(() => {
  void store.ensureLoaded()
})

/** 契约约定 createdAt 为 epoch ms；对 ISO 字符串做兜底解析。 */
function formatCreatedAt(value: number | string): string {
  return formatTimestamp(value)
}

// ---------------------------------------------------------------------------
// 新建 / 重命名对话框
// ---------------------------------------------------------------------------

const dialogVisible = ref(false)
const dialogMode = ref<'create' | 'rename'>('create')
const dialogName = ref('')
let renameTarget: WorkspaceMeta | null = null

function openCreate(): void {
  dialogMode.value = 'create'
  dialogName.value = ''
  dialogVisible.value = true
}

function openRename(ws: WorkspaceMeta): void {
  dialogMode.value = 'rename'
  renameTarget = ws
  dialogName.value = ws.name
  dialogVisible.value = true
}

async function onDialogConfirm(): Promise<void> {
  const name = dialogName.value.trim()
  if (!name) return
  if (dialogMode.value === 'create') {
    if (await store.create(name)) dialogVisible.value = false
    return
  }
  if (renameTarget && (await store.rename(renameTarget.id, name))) {
    dialogVisible.value = false
  }
}

// ---------------------------------------------------------------------------
// 激活 / 删除
// ---------------------------------------------------------------------------

async function onActivate(ws: WorkspaceMeta): Promise<void> {
  await store.activate(ws.id)
}

async function onDelete(ws: WorkspaceMeta): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除工作区「${ws.name}」仅移除隔离副本与其改动记录，本体游戏文件不受影响（本体无痕）。`,
      '删除工作区',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
  } catch {
    return
  }
  await store.remove(ws.id)
}

// ---------------------------------------------------------------------------
// 改动抽屉
// ---------------------------------------------------------------------------

const drawerVisible = ref(false)
const drawerTitle = ref('工作区改动')
const changes = ref<WorkspaceChange[]>([])
const changesLoading = ref(false)

async function openChanges(ws: WorkspaceMeta): Promise<void> {
  drawerTitle.value = `工作区改动 · ${ws.name}`
  drawerVisible.value = true
  changesLoading.value = true
  changes.value = []
  try {
    changes.value = (await fetchWorkspaceChanges(ws.id)).files
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '获取改动文件失败')
  } finally {
    changesLoading.value = false
  }
}
</script>

<style scoped>
.ws {
  max-width: 1440px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  font-family: var(--el-font-family);
}

.ws-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.ws-title {
  font-family: var(--font-pixel);
  font-size: 22px;
  letter-spacing: 2px;
  color: #26292e;
}

.ws-sub {
  margin-top: 2px;
  font-size: 12px;
  color: #8a919c;
}

/* 落盘审查 / 备份回滚页签 */
.ws-tabs :deep(.el-tabs__header) {
  margin-bottom: 12px;
}

.ws-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.ws-tab__count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: #d9860c;
  color: #ffffff;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.ws-alert__body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

/* 卡片栅格：自适应列数 */
.ws-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}

.ws-card :deep(.el-card__body) {
  padding: 16px;
}

.ws-card.is-active {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 1px var(--el-color-primary-light-7) inset;
}

.ws-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.ws-card__name {
  font-size: 16px;
  color: #26292e;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 活动标记：墨青浅底胶囊 */
.ws-active {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 10px;
  border-radius: 999px;
  border: 1px solid var(--el-color-primary-light-7);
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-size: 12px;
  line-height: 20px;
  white-space: nowrap;
  flex-shrink: 0;
}

.ws-active__dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--el-color-primary);
}

.ws-card__meta {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ws-card__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  background: #f7f8f9;
  border: 1px solid #eef0f2;
  border-radius: 4px;
}

.ws-card__row dt {
  font-size: 12px;
  color: #8a919c;
}

.ws-card__row dd {
  font-size: 13px;
  color: #26292e;
  font-variant-numeric: tabular-nums;
}

/* 改动文件数：可点击的链接样式 */
.ws-changes {
  padding: 0;
  border: none;
  background: none;
  font-size: 13px;
  font-family: var(--admin-font-mono);
  color: var(--el-color-primary);
  cursor: pointer;
}

.ws-changes:hover {
  text-decoration: underline;
}

.ws-card__actions {
  margin-top: 14px;
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 0;
}

/* 改动抽屉 */
.ws-drawer {
  min-height: 200px;
}

.ws-change-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ws-change {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid #eef0f2;
  border-radius: 4px;
  background: #fafbfc;
}

.ws-change__path {
  font-family: var(--admin-font-mono);
  font-size: 12px;
  color: #3a4048;
  word-break: break-all;
  min-width: 0;
}
</style>
