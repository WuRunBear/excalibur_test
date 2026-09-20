<template>
  <div class="sv">
    <header class="sv-header">
      <div>
        <h1 class="sv-title">存档管理</h1>
        <p class="sv-sub">
          {{
            saveStore.dir
              ? `存档目录：${saveStore.dir}`
              : '浏览 / 恢复 / 下载实例的存档文件（存档在实例启动时加载）'
          }}
        </p>
      </div>
      <div class="sv-tools">
        <el-button
          size="small"
          :loading="saveStore.loading"
          @click="saveStore.load()"
        >
          刷新
        </el-button>
      </div>
    </header>

    <el-tabs
      v-model="activeScope"
      class="sv-tabs"
    >
      <el-tab-pane
        label="正式实例"
        name="official"
      />
      <el-tab-pane
        label="预览实例"
        name="preview"
      />
    </el-tabs>

    <!-- 预览 scope 需要活动工作区 -->
    <el-empty
      v-if="activeScope === 'preview' && workspaceStore.activeId === null"
      description="预览实例存档跟随活动工作区，当前未设置活动工作区"
    >
      <RouterLink to="/workspace">
        <el-button type="primary">去工作区新建或切换</el-button>
      </RouterLink>
    </el-empty>

    <template v-else>
      <el-alert
        v-if="saveStore.lastError"
        type="error"
        :closable="false"
      >
        <div class="sv-alert__body">
          <span>{{ saveStore.lastError }}</span>
          <el-button
            size="small"
            @click="saveStore.load()"
          >
            重试
          </el-button>
        </div>
      </el-alert>

      <el-skeleton
        v-else-if="saveStore.loading && saveStore.saves.length === 0"
        :rows="5"
        animated
      />

      <el-empty
        v-else-if="saveStore.saves.length === 0"
        description="该实例暂无存档"
        :image-size="80"
      />

      <template v-else>
        <div class="sv-head">
          <span>共 {{ saveStore.saves.length }} 个存档（可解析 {{ saveStore.parsedCount }}）</span>
        </div>
        <div class="sv-list">
          <div class="sv-row sv-row--head">
            <span class="sv-col sv-col--file">文件</span>
            <span class="sv-col sv-col--tick">tick</span>
            <span class="sv-col sv-col--time">保存时间</span>
            <span class="sv-col sv-col--num">地图</span>
            <span class="sv-col sv-col--num">实体</span>
            <span class="sv-col sv-col--num">大小</span>
            <span class="sv-col sv-col--ops">操作</span>
          </div>
          <div
            v-for="save in saveStore.saves"
            :key="save.file"
            class="sv-row"
          >
            <span class="sv-col sv-col--file">
              <span class="sv-file">
                <span class="sv-file__name">{{ save.file }}</span>
                <el-tag
                  v-if="save.summary === null"
                  size="small"
                  type="info"
                >
                  无法解析
                </el-tag>
              </span>
              <span class="sv-file__id">{{ save.saveId }}</span>
            </span>
            <span class="sv-col sv-col--tick">
              {{ save.summary ? save.summary.tick.toLocaleString() : '—' }}
            </span>
            <span class="sv-col sv-col--time">
              {{ save.summary ? formatTimestamp(save.summary.savedAt) : '—' }}
            </span>
            <span class="sv-col sv-col--num">
              {{ save.summary ? save.summary.mapCount : '—' }}
            </span>
            <span class="sv-col sv-col--num">
              {{ save.summary ? save.summary.entityCount : '—' }}
            </span>
            <span class="sv-col sv-col--num">{{ formatBytes(save.sizeBytes) }}</span>
            <span class="sv-col sv-col--ops">
              <el-button
                size="small"
                text
                type="primary"
                @click="saveStore.openDetail(save.file)"
              >
                详情
              </el-button>
              <el-button
                size="small"
                text
                @click="onDownload(save)"
              >
                下载
              </el-button>
              <el-button
                size="small"
                text
                type="warning"
                @click="onRestore(save)"
              >
                恢复
              </el-button>
              <el-button
                size="small"
                text
                type="danger"
                @click="onDelete(save)"
              >
                删除
              </el-button>
            </span>
          </div>
        </div>
      </template>
    </template>

    <!-- 详情抽屉 -->
    <el-drawer
      v-model="saveStore.detailVisible"
      :title="saveStore.detail?.file ?? '存档详情'"
      size="440px"
      @closed="saveStore.closeDetail()"
    >
      <div
        v-loading="saveStore.detailLoading"
        class="sv-drawer"
      >
        <template v-if="saveStore.detail">
          <el-alert
            v-if="saveStore.detail.summary === null"
            type="info"
            :closable="false"
            title="该存档无法解析为 WorldRecord，仅可下载或删除"
          />
          <template v-else>
            <div class="sv-detail-grid">
              <div class="sv-detail-cell">
                <span class="sv-detail-label">tick</span>
                <span class="sv-detail-value">{{
                  saveStore.detail.summary.tick.toLocaleString()
                }}</span>
              </div>
              <div class="sv-detail-cell">
                <span class="sv-detail-label">保存时间</span>
                <span class="sv-detail-value">{{
                  formatTimestamp(saveStore.detail.summary.savedAt)
                }}</span>
              </div>
              <div class="sv-detail-cell">
                <span class="sv-detail-label">地图数</span>
                <span class="sv-detail-value">{{ saveStore.detail.summary.mapCount }}</span>
              </div>
              <div class="sv-detail-cell">
                <span class="sv-detail-label">实体数</span>
                <span class="sv-detail-value">{{ saveStore.detail.summary.entityCount }}</span>
              </div>
              <div
                v-if="saveStore.detail.summary.timeOfDay"
                class="sv-detail-cell"
              >
                <span class="sv-detail-label">时段</span>
                <span class="sv-detail-value">
                  hour {{ saveStore.detail.summary.timeOfDay.hour }} · phase
                  {{ saveStore.detail.summary.timeOfDay.phase }}
                </span>
              </div>
            </div>

            <h3 class="sv-section">实体类型 Top</h3>
            <div
              v-if="saveStore.detail.topKinds.length === 0"
              class="sv-empty-hint"
            >
              无实体数据
            </div>
            <ul
              v-else
              class="sv-kinds"
            >
              <li
                v-for="kind in topKindsBars"
                :key="kind.kind"
                class="sv-kind"
              >
                <span class="sv-kind__name">{{ kind.kind }}</span>
                <span class="sv-kind__bar-wrap">
                  <span
                    class="sv-kind__bar"
                    :style="{ width: `${kind.percent}%` }"
                  ></span>
                </span>
                <span class="sv-kind__count">{{ kind.count }}</span>
              </li>
            </ul>

            <h3 class="sv-section">地图（{{ saveStore.detail.maps.length }}）</h3>
            <div
              v-if="saveStore.detail.maps.length === 0"
              class="sv-empty-hint"
            >
              无地图数据
            </div>
            <div class="sv-maps">
              <span
                v-for="map in saveStore.detail.maps"
                :key="map.mapKey"
                class="sv-map-chip"
              >
                {{ map.mapKey }}
              </span>
            </div>
          </template>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'SaveView' })

import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ElMessageBox } from 'element-plus'

import { saveDownloadUrl } from '@/api/admin'
import type { SaveEntry } from '@/api/admin'
import { useSaveStore } from '@/stores/save'
import { useWorkspaceStore } from '@/stores/workspace'
import { formatBytes, formatTimestamp } from '@/utils/format'

const saveStore = useSaveStore()
const workspaceStore = useWorkspaceStore()

const activeScope = ref<'official' | 'preview'>(saveStore.scope)

onMounted(() => {
  void saveStore.load()
})

// scope 页签切换 → 重新加载对应清单
watch(activeScope, (scope) => {
  if (scope !== saveStore.scope || saveStore.loadedFor !== scope) {
    void saveStore.load(scope)
  }
})

function onDownload(save: SaveEntry): void {
  window.open(saveDownloadUrl(save.file, saveStore.scope), '_blank')
}

async function onDelete(save: SaveEntry): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除存档文件 ${save.file}？该操作不可撤销。`, '删除存档', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      type: 'warning',
    })
  } catch {
    return
  }
  await saveStore.remove(save.file)
}

async function onRestore(save: SaveEntry): Promise<void> {
  const restartHint = saveStore.scope === 'official' ? '（正式实例需重启生效）' : ''
  try {
    await ElMessageBox.confirm(`将把 ${save.file} 替换为活跃存档${restartHint}。`, '恢复存档', {
      confirmButtonText: '恢复',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      type: 'warning',
    })
  } catch {
    return
  }
  await saveStore.restore(save.file)
}

// topKinds 条形：以最大计数为基准的相对宽度
const topKindsBars = computed(() => {
  const kinds = saveStore.detail?.topKinds ?? []
  const max = Math.max(1, ...kinds.map((kind) => kind.count))
  return kinds.map((kind) => ({ ...kind, percent: Math.round((kind.count / max) * 100) }))
})
</script>

<style scoped>
.sv {
  max-width: 1440px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-family: var(--el-font-family);
}

.sv-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.sv-title {
  font-family: var(--font-pixel);
  font-size: 22px;
  letter-spacing: 2px;
  color: #26292e;
}

.sv-sub {
  margin-top: 2px;
  font-size: 12px;
  color: #8a919c;
  word-break: break-all;
}

.sv-tools {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sv-tabs :deep(.el-tabs__header) {
  margin-bottom: 0;
}

.sv-alert__body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.sv-head {
  font-size: 12px;
  color: #8a919c;
  font-variant-numeric: tabular-nums;
}

/* 列表：行栅格 */
.sv-list {
  display: flex;
  flex-direction: column;
  border: 1px solid #e2e5ea;
  border-radius: 6px;
  background: #ffffff;
  overflow: hidden;
}

.sv-row {
  display: grid;
  grid-template-columns:
    minmax(200px, 1.4fr) minmax(80px, 0.7fr) minmax(140px, 0.9fr)
    64px 64px minmax(80px, 0.6fr) minmax(220px, 1fr);
  gap: 8px;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid #f2f4f6;
}

.sv-row:last-child {
  border-bottom: none;
}

.sv-row--head {
  background: #f7f8f9;
  font-size: 12px;
  color: #8a919c;
  border-bottom: 1px solid #eef0f2;
}

.sv-col {
  min-width: 0;
  font-size: 13px;
  color: #3a4048;
  font-variant-numeric: tabular-nums;
}

.sv-col--file {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sv-file {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.sv-file__name {
  font-family: var(--admin-font-mono);
  font-size: 12px;
  color: #26292e;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sv-file__id {
  font-family: var(--admin-font-mono);
  font-size: 11px;
  color: #9aa3ad;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sv-col--ops {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 0;
}

@media (max-width: 900px) {
  .sv-row {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }

  .sv-row--head {
    display: none;
  }

  .sv-col--ops {
    justify-content: flex-start;
  }
}

/* 详情抽屉 */
.sv-drawer {
  min-height: 200px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sv-detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.sv-detail-cell {
  padding: 8px 10px;
  background: #f7f8f9;
  border: 1px solid #eef0f2;
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sv-detail-label {
  font-size: 11px;
  color: #8a919c;
}

.sv-detail-value {
  font-family: var(--admin-font-mono);
  font-size: 12px;
  color: #26292e;
  font-variant-numeric: tabular-nums;
}

.sv-section {
  font-size: 13px;
  color: #26292e;
}

.sv-empty-hint {
  font-size: 12px;
  color: #9aa3ad;
}

/* topKinds 条形 */
.sv-kinds {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sv-kind {
  display: grid;
  grid-template-columns: minmax(80px, 110px) minmax(0, 1fr) 40px;
  align-items: center;
  gap: 8px;
}

.sv-kind__name {
  font-family: var(--admin-font-mono);
  font-size: 11px;
  color: #3a4048;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sv-kind__bar-wrap {
  height: 10px;
  background: #f2f4f6;
  border-radius: 999px;
  overflow: hidden;
}

.sv-kind__bar {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--el-color-primary);
}

.sv-kind__count {
  text-align: right;
  font-size: 11px;
  color: #6b7280;
  font-variant-numeric: tabular-nums;
}

.sv-maps {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.sv-map-chip {
  font-family: var(--admin-font-mono);
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid #e2e5ea;
  background: #f7f8f9;
  color: #3a4048;
}
</style>
