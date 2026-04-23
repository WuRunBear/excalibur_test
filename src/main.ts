import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'

// Import the font at the project entry [optional]
import '@pixelium/web-vue/dist/font.css'
// Import the normalize at the project entry [optional]
import '@pixelium/web-vue/dist/normalize.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)

app.mount('#app')
