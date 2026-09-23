import './assets/main.css'
import 'element-plus/dist/index.css'
import './styles/element-theme.scss'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'

import App from './App.vue'
import router from './router'
import { setAdminGameIdReader } from './api/admin'
import { useGamesStore } from './stores/games'

import '@pixelium/web-vue/dist/font.css'
import '@pixelium/web-vue/dist/normalize.css'

// 环境兼容垫片：详见 utils/envCompat.ts 头注释（decode() 挂起 / rAF 停发两处兜底）
import { installHybridRaf, installImageDecodeShim } from './utils/envCompat'
installImageDecodeShim()
installHybridRaf()

const app = createApp(App)

const pinia = createPinia()
app.use(pinia)
// T2.10：REST/WS 寻址的 gameId 由游戏切换器 store 提供（初始 = 默认游戏）。
// 读取器惰性取 store——首次调用时才实例化，store 装配过程不反向依赖 api 层。
setAdminGameIdReader(() => useGamesStore().currentGameId)
app.use(router)
// Element Plus 全量引入（管理平台 UI）；中文 locale + 墨青主题覆盖见 styles/element-theme.scss
app.use(ElementPlus, { locale: zhCn })

app.mount('#app')
