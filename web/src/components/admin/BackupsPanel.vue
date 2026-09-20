<template>
  <div class="bk">
    <div class="bk-head">
      <p class="bk-head__hint">
        落盘时被覆盖或删除的本体文件会自动备份；回滚会把备份内容写回本体，其后落盘的后续改动需重新执行。
      </p>
      <el-button
        size="small"
        :loading="applyStore.backupsLoading"
        @click="applyStore.loadBackups()"
      >
        刷新
      </el-button>
    </div>

    <el-alert
      v-if="applyStore.backupsError"
      type="error"
      :closable="false"
    >
      <div class="bk-alert__body">
        <span>{{ applyStore.backupsError }}</span>
        <el-button
          size="small"
          @click="applyStore.loadBackups()"
        >
          重试
        </el-button>
      </div>
    </el-alert>

    <el-skeleton
      v-else-if="applyStore.backupsLoading && applyStore.backups.length === 0"
      :rows="4"
      animated
    />

    <el-empty
      v-else-if="applyStore.backups.length === 0"
      description="暂无备份（落盘后自动创建）"
      :image-size="80"
    />

    <ul
      v-else
      class="bk-list"
    >
      <li
        v-for="backup in applyStore.backups"
        :key="backup.backupId"
        class="bk-item"
      >
        <div class="bk-item__row">
          <button
            class="bk-item__toggle"
            type="button"
            :aria-label="expanded(backup.backupId) ? '收起明细' : '展开明细'"
            @click="toggleExpand(backup.backupId)"
          >
            {{ expanded(backup.backupId) ? '▾' : '▸' }}
          </button>
          <span class="bk-item__id">{{ backup.backupId }}</span>
          <span class="bk-item__time">{{ formatTimestamp(backup.createdAt) }}</span>
          <span class="bk-item__count">{{ backup.files.length }} 个文件</span>
          <el-button
            size="small"
            type="danger"
            plain
            :loading="rollingBack === backup.backupId"
            @click="onRollback(backup)"
          >
            回滚
          </el-button>
        </div>
        <ul
          v-if="expanded(backup.backupId)"
          class="bk-item__files"
        >
          <li
            v-for="file in backup.files"
            :key="`${file.path}-${file.action}`"
            class="bk-item__file"
          >
            <span class="bk-item__path">{{ file.path }}</span>
            <el-tag
              size="small"
              :type="actionTagType(file.action)"
            >
              {{ BACKUP_ACTION_TEXT[file.action] }}
            </el-tag>
          </li>
        </ul>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'BackupsPanel' })

import { onMounted, ref } from 'vue'
import { ElMessageBox } from 'element-plus'

import { useApplyStore } from '@/stores/apply'
import type { BackupFileAction, BackupMeta } from '@/api/admin'
import { formatTimestamp } from '@/utils/format'

const applyStore = useApplyStore()

onMounted(() => {
  // 首次进入该页签时加载（配合 el-tab-pane lazy）
  void applyStore.ensureBackupsLoaded()
})

/** 备份动作 → 中文与三色 tag（覆盖=琥珀 / 删除=红 / 新增=绿）。 */
const BACKUP_ACTION_TEXT: Record<BackupFileAction, string> = {
  overwritten: '覆盖',
  deleted: '删除',
  added: '新增',
}

function actionTagType(action: BackupFileAction): 'success' | 'warning' | 'danger' {
  if (action === 'added') return 'success'
  if (action === 'overwritten') return 'warning'
  return 'danger'
}

// ---------------------------------------------------------------------------
// 展开 / 回滚
// ---------------------------------------------------------------------------

const expandedIds = ref<string[]>([])

function expanded(backupId: string): boolean {
  return expandedIds.value.includes(backupId)
}

function toggleExpand(backupId: string): void {
  const index = expandedIds.value.indexOf(backupId)
  if (index >= 0) expandedIds.value.splice(index, 1)
  else expandedIds.value.push(backupId)
}

const rollingBack = ref<string | null>(null)

async function onRollback(backup: BackupMeta): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `备份 ${backup.backupId} 的内容将写回本体，其后落盘的后续改动需重新执行。`,
      '确认回滚',
      {
        confirmButtonText: '回滚',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
  } catch {
    return
  }
  rollingBack.value = backup.backupId
  try {
    await applyStore.rollback(backup.backupId)
  } finally {
    rollingBack.value = null
  }
}
</script>

<style scoped>
.bk {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-family: var(--el-font-family);
}

.bk-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.bk-head__hint {
  font-size: 12px;
  color: #8a919c;
}

.bk-alert__body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.bk-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bk-item {
  border: 1px solid #e2e5ea;
  border-radius: 6px;
  background: #ffffff;
  overflow: hidden;
}

.bk-item__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
}

.bk-item__toggle {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid #e2e5ea;
  border-radius: 4px;
  background: #f7f8f9;
  color: #6b7280;
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
}

.bk-item__toggle:hover {
  background: #eef1f3;
}

.bk-item__id {
  font-family: var(--admin-font-mono);
  font-size: 12px;
  color: #3a4048;
  word-break: break-all;
}

.bk-item__time {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 12px;
  color: #8a919c;
  font-variant-numeric: tabular-nums;
}

.bk-item__count {
  flex-shrink: 0;
  font-size: 12px;
  color: #6b7280;
  font-variant-numeric: tabular-nums;
}

.bk-item__files {
  list-style: none;
  margin: 0;
  padding: 4px 12px 10px 42px;
  border-top: 1px solid #f2f4f6;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.bk-item__file {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.bk-item__path {
  font-family: var(--admin-font-mono);
  font-size: 12px;
  color: #3a4048;
  word-break: break-all;
  min-width: 0;
}
</style>
