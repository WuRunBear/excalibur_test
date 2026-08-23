import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'

import '@pixelium/web-vue/dist/font.css'
import '@pixelium/web-vue/dist/normalize.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)

app.mount('#app')
