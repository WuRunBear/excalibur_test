<template>
  <div class="gadv">
    <el-form
      label-position="top"
      size="small"
      class="gadv__form"
      @submit.prevent
    >
      <fieldset class="gadv__fieldset">
        <legend>实例启动命令</legend>
        <div class="gadv__grid gadv__grid--start">
          <el-form-item label="command">
            <el-input
              v-model="form.command"
              :disabled="disabled"
              spellcheck="false"
              placeholder="pnpm"
            />
          </el-form-item>
          <el-form-item label="args（以空格分隔）">
            <el-input
              v-model="form.argsText"
              :disabled="disabled"
              spellcheck="false"
              placeholder="dev"
            />
          </el-form-item>
        </div>
      </fieldset>

      <fieldset class="gadv__fieldset">
        <legend>preview 注入的环境变量名（值由服务端 spawn 前解析）</legend>
        <div class="gadv__grid gadv__grid--three">
          <el-form-item label="port">
            <el-input
              v-model="form.injectionPort"
              :disabled="disabled"
              spellcheck="false"
            />
          </el-form-item>
          <el-form-item label="configPath">
            <el-input
              v-model="form.injectionConfigPath"
              :disabled="disabled"
              spellcheck="false"
            />
          </el-form-item>
          <el-form-item label="saveDir">
            <el-input
              v-model="form.injectionSaveDir"
              :disabled="disabled"
              spellcheck="false"
            />
          </el-form-item>
        </div>
      </fieldset>

      <fieldset class="gadv__fieldset">
        <legend>观察频道</legend>
        <el-form-item label="roomName（liveState 房间名）">
          <el-input
            v-model="form.roomName"
            :disabled="disabled"
            spellcheck="false"
          />
        </el-form-item>
      </fieldset>

      <fieldset class="gadv__fieldset">
        <legend>schema 路由表（配置文件 → 校验 schema 的匹配规则）</legend>
        <ul class="gadv__routes">
          <li
            v-for="(route, index) in form.routes"
            :key="index"
            class="gadv__route"
          >
            <el-input
              v-model="route.pattern"
              :disabled="disabled"
              class="gadv__route__pattern"
              spellcheck="false"
              placeholder="正则源串，如 ^game\.json$"
            >
              <template #prepend>pattern</template>
            </el-input>
            <el-input
              v-model="route.kind"
              :disabled="disabled"
              class="gadv__route__kind"
              spellcheck="false"
              placeholder="schema kind（* = 文件名）"
            >
              <template #prepend>kind</template>
            </el-input>
            <el-button
              :disabled="disabled"
              type="danger"
              plain
              size="small"
              :aria-label="`删除路由 ${index + 1}`"
              @click="removeRoute(index)"
            >
              删除
            </el-button>
          </li>
        </ul>
        <div class="gadv__routes__tools">
          <el-button
            size="small"
            :disabled="disabled"
            @click="addRoute"
          >
            添加路由
          </el-button>
          <span
            v-if="routesIncomplete"
            class="gadv__routes__warn"
          >
            存在未填完的行（pattern / kind 必填，pattern 需为可编译正则）
          </span>
        </div>
      </fieldset>

      <fieldset class="gadv__fieldset">
        <legend>依赖安装</legend>
        <el-form-item>
          <el-switch
            v-model="form.trustScripts"
            :disabled="disabled"
            active-text="允许执行安装脚本（trustScripts）"
          />
          <p class="gadv__note">
            默认关闭：pnpm install 以 --ignore-scripts 执行。仅对确信安全的仓库开启。
          </p>
        </el-form-item>
      </fieldset>

      <el-alert
        v-if="saveErrors.length > 0"
        type="error"
        :closable="false"
        show-icon
        title="保存失败：清单校验未通过"
      >
        <ul class="gadv__errors">
          <li
            v-for="issue in saveErrors"
            :key="issue"
          >
            {{ issue }}
          </li>
        </ul>
      </el-alert>

      <div class="gadv__actions">
        <el-button
          size="small"
          :disabled="disabled || !dirty"
          @click="resetFromManifest"
        >
          撤销修改
        </el-button>
        <el-button
          size="small"
          type="primary"
          :disabled="disabled || !dirty || routesIncomplete"
          :loading="saving"
          @click="save"
        >
          保存高级字段
        </el-button>
      </div>
      <p class="gadv__note gadv__note--warn">
        保存后 sidecar 上下文将重建（懒加载），下次领域调用按新清单执行。
      </p>
    </el-form>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'GameAdvancedForm' })

import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

import { AdminApiError } from '@/api/admin'
import type { GameManifest } from '@/api/admin'
import { useGamesStore } from '@/stores/games'

/**
 * manifest 高级字段编辑器（T2.10）：start / envInjection / schemaRoutes /
 * roomName / trustScripts。只提交有变化的键，走 PATCH（整份清单在服务端
 * 重新校验后原子写盘）；保存后 sidecar 上下文重建。
 */
const props = defineProps<{
  manifest: GameManifest
  disabled?: boolean
}>()

const store = useGamesStore()

interface RouteRow {
  pattern: string
  kind: string
}

const form = reactive({
  command: '',
  argsText: '',
  injectionPort: '',
  injectionConfigPath: '',
  injectionSaveDir: '',
  roomName: '',
  trustScripts: false,
  routes: [] as RouteRow[],
})

const saving = ref(false)
const saveErrors = ref<string[]>([])

function parseArgs(text: string): string[] {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/) : []
}

function resetFromManifest(): void {
  const manifest = props.manifest
  form.command = manifest.start.command
  form.argsText = manifest.start.args.join(' ')
  form.injectionPort = manifest.envInjection.port
  form.injectionConfigPath = manifest.envInjection.configPath
  form.injectionSaveDir = manifest.envInjection.saveDir
  form.roomName = manifest.observer.roomName
  form.trustScripts = manifest.trustScripts === true
  form.routes = manifest.schemaRoutes.map((route) => ({ pattern: route.pattern, kind: route.kind }))
  saveErrors.value = []
}

watch(
  () => props.manifest,
  () => resetFromManifest(),
  { immediate: true, deep: true },
)

const dirty = computed(() => {
  const manifest = props.manifest
  if (form.command !== manifest.start.command) return true
  if (JSON.stringify(parseArgs(form.argsText)) !== JSON.stringify(manifest.start.args)) return true
  if (form.injectionPort !== manifest.envInjection.port) return true
  if (form.injectionConfigPath !== manifest.envInjection.configPath) return true
  if (form.injectionSaveDir !== manifest.envInjection.saveDir) return true
  if (form.roomName !== manifest.observer.roomName) return true
  if (form.trustScripts !== (manifest.trustScripts === true)) return true
  const nextRoutes = JSON.stringify(
    form.routes.map((route) => ({ pattern: route.pattern, kind: route.kind })),
  )
  const currentRoutes = JSON.stringify(
    manifest.schemaRoutes.map((route) => ({ pattern: route.pattern, kind: route.kind })),
  )
  return nextRoutes !== currentRoutes
})

const routesIncomplete = computed(() =>
  form.routes.some((route) => route.pattern.trim().length === 0 || route.kind.trim().length === 0),
)

function addRoute(): void {
  form.routes.push({ pattern: '', kind: '' })
}

function removeRoute(index: number): void {
  form.routes.splice(index, 1)
}

async function save(): Promise<void> {
  if (saving.value || !dirty.value || routesIncomplete.value) return
  const manifest = props.manifest
  const body: Record<string, unknown> = {}

  if (
    form.command !== manifest.start.command ||
    parseArgs(form.argsText).join(' ') !== manifest.start.args.join(' ')
  ) {
    body.start = { command: form.command, args: parseArgs(form.argsText) }
  }
  if (
    form.injectionPort !== manifest.envInjection.port ||
    form.injectionConfigPath !== manifest.envInjection.configPath ||
    form.injectionSaveDir !== manifest.envInjection.saveDir
  ) {
    body.envInjection = {
      port: form.injectionPort,
      configPath: form.injectionConfigPath,
      saveDir: form.injectionSaveDir,
    }
  }
  if (form.roomName !== manifest.observer.roomName) body.roomName = form.roomName
  if (form.trustScripts !== (manifest.trustScripts === true)) body.trustScripts = form.trustScripts
  const nextRoutes = form.routes.map((route) => ({ pattern: route.pattern, kind: route.kind }))
  if (JSON.stringify(nextRoutes) !== JSON.stringify(manifest.schemaRoutes)) {
    body.schemaRoutes = nextRoutes
  }
  if (Object.keys(body).length === 0) return

  saving.value = true
  saveErrors.value = []
  try {
    await store.savePatch(manifest.id, body)
    // savePatch 已把响应详情写入 store；manifest 变化会触发 watch 重新初始化表单
    ElMessage.success('高级字段已保存，sidecar 上下文将重建')
  } catch (err) {
    const issues = extractManifestIssues(err)
    if (issues.length > 0) {
      saveErrors.value = issues
    } else {
      ElMessage.error(err instanceof AdminApiError ? err.message : '保存失败，请稍后重试')
    }
  } finally {
    saving.value = false
  }
}

/** PATCH 422 时 detail.errors 为 {path,message}[]；拼成「路径: 文案」行。 */
function extractManifestIssues(err: unknown): string[] {
  if (!(err instanceof AdminApiError)) return []
  if (!Array.isArray(err.detail)) return []
  return err.detail
    .filter(
      (item): item is { path?: unknown; message?: unknown } =>
        typeof item === 'object' && item !== null,
    )
    .map((item) => {
      const path = Array.isArray(item.path) ? item.path.join('.') : ''
      const message = typeof item.message === 'string' ? item.message : ''
      return path ? `${path}: ${message}` : message
    })
    .filter((line) => line.length > 0)
}
</script>

<style scoped>
.gadv__form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.gadv__fieldset {
  margin: 0;
  padding: 10px 12px 2px;
  border: 1px solid #e2e5ea;
  border-radius: 6px;
}

.gadv__fieldset legend {
  padding: 0 6px;
  font-size: 12px;
  color: #5f6670;
}

.gadv__grid {
  display: grid;
  gap: 0 12px;
}

.gadv__grid--start {
  grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
}

.gadv__grid--three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.gadv__routes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.gadv__route {
  display: flex;
  align-items: center;
  gap: 8px;
}

.gadv__route__pattern {
  flex: 3;
}

.gadv__route__kind {
  flex: 2;
}

.gadv__routes__tools {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0 10px;
}

.gadv__routes__warn {
  font-size: 11px;
  color: var(--el-color-warning-dark-2);
}

.gadv__note {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: #8a919c;
}

.gadv__note--warn {
  color: #9a6a08;
}

.gadv__errors {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  font-family: var(--admin-font-mono);
  font-size: 11px;
  line-height: 1.7;
}

.gadv__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
