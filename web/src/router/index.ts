import { createRouter, createWebHistory } from 'vue-router'

import {
  IconCode,
  IconDashboard,
  IconFolder,
  IconGamepad,
  IconListBox,
  IconMap,
  IconSave,
  IconSwitch,
} from '@pixelium/web-vue/icon-pa/es'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      name: 'Root',
      path: '/',
      // 管理平台主界面为仪表盘（S1-D2）
      redirect: '/dashboard',
      meta: { hidden: true },
    },
    {
      name: 'Play',
      path: '/play',
      component: () => import('views/PlayView.vue'),
      meta: { title: '游戏观察', icon: IconGamepad },
    },
    {
      name: 'AdminLayout',
      // MainLayout 的菜单按 path === '/index' 定位布局路由，保持不变
      path: '/index',
      component: () => import('layouts/MainLayout.vue'),
      meta: { title: '后台', hideInMenu: true },
      children: [
        {
          // 兜底：访问 /index 时归位到仪表盘
          path: '',
          redirect: '/dashboard',
          meta: { hidden: true },
        },
        {
          name: 'Dashboard',
          // 绝对路径子路由：URL 为 /dashboard，同时被 MainLayout 菜单收录
          path: '/dashboard',
          component: () => import('views/DashboardView.vue'),
          meta: { title: '仪表盘', icon: IconDashboard },
        },
        {
          name: 'Games',
          // T2.10：游戏管理（注册 / 切换 / 导入 / 移除）
          path: '/games',
          component: () => import('views/GamesView.vue'),
          meta: { title: '游戏管理', icon: IconSwitch },
        },
        {
          name: 'Workspace',
          path: '/workspace',
          component: () => import('views/WorkspaceView.vue'),
          meta: { title: '工作区', icon: IconFolder },
        },
        {
          name: 'Config',
          path: '/config',
          component: () => import('views/ConfigView.vue'),
          meta: { title: '配置编辑', icon: IconCode },
        },
        {
          name: 'Maps',
          path: '/maps',
          component: () => import('views/MapView.vue'),
          meta: { title: '地图工具', icon: IconMap },
        },
        {
          name: 'Saves',
          path: '/saves',
          component: () => import('views/SaveView.vue'),
          meta: { title: '存档管理', icon: IconSave },
        },
        {
          name: 'Registries',
          path: '/registries',
          component: () => import('views/RegistryView.vue'),
          meta: { title: '注册表', icon: IconListBox },
        },
      ],
    },
  ],
})

export default router
