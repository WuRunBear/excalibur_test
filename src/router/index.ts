import { createRouter, createWebHistory } from 'vue-router'

import { IconGamepad, IconHome } from '@pixelium/web-vue/icon-pa/es'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      name: 'Root',
      path: '/',
      redirect: '/game',
      meta: { hidden: true },
    },
    {
      name: 'Game',
      path: '/game',
      component: () => import('views/GameView.vue'),
      meta: { title: '游戏', icon: IconGamepad },
    },
    {
      name: 'IndexLayout',
      path: '/index',
      component: () => import('layouts/MainLayout.vue'),
      meta: { title: '后台', hideInMenu: true },
      children: [
        {
          name: 'IndexHome',
          path: '',
          component: () => import('views/IndexView.vue'),
          meta: { title: '首页', icon: IconHome },
        },
      ],
    },
  ],
})

export default router
