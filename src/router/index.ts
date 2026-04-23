import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      redirect: '/game',
    },
    {
      path: '/game',
      component: () => import('views/GameView.vue'),
    },
    {
      path: '/index',
      component: () => import('layouts/MainLayout.vue'),
      children: [{ path: '', component: () => import('views/IndexView.vue') }],
    },
  ],
})

export default router
