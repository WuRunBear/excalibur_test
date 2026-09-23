/**
 * 管理后端入口（S1-C；T2.7 路由寻址游戏化）。
 *
 * 组装：express（JSON body + 手写 CORS 白名单中间件）→ REST 路由 →
 * node:http server → 'upgrade' 交给 wsHub（/ws?channel=<白名单>）→ listen ADMIN_PORT。
 *
 * 路由挂载（T2.7，scoped 先、legacy 后——express 5 参数路由冲突规避）：
 * - /api/games                     → gamesRouter（列表 / 导入）
 * - /api/games/:gameId             → gameResolver + gameScopedRouter
 *   （详情/sync/PATCH/DELETE + 全部领域子路由；:gameId 未注册 → 404）
 * - 旧挂载点 /api/instances 等     → legacyGameScope（req.gameId = isDefault
 *   游戏）后走同一批 Router 实例——内部 forward，不做 307（Q3；别名删除
 *   时点 = P3，Q4）
 *
 * 事件接线（compat gst 单例集合；非 gst 容器由 routes/helpers.ts 首次使用时接线）：
 * - instanceManager 状态变更 → wsHub.broadcast(`instance:state:{gameId}`, snapshot)
 * - instanceManager 子进程行 → logStream.ingestProcessLine（环形缓冲 + 广播）
 * - logStream 新日志（文件/进程）→ wsHub.broadcast(`instance:log:{gameId}:{role}`, msg)
 *
 * 注意：管理后端退出时不会连带杀掉已拉起的游戏实例（实例生命周期独立，
 * 由 REST /api/instances/:role/stop 管理）；sidecar driver 为计算附属物，
 * 退出时由 SidecarClient 的 process 'exit' 钩子统一 SIGTERM。
 */
import http from 'node:http'

import express from 'express'
import type { NextFunction, Request, Response } from 'express'

import { ADMIN_PORT, GAME_ROOT, corsOrigins } from './config.js'
import { defaultGameContext } from './gameContext.js'
import { ensureSeeded } from './games/registry.js'
import { applyRouter, backupsRouter } from './routes/apply.js'
import { configContextRouter } from './routes/configContext.js'
import { configsRouter } from './routes/configs.js'
import { gameResolver, gameScopedRouter, gamesRouter, legacyGameScope } from './routes/games.js'
import { liveRouter } from './routes/live.js'
import { mapsRouter } from './routes/maps.js'
import { processRouter } from './routes/process.js'
import { registriesRouter } from './routes/registries.js'
import { savesRouter } from './routes/saves.js'
import { workspaceRouter } from './routes/workspace.js'
import { instanceManagers } from './services/instanceManager.js'
import { liveState } from './services/liveState.js'
import { logStream } from './services/logStream.js'
import { wsHub } from './ws/hub.js'

const app = express()
app.disable('x-powered-by')

// JSON body 解析
app.use(express.json({ limit: '1mb' }))

// 手写 CORS 白名单中间件（不引入 cors 包）：仅白名单 origin 回显授权头；
// 无 Origin 的同源/curl 请求直接放行。
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Max-Age', '600')
    res.status(204).end()
    return
  }
  next()
})

// REST 路由（T2.7：scoped 先挂，legacy 后挂）
app.use('/api/games', gamesRouter)
app.use('/api/games/:gameId', gameResolver, gameScopedRouter)

app.use('/api/instances', legacyGameScope, processRouter)
app.use('/api/workspaces', legacyGameScope, workspaceRouter)
app.use('/api/configs', legacyGameScope, configsRouter)
app.use('/api/config-context', legacyGameScope, configContextRouter)
app.use('/api/apply', legacyGameScope, applyRouter)
app.use('/api/backups', legacyGameScope, backupsRouter)
app.use('/api/maps', legacyGameScope, mapsRouter)
app.use('/api/saves', legacyGameScope, savesRouter)
app.use('/api/registries', legacyGameScope, registriesRouter)
app.use('/api/live', legacyGameScope, liveRouter)

// API 404（统一响应结构）
app.use((req, res) => {
  res.status(404).json({ code: 1, message: `not found: ${req.method} ${req.originalUrl}` })
})

// 错误兜底（含 body 解析错误等；express 5 会把异步异常转发到这里）
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status =
    typeof err === 'object' && err !== null && 'status' in err && typeof (err as { status: unknown }).status === 'number'
      ? (err as { status: number }).status
      : 500
  const message = err instanceof Error ? err.message : String(err)
  if (status >= 500) console.error('[admin] unhandled error:', err)
  res.status(status).json({ code: 1, message })
})

// T2.1：games registry 首建播种（registry.json 已存在时为幂等 no-op）。
// 播种失败不阻断管理后端启动——registry 的消费方在 Phase 2 后续任务才接线。
try {
  ensureSeeded()
} catch (err) {
  console.error('[admin] games registry 播种失败:', err)
}

// ---------------------------------------------------------------------------
// 事件接线（进程管理 ↔ 日志流 ↔ WS 广播 ↔ liveState 观察）
// （compat gst 单例集合；非 gst 容器由 routes/helpers.ts 首次使用时接线）
// ---------------------------------------------------------------------------
for (const manager of Object.values(instanceManagers)) {
  manager.onStateChange((snapshot) => {
    // T2.7 频道公式：instance:state:{gameId}
    wsHub.broadcast(`instance:state:${snapshot.gameId || defaultGameContext.gameId}`, snapshot)
    // S7-A：liveState 旁路观察者——running 建观察会话，其余状态拆除
    liveState.handleInstanceStatus(snapshot.role, snapshot)
  })
  manager.onLine((role, source, line) => {
    logStream.ingestProcessLine(role, source, line)
  })
}
logStream.onLog((msg) => {
  // T2.7 频道公式：instance:log:{gameId}:{role}（本接线为 compat gst 单例）
  wsHub.broadcast(`instance:log:${defaultGameContext.gameId}:${msg.role}`, msg)
})
logStream.start()

// ---------------------------------------------------------------------------
// HTTP server + WebSocket upgrade 分发
// ---------------------------------------------------------------------------
const server = http.createServer(app)
server.on('upgrade', (req, socket, head) => {
  wsHub.handleUpgrade(req, socket, head)
})

server.on('error', (err) => {
  console.error(`[admin] server error: ${err.message}`)
  process.exit(1)
})

server.listen(ADMIN_PORT, () => {
  console.log(`[admin] listening on http://localhost:${ADMIN_PORT}`)
  console.log(`[admin] GAME_ROOT=${GAME_ROOT}`)
  console.log(`[admin] CORS_ORIGINS=${corsOrigins.join(',')}`)
  console.log(
    `[admin] ws channels: /ws?channel=instance:state:{gameId} | instance:log:{gameId}:{role} | live:{gameId}:{role}`,
  )
})

// 优雅退出：只关管理后端自身（游戏实例生命周期独立，交由 REST stop 管理）。
function shutdown(signal: string): void {
  console.log(`[admin] received ${signal}, shutting down`)
  liveState.stopAll()
  logStream.stop()
  wsHub.stop()
  server.close(() => process.exit(0))
  // 兜底：2s 后强制退出（等待中的 keep-alive 连接不应阻塞退出）。
  setTimeout(() => process.exit(0), 2_000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
