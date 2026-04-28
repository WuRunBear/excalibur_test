<template>
  <Container
    direction="vertical"
    class="min-h-screen bg-neutral-50 text-neutral-900"
  >
    <Header
      bordered
      :min-height="56"
      class="fixed inset-x-0 top-0 z-50 h-14 bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/70"
    >
      <div class="mx-auto flex h-full w-full max-w-screen-2xl items-center gap-3 px-3 sm:px-4">
        <RouterLink
          to="/"
          aria-label="返回首页"
          class="flex items-center gap-2 rounded px-2 py-1 text-sm font-semibold tracking-wide hover:bg-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-300"
        >
          <span
            class="inline-flex h-8 w-8 items-center justify-center rounded bg-neutral-900 text-white"
          >
            {{ appInfo.shortName }}
          </span>
          <span class="hidden sm:inline">{{ appInfo.BName }} V{{ appInfo.version }}</span>
        </RouterLink>

        <div class="flex-1"></div>

        <DropDown
          :options="userMenuOptions"
          trigger="click"
          placement="bottom-end"
          aria-label="用户下拉菜单"
          @select="onUserMenuSelect"
        >
          <Button
            variant="text"
            size="small"
            aria-label="打开用户菜单"
            class="inline-flex items-center gap-2"
          >
            <Avatar
              bordered
              :size="28"
              aria-label="用户头像"
            >
              <span class="text-xs font-semibold">U</span>
            </Avatar>
            <span class="hidden sm:inline text-sm text-neutral-700">用户</span>
            <span class="text-xs text-neutral-500">▾</span>
          </Button>
        </DropDown>
      </div>
    </Header>

    <Container
      direction="horizontal"
      class="flex-1 pt-14"
    >
      <Aside
        bordered
        side="left"
        :width="sidebarWidth"
        class="sticky top-14 z-10 h-[calc(100vh-3.5rem)] bg-white transition-[width] duration-200"
      >
        <div class="flex h-full flex-col overflow-hidden">
          <div class="flex items-center justify-between gap-2 px-3 py-3">
            <div class="min-w-0">
              <div
                class="truncate text-xs font-semibold text-neutral-600"
                :aria-label="isSidebarCollapsed ? '菜单' : '主菜单'"
              >
                {{ isSidebarCollapsed ? '菜单' : '主菜单' }}
              </div>
            </div>
            <Button
              variant="text"
              size="small"
              aria-label="切换侧边栏展开状态"
              class="hidden md:inline-flex"
              @click="toggleSidebarCollapsed"
            >
              <span class="text-sm leading-none">{{ isSidebarCollapsed ? '⇥' : '⇤' }}</span>
            </Button>
          </div>

          <div
            class="flex-1 overflow-auto px-2 pb-3 outline-none focus-visible:ring-2 focus-visible:ring-neutral-300"
            tabindex="0"
            aria-label="侧边栏菜单"
            @keydown="onMenuKeydown"
          >
            <Menu
              v-memo="[menuOptions, activeIndex, expandedIndices, isSidebarCollapsed]"
              direction="vertical"
              :collapsed="isSidebarCollapsed"
              :submenuMode="isSidebarCollapsed ? 'popover' : 'inline'"
              submenuTrigger="click"
              :options="menuOptions"
              :active="activeIndex"
              :expanded="expandedIndices"
              @select="onMenuSelect"
              @update:active="onMenuActiveUpdate"
              @update:expend="onMenuExpandedUpdate"
            />
          </div>
        </div>
      </Aside>

      <Container
        direction="vertical"
        class="min-w-0 flex-1"
      >
        <Main class="h-[calc(100vh-3.5rem)] overflow-hidden bg-neutral-50">
          <div class="flex h-full flex-col">
            <div
              class="flex-1 overflow-auto px-4 py-4"
              aria-label="主内容区"
            >
              <RouterView />
            </div>

            <Footer
              v-if="showFooter"
              bordered
              class="bg-white px-4 py-3 text-xs text-neutral-500"
            >
              <div class="mx-auto w-full max-w-screen-2xl">
                © {{ new Date().getFullYear() }} {{ appInfo.BName }} All rights reserved.
              </div>
            </Footer>
          </div>
        </Main>
      </Container>
    </Container>
  </Container>
</template>

<script setup lang="ts">
defineOptions({ name: 'MainLayout' })

import { appInfo } from '@/config/app'

import type { MenuGroupOption, MenuOption, SubmenuOption } from '@pixelium/web-vue/es'
import type { RouteRecordRaw } from 'vue-router'
import type { Component } from 'vue'
import { computed, h, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter, RouterLink, RouterView } from 'vue-router'
import {
  Aside,
  Avatar,
  Button,
  Container,
  DropDown,
  Footer,
  Header,
  Main,
  Menu,
} from '@pixelium/web-vue/es'

/**
 * 业务路由 meta 的约定字段集合
 * 用于在不污染 vue-router 原始类型的前提下，集中管理本项目会用到的 meta 字段
 */
type AppRouteMeta = {
  title?: string
  label?: string
  hidden?: boolean
  hideInMenu?: boolean
  icon?: Component
  activeMenu?: string
  showFooter?: boolean
}

/**
 * 菜单节点类型集合
 * 兼容菜单项、子菜单、分组菜单（具体由组件库决定）
 */
type MenuNode = MenuOption | SubmenuOption | MenuGroupOption

/**
 * 菜单 children 可能混入字符串（例如分隔符/标题），需要在遍历时做兼容
 */
type MenuChild = string | MenuNode

/**
 * 菜单组件事件中 index 的类型
 */
type MenuIndex = string | number | symbol

const router = useRouter()
const route = useRoute()

const SIDEBAR_COLLAPSED_KEY = 'sidebar_collapsed'

const isSidebarCollapsed = ref(false)

/**
 * 安全读取路由 meta，并在当前文件内统一收口类型转换
 * @param meta vue-router 提供的原始 meta
 * @returns 业务侧约定的 meta 字段对象
 */
function getRouteMeta(meta: RouteRecordRaw['meta'] | undefined): AppRouteMeta {
  return (meta ?? {}) as AppRouteMeta
}

const showFooter = computed(() => getRouteMeta(route.meta).showFooter === true)

const sidebarWidth = computed(() => (isSidebarCollapsed.value ? '64px' : '256px'))

const userMenuOptions = shallowRef<{ index: string; label: string }[]>([
  { index: 'profile', label: '个人中心' },
  { index: 'logout', label: '退出登录' },
])

function readSidebarCollapsedFromStorage() {
  const raw = localStorage.getItem(SIDEBAR_COLLAPSED_KEY)
  if (raw === null) return false
  if (raw === '1') return true
  if (raw === '0') return false
  return raw === 'true'
}

isSidebarCollapsed.value = readSidebarCollapsedFromStorage()

watch(
  isSidebarCollapsed,
  (value) => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, value ? 'true' : 'false')
  },
  { flush: 'sync' },
)

function toggleSidebarCollapsed() {
  isSidebarCollapsed.value = !isSidebarCollapsed.value
}

/**
 * 将子路由 path 规范化为可用于 router.push 的绝对路径
 * @param basePath 父级路径（通常为布局路由路径）
 * @param path 子路由的 path（可能为空/相对/绝对）
 * @returns 规范化后的绝对路径
 */
function normalizePath(basePath: string, path: string) {
  const cleanBase = basePath.replace(/\/+$/, '')
  if (path === '') return cleanBase || '/'
  if (path.startsWith('/')) return path
  if (cleanBase === '' || cleanBase === '/') return `/${path}`.replace(/\/+/g, '/')
  return `${cleanBase}/${path}`.replace(/\/+/g, '/')
}

/**
 * 从路由记录中提取用于菜单显示的名称
 * 优先级：meta.title/meta.label -> record.name -> record.path
 * @param record 路由记录
 * @returns 可展示的文本
 */
function getRouteLabel(record: RouteRecordRaw) {
  const meta = getRouteMeta(record.meta)
  const fromMeta = meta.title ?? meta.label
  if (fromMeta && fromMeta.trim()) return fromMeta
  if (typeof record.name === 'string' && record.name.trim()) return record.name
  return record.path || '未命名'
}

/**
 * 判断路由记录是否需要展示在侧边栏菜单中
 * @param record 路由记录
 * @returns 是否展示
 */
function shouldShowInMenu(record: RouteRecordRaw) {
  const meta = getRouteMeta(record.meta)
  if (meta.hidden === true) return false
  if (meta.hideInMenu === true) return false
  return true
}

/**
 * 从路由 meta 中构造菜单图标渲染函数
 * @param record 路由记录
 * @returns 菜单组件可识别的 icon 渲染函数
 */
function getRouteIcon(record: RouteRecordRaw): MenuOption['icon'] | undefined {
  const meta = getRouteMeta(record.meta)
  const icon = meta.icon
  if (!icon) return undefined
  return (() => h(icon, { size: 16 })) as unknown as MenuOption['icon']
}

/**
 * 根据路由树递归构建菜单 options
 * @param records 路由记录列表
 * @param basePath 当前层级的基准路径
 * @returns 菜单 options
 */
function buildMenuOptions(records: RouteRecordRaw[], basePath: string): MenuNode[] {
  const result: MenuNode[] = []

  for (const record of records) {
    if (!shouldShowInMenu(record)) continue

    const fullPath = normalizePath(basePath, record.path)
    const children = Array.isArray(record.children) ? record.children : []
    const label = getRouteLabel(record)
    const icon = getRouteIcon(record)

    if (children.length > 0) {
      const option: SubmenuOption = {
        type: 'submenu',
        index: fullPath,
        label,
        children: buildMenuOptions(children, fullPath),
      }
      if (icon) option.icon = icon
      result.push(option)
      continue
    }

    const option: MenuOption = { index: fullPath, label }
    if (icon) option.icon = icon
    result.push(option)
  }

  return result
}

/**
 * 从 router 配置中定位布局路由（/index）并取其 children 作为菜单根节点
 * @returns 菜单基准路径与菜单根路由列表
 */
function findLayoutMenuRootRoutes() {
  const routerWithOptions = router as unknown as { options?: { routes?: RouteRecordRaw[] } }
  const rootRoutes = routerWithOptions.options?.routes ?? []
  const layout = rootRoutes.find((r) => r.path === '/index')
  const children = layout?.children ?? []
  return { basePath: layout?.path ?? '/', routes: children }
}

const { basePath: menuBasePath, routes: menuRootRoutes } = findLayoutMenuRootRoutes()
const menuOptions = shallowRef<MenuNode[]>(buildMenuOptions(menuRootRoutes, menuBasePath))

/**
 * 判断当前节点是否为子菜单（submenu）
 * @param option 菜单节点
 * @returns 是否为 SubmenuOption
 */
function isSubmenuOption(option: MenuNode): option is SubmenuOption {
  return 'type' in option && option.type === 'submenu'
}

/**
 * 判断当前节点是否为分组菜单（group）
 * @param option 菜单节点
 * @returns 是否为 MenuGroupOption
 */
function isGroupOption(option: MenuNode): option is MenuGroupOption {
  return 'type' in option && option.type === 'group'
}

/**
 * 收集菜单中的叶子节点与子菜单节点索引
 * 用于：判断菜单选中项、展开项、键盘上下移动的可选列表
 * @param options 菜单 options（可能包含 string 子项）
 * @returns 叶子节点索引集合与子菜单索引集合
 */
function collectMenuIndices(options: MenuChild[]) {
  const leaf = new Set<string>()
  const submenu = new Set<string>()

  const walk = (items: MenuChild[]) => {
    for (const item of items) {
      if (typeof item === 'string') continue
      if (isGroupOption(item)) {
        walk(item.children)
        continue
      }
      const idx = String(item.index)
      if (isSubmenuOption(item)) {
        submenu.add(idx)
        walk(item.children)
        continue
      }
      leaf.add(idx)
    }
  }

  walk(options)
  return { leaf, submenu }
}

const menuIndexSets = computed(() => collectMenuIndices(menuOptions.value))
const leafIndices = computed(() => Array.from(menuIndexSets.value.leaf))

const activeIndex = ref<string>(route.path)
const expandedIndices = ref<string[]>([])

/**
 * 将路由状态同步到菜单：选中项与展开项
 * 支持通过 meta.activeMenu 强制指定选中菜单（用于详情页高亮父级菜单等场景）
 */
function syncActiveAndExpanded() {
  const meta = getRouteMeta(route.meta)
  const forcedActive = meta.activeMenu
  const candidate = forcedActive || route.path

  if (menuIndexSets.value.leaf.has(candidate)) {
    activeIndex.value = candidate
  } else {
    const matchedLeaf = [...route.matched]
      .map((r) => router.resolve(r.path).path)
      .reverse()
      .find((p) => menuIndexSets.value.leaf.has(p))
    activeIndex.value = matchedLeaf ?? candidate
  }

  const matchedExpanded = [...route.matched]
    .map((r) => router.resolve(r.path).path)
    .filter((p) => menuIndexSets.value.submenu.has(p))

  expandedIndices.value = Array.from(new Set(matchedExpanded))
}

watch(
  () => route.fullPath,
  () => syncActiveAndExpanded(),
  { immediate: true },
)

/**
 * 点击菜单叶子节点时导航
 * @param index 菜单索引
 */
function onMenuSelect(index: MenuIndex) {
  const target = String(index)
  if (menuIndexSets.value.leaf.has(target)) {
    router.push(target)
  }
}

/**
 * 菜单组件更新 active 时同步到本地状态
 * @param value 菜单索引
 */
function onMenuActiveUpdate(value: MenuIndex) {
  activeIndex.value = String(value)
}

/**
 * 菜单组件更新 expanded 时同步到本地状态
 * @param value 展开的菜单索引列表
 */
function onMenuExpandedUpdate(value: MenuIndex[]) {
  expandedIndices.value = value.map(String)
}

/**
 * 侧边栏键盘导航：上下箭头切换选中项，回车触发导航
 * @param e 键盘事件
 */
function onMenuKeydown(e: KeyboardEvent) {
  const keys = leafIndices.value
  if (keys.length === 0) return
  const first = keys[0]
  if (!first) return

  const current = activeIndex.value
  const currentIndex = keys.indexOf(current)
  const safeIndex = currentIndex >= 0 ? currentIndex : 0

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    const next = keys[(safeIndex + 1) % keys.length] ?? first
    activeIndex.value = next
    return
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault()
    const next = keys[(safeIndex - 1 + keys.length) % keys.length] ?? first
    activeIndex.value = next
    return
  }

  if (e.key === 'Enter') {
    e.preventDefault()
    if (menuIndexSets.value.leaf.has(activeIndex.value)) router.push(activeIndex.value)
  }
}

/**
 * 清理本地保存的 token
 */
function clearToken() {
  localStorage.removeItem('token')
  localStorage.removeItem('access_token')
  localStorage.removeItem('refresh_token')
  sessionStorage.removeItem('token')
  sessionStorage.removeItem('access_token')
  sessionStorage.removeItem('refresh_token')
}

/**
 * 用户菜单点击处理
 * @param index 菜单索引
 */
function onUserMenuSelect(index: string | number | symbol) {
  const key = String(index)
  if (key === 'profile') {
    router.push('/profile')
    return
  }
  if (key === 'logout') {
    clearToken()
    router.push('/login')
  }
}
</script>
