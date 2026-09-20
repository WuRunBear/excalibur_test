<template>
  <div class="rg">
    <header class="rg-header">
      <div>
        <h1 class="rg-title">注册表</h1>
        <p class="rg-sub">本体框架当前注册的系统 / 原型 / 行为 / 组件 / 地图生成器（只读）</p>
      </div>
      <div class="rg-tools">
        <el-input
          v-model="query"
          class="rg-search"
          size="small"
          clearable
          placeholder="搜索 id / 名称 / 描述"
        />
        <el-button
          size="small"
          :loading="registryStore.loading"
          @click="registryStore.load()"
        >
          刷新
        </el-button>
      </div>
    </header>

    <el-alert
      v-if="registryStore.lastError"
      type="error"
      :closable="false"
    >
      <div class="rg-alert__body">
        <span>{{ registryStore.lastError }}</span>
        <el-button
          size="small"
          @click="registryStore.load()"
        >
          重试
        </el-button>
      </div>
    </el-alert>

    <el-skeleton
      v-else-if="registryStore.loading && registryStore.data === null"
      :rows="6"
      animated
    />

    <el-empty
      v-else-if="!registryStore.data"
      description="暂无注册表数据"
      :image-size="80"
    />

    <template v-else>
      <div class="rg-summary">命中 {{ filteredTotal }} / {{ totalEntries }} 条</div>

      <section
        v-for="group in groups"
        :key="group.key"
        class="rg-group"
      >
        <template v-if="group.entries.length > 0">
          <div class="rg-group__head">
            <h2 class="rg-group__title">
              {{ group.title }}
              <span class="rg-group__en">{{ group.key }}</span>
            </h2>
            <span class="rg-group__count">{{ group.entries.length }}</span>
          </div>
          <ul class="rg-items">
            <li
              v-for="entry in group.entries"
              :key="`${group.key}-${entry.id}`"
              class="rg-item"
            >
              <span class="rg-item__id">{{ entry.id }}</span>
              <span
                v-if="entry.name"
                class="rg-item__name"
              >
                {{ entry.name }}
              </span>
              <span
                v-if="entry.description"
                class="rg-item__desc"
              >
                {{ entry.description }}
              </span>
            </li>
          </ul>
        </template>
      </section>

      <el-empty
        v-if="filteredTotal === 0"
        description="没有匹配的注册表条目"
        :image-size="70"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'RegistryView' })

import { computed, onMounted, ref } from 'vue'

import { useRegistryStore } from '@/stores/registry'
import { entryMatches, normalizeRegistryEntries, type RegistryEntry } from '@/utils/registry'

const registryStore = useRegistryStore()
const query = ref('')

onMounted(() => {
  void registryStore.ensureLoaded()
})

interface GroupDef {
  key: string
  title: string
  raw: unknown
}

const groups = computed<Array<{ key: string; title: string; entries: RegistryEntry[] }>>(() => {
  const data = registryStore.data
  if (!data) return []
  const defs: GroupDef[] = [
    { key: 'systems', title: '系统', raw: data.systems },
    { key: 'archetypes', title: '原型', raw: data.archetypes },
    { key: 'actions', title: '行为', raw: data.actions },
    { key: 'components', title: '组件', raw: data.components },
    { key: 'mapGenerators', title: '地图生成器', raw: data.mapGenerators },
  ]
  return defs.map((group) => ({
    key: group.key,
    title: group.title,
    entries: normalizeRegistryEntries(group.raw).filter((entry) =>
      entryMatches(entry, query.value),
    ),
  }))
})

const filteredTotal = computed(() =>
  groups.value.reduce((sum, group) => sum + group.entries.length, 0),
)

const totalEntries = computed(() => {
  const data = registryStore.data
  if (!data) return 0
  const defs: GroupDef[] = [
    { key: 'systems', title: '系统', raw: data.systems },
    { key: 'archetypes', title: '原型', raw: data.archetypes },
    { key: 'actions', title: '行为', raw: data.actions },
    { key: 'components', title: '组件', raw: data.components },
    { key: 'mapGenerators', title: '地图生成器', raw: data.mapGenerators },
  ]
  return defs.reduce((sum, group) => sum + normalizeRegistryEntries(group.raw).length, 0)
})
</script>

<style scoped>
.rg {
  max-width: 960px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  font-family: var(--el-font-family);
}

.rg-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.rg-title {
  font-family: var(--font-pixel);
  font-size: 22px;
  letter-spacing: 2px;
  color: #26292e;
}

.rg-sub {
  margin-top: 2px;
  font-size: 12px;
  color: #8a919c;
}

.rg-tools {
  display: flex;
  align-items: center;
  gap: 10px;
}

.rg-search {
  width: 240px;
}

.rg-alert__body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.rg-summary {
  font-size: 12px;
  color: #8a919c;
  font-variant-numeric: tabular-nums;
}

.rg-group {
  border: 1px solid #e2e5ea;
  border-radius: 6px;
  background: #ffffff;
  overflow: hidden;
}

.rg-group__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid #eef0f2;
  background: #f7f8f9;
}

.rg-group__title {
  font-size: 14px;
  color: #26292e;
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
}

.rg-group__en {
  font-family: var(--admin-font-mono);
  font-size: 11px;
  color: #9aa3ad;
}

.rg-group__count {
  font-size: 12px;
  color: var(--el-color-primary);
  font-variant-numeric: tabular-nums;
}

.rg-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
}

.rg-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 14px;
  border-bottom: 1px solid #f2f4f6;
}

.rg-item:nth-child(odd) {
  border-right: 1px solid #f2f4f6;
}

.rg-item__id {
  font-family: var(--admin-font-mono);
  font-size: 12px;
  color: #26292e;
  word-break: break-all;
}

.rg-item__name {
  font-size: 12px;
  color: #3a4048;
}

.rg-item__desc {
  font-size: 11px;
  color: #8a919c;
  line-height: 1.6;
}
</style>
