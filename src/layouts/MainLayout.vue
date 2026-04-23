<template>
  <Container direction="vertical" class="min-h-screen bg-neutral-50 text-neutral-900">
    <Header bordered :min-height="56"
      class="fixed inset-x-0 top-0 z-50 h-14 bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/70">
      <div class="mx-auto flex h-full w-full max-w-screen-2xl items-center gap-3 px-3 sm:px-4">
        <Button variant="text" size="small" class="md:hidden" aria-label="打开侧边栏" @click="isMobileSidebarOpen = true">
          <span class="text-lg leading-none">☰</span>
        </Button>

        <Button variant="text" size="small" class="hidden md:inline-flex" aria-label="切换侧边栏展开状态"
          @click="toggleSidebarCollapsed">
          <span class="text-lg leading-none">{{ isSidebarCollapsed ? '☰' : '⇤' }}</span>
        </Button>

        <RouterLink to="/" aria-label="返回首页"
          class="flex items-center gap-2 rounded px-2 py-1 text-sm font-semibold tracking-wide hover:bg-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-300">
          <span class="inline-flex h-8 w-8 items-center justify-center rounded bg-neutral-900 text-white">P</span>
          <span class="hidden sm:inline">Pixelium App</span>
        </RouterLink>

        <div class="flex-1"></div>

        <DropDown :options="userMenuOptions" trigger="click" placement="bottom-end" aria-label="用户下拉菜单"
          @select="onUserMenuSelect">
          <Button variant="text" size="small" aria-label="打开用户菜单" class="inline-flex items-center gap-2">
            <Avatar bordered :size="28" aria-label="用户头像">
              <span class="text-xs font-semibold">U</span>
            </Avatar>
            <span class="hidden sm:inline text-sm text-neutral-700">用户</span>
            <span class="text-xs text-neutral-500">▾</span>
          </Button>
        </DropDown>
      </div>
    </Header>

    <Container direction="horizontal" class="flex-1 pt-14">
      <div v-if="isMobileSidebarOpen" class="fixed inset-0 z-40 bg-black/40 md:hidden" aria-label="关闭侧边栏遮罩"
        @click="isMobileSidebarOpen = false"></div>

      <Aside bordered side="left" :width="sidebarWidth"
        class="z-50 h-[calc(100vh-3.5rem)] bg-white transition-[width] duration-200 md:static md:z-auto" :class="[
          isMobileSidebarOpen ? 'fixed left-0 top-14 md:top-0' : 'hidden md:block',
        ]">
        <div class="flex h-full flex-col overflow-hidden">
          <div class="flex items-center justify-between gap-2 px-3 py-3">
            <div class="min-w-0">
              <div class="truncate text-xs font-semibold text-neutral-600"
                :aria-label="isSidebarCollapsed ? '菜单' : '主菜单'">
                {{ isSidebarCollapsed ? '菜单' : '主菜单' }}
              </div>
            </div>
            <Button variant="text" size="small" aria-label="切换侧边栏展开状态" class="hidden md:inline-flex"
              @click="toggleSidebarCollapsed">
              <span class="text-sm leading-none">{{ isSidebarCollapsed ? '⇥' : '⇤' }}</span>
            </Button>
            <Button variant="text" size="small" aria-label="关闭侧边栏" class="md:hidden"
              @click="isMobileSidebarOpen = false">
              <span class="text-sm leading-none">✕</span>
            </Button>
          </div>

          <div class="flex-1 overflow-auto px-2 pb-3 outline-none focus-visible:ring-2 focus-visible:ring-neutral-300"
            tabindex="0" aria-label="侧边栏菜单" @keydown="onMenuKeydown">
            <Menu v-memo="[menuOptions, activeIndex, expandedIndices, isSidebarCollapsed]" direction="vertical"
              :collapsed="isSidebarCollapsed" :submenuMode="isSidebarCollapsed ? 'popover' : 'inline'"
              submenuTrigger="click" :options="menuOptions" :active="activeIndex" :expanded="expandedIndices"
              @select="onMenuSelect" @update:active="onMenuActiveUpdate" @update:expend="onMenuExpandedUpdate" />
          </div>
        </div>
      </Aside>

      <Container direction="vertical" class="min-w-0 flex-1">
        <Main class="h-[calc(100vh-3.5rem)] overflow-hidden bg-neutral-50">
          <div class="flex h-full flex-col">
            <div class="border-b border-neutral-200 bg-white px-4 py-3">
              <Breadcrumb :options="breadcrumbOptions" aria-label="面包屑导航" @select="onBreadcrumbSelect" />
            </div>

            <div class="flex-1 overflow-auto px-4 py-4" aria-label="主内容区">
              <RouterView />
            </div>

            <Footer bordered class="bg-white px-4 py-3 text-xs text-neutral-500">
              <div class="mx-auto w-full max-w-screen-2xl">
                © {{ new Date().getFullYear() }} Pixelium App. All rights reserved.
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

import type { MenuOption, SubmenuOption } from '@pixelium/web-vue/es'
import type { RouteRecordRaw } from 'vue-router'
import { computed, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter, RouterLink, RouterView } from 'vue-router'
import { Aside, Avatar, Breadcrumb, Button, Container, DropDown, Footer, Header, Main, Menu } from '@pixelium/web-vue/es'

const router = useRouter()
const route = useRoute()

const SIDEBAR_COLLAPSED_KEY = 'sidebar_collapsed'

const isSidebarCollapsed = ref(false)
const isMobileSidebarOpen = ref(false)

const sidebarWidth = computed(() => (isSidebarCollapsed.value ? '64px' : '256px'))

const userMenuOptions = shallowRef([
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

function normalizePath(basePath: string, path: string) {
  const cleanBase = basePath.replace(/\/+$/, '')
  if (path === '') return cleanBase || '/'
  if (path.startsWith('/')) return path
  if (cleanBase === '' || cleanBase === '/') return `/${path}`.replace(/\/+/g, '/')
  return `${cleanBase}/${path}`.replace(/\/+/g, '/')
}

function getRouteLabel(record: RouteRecordRaw) {
  const meta = (record.meta ?? {}) as Record<string, unknown>
  const fromMeta = (meta.title ?? meta.label) as string | undefined
  if (fromMeta && fromMeta.trim()) return fromMeta
  if (typeof record.name === 'string' && record.name.trim()) return record.name
  return record.path || '未命名'
}

function shouldShowInMenu(record: RouteRecordRaw) {
  const meta = (record.meta ?? {}) as Record<string, unknown>
  if (meta.hidden === true) return false
  if (meta.hideInMenu === true) return false
  return true
}

function buildMenuOptions(records: RouteRecordRaw[], basePath: string): (MenuOption | SubmenuOption)[] {
  const result: (MenuOption | SubmenuOption)[] = []

  for (const record of records) {
    if (!shouldShowInMenu(record)) continue

    const fullPath = normalizePath(basePath, record.path)
    const children = Array.isArray(record.children) ? record.children : []
    const label = getRouteLabel(record)

    if (children.length > 0) {
      result.push({
        type: 'submenu',
        index: fullPath,
        label,
        children: buildMenuOptions(children, fullPath),
      })
      continue
    }

    result.push({ index: fullPath, label })
  }

  return result
}

function findLayoutMenuRootRoutes() {
  const rootRoutes = ((router as unknown as { options?: { routes?: RouteRecordRaw[] } }).options?.routes ?? []) as RouteRecordRaw[]
  const layout = rootRoutes.find((r) => r.path === '/index')
  const children = layout?.children ?? []
  return { basePath: layout?.path ?? '/', routes: children }
}

const { basePath: menuBasePath, routes: menuRootRoutes } = findLayoutMenuRootRoutes()
const menuOptions = shallowRef<(MenuOption | SubmenuOption)[]>(buildMenuOptions(menuRootRoutes, menuBasePath))

function collectMenuIndices(options: (MenuOption | SubmenuOption)[]) {
  const leaf = new Set<string>()
  const submenu = new Set<string>()

  const walk = (items: (MenuOption | SubmenuOption)[]) => {
    for (const item of items) {
      const idx = String(item.index)
      if ('children' in item) {
        submenu.add(idx)
        walk(item.children as (MenuOption | SubmenuOption)[])
      } else {
        leaf.add(idx)
      }
    }
  }

  walk(options)
  return { leaf, submenu }
}

const menuIndexSets = computed(() => collectMenuIndices(menuOptions.value))
const leafIndices = computed(() => Array.from(menuIndexSets.value.leaf))

const activeIndex = ref<string>(route.path)
const expandedIndices = ref<(string | number | symbol)[]>([])

function syncActiveAndExpanded() {
  const meta = (route.meta ?? {}) as Record<string, unknown>
  const forcedActive = meta.activeMenu as string | undefined
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

function onMenuSelect(index: string | number | symbol) {
  const target = String(index)
  if (menuIndexSets.value.leaf.has(target)) {
    router.push(target)
    isMobileSidebarOpen.value = false
  }
}

function onMenuActiveUpdate(value: string | number | symbol) {
  activeIndex.value = String(value)
}

function onMenuExpandedUpdate(value: (string | number | symbol)[]) {
  expandedIndices.value = value
}

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

const breadcrumbOptions = computed(() => {
  const options = route.matched
    .map((record) => {
      const label = getRouteLabel(record)
      const path = router.resolve(record.path).path
      return { index: path, label, clickable: true }
    })
    .filter((item) => item.label && item.index)

  if (options.length === 0) return [{ index: '/', label: '首页', clickable: true }]
  return options
})

function onBreadcrumbSelect(index: string | number | symbol) {
  router.push(String(index))
}

function clearToken() {
  localStorage.removeItem('token')
  localStorage.removeItem('access_token')
  localStorage.removeItem('refresh_token')
  sessionStorage.removeItem('token')
  sessionStorage.removeItem('access_token')
  sessionStorage.removeItem('refresh_token')
}

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
