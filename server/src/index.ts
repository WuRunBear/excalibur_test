/**
 * 管理后端入口（S1-C）。
 *
 * 组装：express（JSON body + 手写 CORS 白名单中间件）→ REST 路由 →
 * node:http server → 'upgrade' 交给 wsHub（/ws?channel=<白名单>）→ listen ADMIN_PORT。
 *
 * 事件接线：
 * - instanceManager 状态变更 → wsHub.broadcast('instance:state', snapshot)
 * - instanceManager 子进程行 → logStream.ingestProcessLine（环形缓冲 + 广播）
 * - logStream 新日志（文件/进程）→ wsHub.broadcast(`instance:log:<role>`, msg)
 *
 * 注意：管理后端退出时不会连带杀掉已拉起的游戏实例（实例生命周期独立，
 * 由 REST /api/instances/:role/stop 管理）。
 */
import http from 'node:http'

import express from 'express'
import type { NextFunction, Request, Response } from 'express'

import { ADMIN_PORT, GAME_ROOT, corsOrigins } from './config.js'
import { configContextRouter } from './routes/configContext.js'
import { configsRouter } from './routes/configs.js'
import { processRouter } from './routes/process.js'
import { workspaceRouter } from './routes/workspace.js'
import { instanceManagers } from './services/instanceManager.js'
import { logStream } from './services/logStream.js'
import type { WsChannel } from './ws/hub.js'
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

// REST 路由
app.use('/api/instances', processRouter)
app.use('/api/workspaces', workspaceRouter)
app.use('/api/configs', configsRouter)
app.use('/api/config-context', configContextRouter)

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

// ---------------------------------------------------------------------------
// 事件接线（进程管理 ↔ 日志流 ↔ WS 广播）
// ---------------------------------------------------------------------------
for (const manager of Object.values(instanceManagers)) {
  manager.onStateChange((snapshot) => {
    wsHub.broadcast('instance:state', snapshot)
  })
  manager.onLine((role, source, line) => {
    logStream.ingestProcessLine(role, source, line)
  })
}
logStream.onLog((msg) => {
  wsHub.broadcast(`instance:log:${msg.role}` as WsChannel, msg)
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
  console.log(`[admin] ws channels: /ws?channel=instance:state | instance:log:official | instance:log:preview`)
})

// 优雅退出：只关管理后端自身（游戏实例生命周期独立，交由 REST stop 管理）。
function shutdown(signal: string): void {
  console.log(`[admin] received ${signal}, shutting down`)
  logStream.stop()
  wsHub.stop()
  server.close(() => process.exit(0))
  // 兜底：2s 后强制退出（等待中的 keep-alive 连接不应阻塞退出）。
  setTimeout(() => process.exit(0), 2_000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
