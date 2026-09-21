import './assets/main.css'
import 'element-plus/dist/index.css'
import './styles/element-theme.scss'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'

import App from './App.vue'
import router from './router'

import '@pixelium/web-vue/dist/font.css'
import '@pixelium/web-vue/dist/normalize.css'

// 环境兼容垫片：详见 utils/envCompat.ts 头注释（decode() 挂起 / rAF 停发两处兜底）
import { installHybridRaf, installImageDecodeShim } from './utils/envCompat'
installImageDecodeShim()
installHybridRaf()

const app = createApp(App)

app.use(createPinia())
app.use(router)
// Element Plus 全量引入（管理平台 UI）；中文 locale + 墨青主题覆盖见 styles/element-theme.scss
app.use(ElementPlus, { locale: zhCn })

app.mount('#app')
