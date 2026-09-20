<template>
  <el-card
    class="ctx-card"
    shadow="never"
  >
    <template #header>
      <div class="ctx-card__head">
        <div class="ctx-card__naming">
          <span class="ctx-card__kicker">config-context</span>
          <h2 class="ctx-card__name">配置上下文</h2>
        </div>
        <el-button
          size="small"
          :loading="contextStore.loading"
          @click="contextStore.load()"
        >
          刷新
        </el-button>
      </div>
    </template>

    <el-alert
      v-if="contextStore.lastError"
      class="ctx-alert"
      type="error"
      :closable="false"
    >
      <div class="ctx-alert__body">
        <span>{{ contextStore.lastError }}</span>
        <el-button
          size="small"
          @click="contextStore.load()"
        >
          重试
        </el-button>
      </div>
    </el-alert>

    <el-skeleton
      v-else-if="contextStore.loading && contextStore.context === null"
      :rows="3"
      animated
    />

    <!-- 无活动工作区：中性空态 -->
    <div
      v-else-if="contextStore.context && !contextStore.context.workspace"
      class="ctx-empty"
    >
      <span class="ctx-empty__text">未设置活动工作区，预览实例将回退使用本体配置。</span>
      <RouterLink to="/workspace">
        <el-button size="small">去工作区页</el-button>
      </RouterLink>
    </div>

    <template v-else-if="contextStore.context">
      <!-- 一致 / 不一致状态条 -->
      <div
        class="ctx-strip"
        :class="contextStore.context.inSync ? 'ctx-strip--ok' : 'ctx-strip--warn'"
      >
        <i class="ctx-strip__dot"></i>
        <span class="ctx-strip__text">
          {{
            contextStore.context.inSync
              ? '配置一致'
              : `工作区有未落盘改动（${contextStore.context.changes.length} 个文件）`
          }}
        </span>
        <RouterLink
          v-if="!contextStore.context.inSync"
          to="/config"
        >
          <el-button
            size="small"
            text
            type="primary"
          >
            去查看
          </el-button>
        </RouterLink>
      </div>

      <!-- 双侧指纹摘要 -->
      <div class="ctx-sides">
        <div class="ctx-side">
          <span class="ctx-side__label">本体 game/</span>
          <span class="ctx-side__value">
            <span class="ctx-side__fp">{{
              fingerprintSummary(contextStore.context.official.fingerprint)
            }}</span>
            <span class="ctx-side__count"
              >{{ contextStore.context.official.fileCount }} 个文件</span
            >
          </span>
        </div>
        <div
          v-if="contextStore.context.workspace"
          class="ctx-side"
        >
          <span class="ctx-side__label">工作区 · {{ contextStore.context.workspace.name }}</span>
          <span class="ctx-side__value">
            <span class="ctx-side__fp">{{
              fingerprintSummary(contextStore.context.workspace.fingerprint)
            }}</span>
            <span class="ctx-side__count"
              >{{ contextStore.context.workspace.fileCount }} 个文件</span
            >
          </span>
        </div>
      </div>

      <!-- 改动摘要：默认前 5 条，可展开完整列表 -->
      <template v-if="!contextStore.context.inSync && contextStore.context.changes.length > 0">
        <ul class="ctx-changes">
          <li
            v-for="change in visibleChanges"
            :key="change.path"
            class="ctx-change"
          >
            <span class="ctx-change__path">{{ change.path }}</span>
            <el-tag
              size="small"
              :type="workspaceChangeTagType(change.status)"
            >
              {{ WORKSPACE_CHANGE_TEXT[change.status] }}
            </el-tag>
          </li>
        </ul>
        <button
          v-if="contextStore.context.changes.length > SUMMARY_LIMIT"
          class="ctx-expand"
          type="button"
          @click="expanded = !expanded"
        >
          {{
            expanded
              ? '收起完整列表'
              : `展开完整列表（共 ${contextStore.context.changes.length} 条）`
          }}
        </button>
      </template>
    </template>
  </el-card>
</template>

<script setup lang="ts">
defineOptions({ name: 'ConfigContextCard' })

import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import { useConfigContextStore } from '@/stores/configContext'
import type { ConfigContextChange } from '@/api/admin'
import { WORKSPACE_CHANGE_TEXT, workspaceChangeTagType } from '@/utils/workspace'

/** 改动摘要默认展示条数，超出提供展开开关。 */
const SUMMARY_LIMIT = 5

const contextStore = useConfigContextStore()

const expanded = ref(false)

onMounted(() => {
  void contextStore.ensureLoaded()
})

const visibleChanges = computed<ConfigContextChange[]>(() => {
  const changes = contextStore.context?.changes ?? []
  return expanded.value ? changes : changes.slice(0, SUMMARY_LIMIT)
})

/** 指纹只取前 8 位做摘要，空值给占位符。 */
function fingerprintSummary(fingerprint: string): string {
  const trimmed = fingerprint.trim()
  return trimmed ? trimmed.slice(0, 8) : '—'
}
</script>

<style scoped>
.ctx-card :deep(.el-card__header) {
  padding: 12px 16px;
}

.ctx-card :deep(.el-card__body) {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ctx-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.ctx-card__kicker {
  font-family: var(--admin-font-mono);
  font-size: 10px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: #9aa3ad;
}

.ctx-card__name {
  margin-top: 2px;
  font-size: 16px;
  color: #26292e;
}

.ctx-alert__body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

/* 无工作区：中性空态 */
.ctx-empty {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  padding: 14px 16px;
  border: 1px dashed #d3d8de;
  border-radius: 6px;
  background: #fafbfc;
}

.ctx-empty__text {
  font-size: 13px;
  color: #6b7280;
}

/* 状态条：一致=绿 / 不一致=琥珀（与工作区改动 tag 同源语义） */
.ctx-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid;
  font-size: 13px;
}

.ctx-strip--ok {
  color: var(--admin-status-running);
  background: var(--admin-status-running-bg);
  border-color: var(--admin-status-running-border);
}

.ctx-strip--ok .ctx-strip__dot {
  background: var(--admin-dot-running);
}

.ctx-strip--warn {
  color: #9a6a08;
  background: #fdf5e7;
  border-color: #efdcb3;
}

.ctx-strip--warn .ctx-strip__dot {
  background: #d9860c;
}

.ctx-strip__dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  flex-shrink: 0;
}

.ctx-strip__text {
  flex: 1;
  min-width: 0;
}

/* 双侧指纹摘要 */
.ctx-sides {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 10px;
}

.ctx-side {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 12px;
  padding: 8px 12px;
  background: #f7f8f9;
  border: 1px solid #eef0f2;
  border-radius: 4px;
}

.ctx-side__label {
  font-size: 12px;
  color: #8a919c;
}

.ctx-side__value {
  display: inline-flex;
  align-items: baseline;
  gap: 10px;
}

.ctx-side__fp {
  font-family: var(--admin-font-mono);
  font-size: 12px;
  color: #3a4048;
}

.ctx-side__count {
  font-size: 12px;
  color: #6b7280;
  font-variant-numeric: tabular-nums;
}

/* 改动摘要 */
.ctx-changes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ctx-change {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 10px;
  border: 1px solid #eef0f2;
  border-radius: 4px;
  background: #fafbfc;
}

.ctx-change__path {
  font-family: var(--admin-font-mono);
  font-size: 12px;
  color: #3a4048;
  word-break: break-all;
  min-width: 0;
}

/* 展开 / 收起 */
.ctx-expand {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  font-size: 12px;
  color: var(--el-color-primary);
  cursor: pointer;
}

.ctx-expand:hover {
  text-decoration: underline;
}
</style>
