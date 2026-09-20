import { createRouter, createWebHistory } from 'vue-router'

import { IconDashboard, IconGamepad } from '@pixelium/web-vue/icon-pa/es'

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
      ],
    },
  ],
})

export default router
