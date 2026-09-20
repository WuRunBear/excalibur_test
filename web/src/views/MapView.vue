<template>
  <div class="mp">
    <header class="mp-header">
      <div>
        <h1 class="mp-title">地图工具</h1>
        <p class="mp-sub">registry 地图清单、几何预览与导出（生成结果不落盘，仅供预览对比）</p>
      </div>
      <div class="mp-tools">
        <el-tooltip
          content="工作区未激活，先去工作区页新建或切换"
          :disabled="workspaceStore.activeId !== null"
          placement="top"
        >
          <el-radio-group
            size="small"
            :model-value="mapStore.source"
            @update:model-value="onSourceChange"
          >
            <el-radio-button
              value="workspace"
              :disabled="workspaceStore.activeId === null"
            >
              工作区
            </el-radio-button>
            <el-radio-button value="official">本体</el-radio-button>
          </el-radio-group>
        </el-tooltip>
        <span class="mp-compare">
          <el-switch
            v-model="compare"
            size="small"
          />
          对比模式
        </span>
        <el-button
          size="small"
          :disabled="!mapStore.selectedKey"
          @click="loadViews"
        >
          重新生成
        </el-button>
        <el-button
          size="small"
          :disabled="!mapStore.selectedKey"
          @click="onExport('png')"
        >
          导出 PNG
        </el-button>
        <el-button
          size="small"
          :disabled="!mapStore.selectedKey"
          @click="onExport('json')"
        >
          导出 JSON
        </el-button>
      </div>
    </header>

    <el-alert
      v-if="workspaceStore.activeId === null"
      class="mp-alert"
      type="info"
      :closable="false"
    >
      <div class="mp-alert__body">
        <span>未设置活动工作区，「工作区」数据源不可用，已切换为本体预览。</span>
        <RouterLink to="/workspace">
          <el-button
            size="small"
            text
            type="primary"
          >
            去工作区页
          </el-button>
        </RouterLink>
      </div>
    </el-alert>

    <div class="mp-body">
      <!-- 左：地图清单 -->
      <aside class="mp-list">
        <div class="mp-list__head">
          <span>地图清单</span>
          <span class="mp-list__count">{{ mapStore.maps.length }}</span>
        </div>
        <div
          v-if="mapStore.mapsLoading"
          class="mp-list__body"
        >
          <el-skeleton
            :rows="4"
            animated
          />
        </div>
        <el-alert
          v-else-if="mapStore.mapsError"
          type="error"
          :closable="false"
        >
          <div class="mp-alert__body">
            <span>{{ mapStore.mapsError }}</span>
            <el-button
              size="small"
              @click="mapStore.loadMaps()"
            >
              重试
            </el-button>
          </div>
        </el-alert>
        <el-empty
          v-else-if="mapStore.maps.length === 0"
          description="该来源暂无地图"
          :image-size="70"
        />
        <ul
          v-else
          class="mp-list__body mp-list__items"
        >
          <li
            v-for="map in mapStore.maps"
            :key="map.key"
            class="mp-map"
            :class="{ 'is-current': map.key === mapStore.selectedKey }"
            @click="mapStore.select(map.key)"
          >
            <div class="mp-map__row">
              <span class="mp-map__key">{{ map.key }}</span>
              <el-tag
                size="small"
                :type="map.kind === 'pipeline' ? 'success' : 'info'"
              >
                {{ map.kind === 'pipeline' ? 'pipeline' : 'tiled' }}
              </el-tag>
            </div>
            <p
              v-if="map.kind === 'pipeline' && map.pipeline && map.pipeline.length > 0"
              class="mp-map__pipeline"
              :title="map.pipeline.map((step) => step.generator).join(' → ')"
            >
              {{ map.pipeline.map((step) => step.generator).join(' → ') }}
            </p>
            <p
              v-else
              class="mp-map__pipeline"
            >
              由 Tiled 地图文件驱动
            </p>
            <p
              v-if="map.seed !== undefined"
              class="mp-map__seed"
            >
              seed {{ map.seed }}
            </p>
          </li>
        </ul>
      </aside>

      <!-- 右：预览渲染（对比模式双卡） -->
      <section class="mp-stage">
        <div :class="compare ? 'mp-stage__grid' : 'mp-stage__single'">
          <MapCanvasCard
            v-for="view in views"
            :key="view.source"
            :source="view.source"
            :view="slots[view.source].view"
            :loading="slots[view.source].loading"
            :error="slots[view.source].error"
            :pins="pinsFor(view.source)"
            :version-highlight="versionDiff"
          />
        </div>
        <p
          v-if="compare && versionDiff"
          class="mp-version-diff"
        >
          两侧 version 不同：工作区改动尚未落到本体（以颜色高亮标记）。
        </p>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'MapView' })

import { computed, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import { fetchMapGeometry, mapExportUrl } from '@/api/admin'
import type { MapGeometryPayload, MapSource } from '@/api/admin'
import MapCanvasCard from 'components/admin/MapCanvasCard.vue'
import { useMapStore } from '@/stores/map'
import { useWorkspaceStore } from '@/stores/workspace'
import {
  extractEntityRulePins,
  normalizeGeometry,
  regionCentroid,
  type DrawPin,
  type GeometryView,
} from '@/utils/mapCanvas'

const mapStore = useMapStore()
const workspaceStore = useWorkspaceStore()

// ---------------------------------------------------------------------------
// 数据源 / 对比模式 / 几何装载
// ---------------------------------------------------------------------------

const compare = ref(false)

const views = computed<Array<{ source: MapSource }>>(() =>
  compare.value ? [{ source: 'workspace' }, { source: 'official' }] : [{ source: mapStore.source }],
)

interface ViewSlot {
  view: GeometryView | null
  loading: boolean
  error: string | null
}

const slots = reactive<Record<MapSource, ViewSlot>>({
  workspace: { view: null, loading: false, error: null },
  official: { view: null, loading: false, error: null },
})

onMounted(() => {
  void mapStore.ensureMapsLoaded()
})

// selectedKey / source / compare 变化 → 重新拉取几何（保持“最新生成结果”语义）
watch(
  () => [mapStore.selectedKey, mapStore.source, compare.value] as const,
  () => {
    void loadViews()
  },
)

// 工作区被停用时避免停留在不可用数据源
watch(
  () => workspaceStore.activeId,
  (id) => {
    if (id === null && mapStore.source === 'workspace') mapStore.setSource('official')
  },
)

function onSourceChange(value: string | number | boolean | object | undefined): void {
  if (typeof value === 'string' && (value === 'workspace' || value === 'official')) {
    mapStore.setSource(value)
  }
}

async function loadViews(): Promise<void> {
  const key = mapStore.selectedKey
  if (!key) return
  const targets = views.value.map((view) => view.source)
  for (const source of targets) void mapStore.loadRules(source)

  await Promise.all(
    targets.map(async (source) => {
      slots[source] = { ...slots[source], loading: true, error: null }
      try {
        const payload: MapGeometryPayload = await fetchMapGeometry(key, source)
        slots[source] = { view: normalizeGeometry(payload), loading: false, error: null }
      } catch (err) {
        slots[source] = {
          view: null,
          loading: false,
          error: err instanceof Error ? err.message : '生成预览失败',
        }
      }
    }),
  )
}

// ---------------------------------------------------------------------------
// 导出（当前数据源的选中图；直接打开下载 URL）
// ---------------------------------------------------------------------------

function onExport(format: 'png' | 'json'): void {
  const key = mapStore.selectedKey
  if (!key) return
  window.open(mapExportUrl(key, mapStore.source, format), '_blank')
}

// ---------------------------------------------------------------------------
// 规则点位：entity-rules 中引用当前图的条目 → 区域质心
// ---------------------------------------------------------------------------

function pinsFor(source: MapSource): DrawPin[] {
  const view = slots[source].view
  const rules = mapStore.rules[source]
  const key = mapStore.selectedKey
  if (!view || rules === undefined || rules === null || !key) return []

  const result: DrawPin[] = []
  for (const pin of extractEntityRulePins(rules)) {
    if (pin.map !== key || pin.region === null) continue
    let index: number | null = null
    if (typeof pin.region === 'number') {
      index = pin.region
    } else {
      const found = view.regions.find((region) => region.name === pin.region)
      index = found ? found.index : null
    }
    if (index === null) continue
    const centroid = regionCentroid(view, index)
    if (!centroid) continue
    result.push({ cx: centroid.cx, cy: centroid.cy, label: pin.summary })
  }
  return result
}

const versionDiff = computed(
  () =>
    compare.value &&
    slots.workspace.view !== null &&
    slots.official.view !== null &&
    slots.workspace.view.version !== slots.official.view.version,
)
</script>

<style scoped>
.mp {
  max-width: 1440px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  font-family: var(--el-font-family);
}

.mp-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.mp-title {
  font-family: var(--font-pixel);
  font-size: 22px;
  letter-spacing: 2px;
  color: #26292e;
}

.mp-sub {
  margin-top: 2px;
  font-size: 12px;
  color: #8a919c;
}

.mp-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.mp-compare {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #6b7280;
}

.mp-alert__body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.mp-body {
  display: grid;
  grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
  gap: 16px;
}

@media (max-width: 900px) {
  .mp-body {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* 左：清单 */
.mp-list {
  display: flex;
  flex-direction: column;
  border: 1px solid #e2e5ea;
  border-radius: 6px;
  background: #ffffff;
  overflow: hidden;
  align-self: start;
}

.mp-list__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid #eef0f2;
  background: #f7f8f9;
  font-size: 13px;
  font-weight: 600;
  color: #2b2f36;
}

.mp-list__count {
  font-size: 11px;
  font-weight: normal;
  color: #9aa3ad;
  font-variant-numeric: tabular-nums;
}

.mp-list__body {
  padding: 8px;
  max-height: 560px;
  overflow-y: auto;
}

.mp-list__items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mp-map {
  padding: 8px 10px;
  border: 1px solid #eef0f2;
  border-radius: 4px;
  cursor: pointer;
}

.mp-map:hover {
  background: #f7faf9;
}

.mp-map.is-current {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}

.mp-map__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mp-map__key {
  font-family: var(--admin-font-mono);
  font-size: 13px;
  color: #26292e;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mp-map__pipeline {
  margin-top: 4px;
  font-family: var(--admin-font-mono);
  font-size: 11px;
  color: #8a919c;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mp-map__seed {
  margin-top: 2px;
  font-size: 11px;
  color: #9aa3ad;
  font-variant-numeric: tabular-nums;
}

/* 右：预览 */
.mp-stage {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mp-stage__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

@media (max-width: 1100px) {
  .mp-stage__grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.mp-stage__single {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
}

.mp-version-diff {
  font-size: 12px;
  color: #9a6a08;
}
</style>
