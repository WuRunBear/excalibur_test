/**
 * WebSocket 频道中心（S1-C）。
 *
 * - WebSocketServer({ noServer: true })：由 index.ts 在 HTTP server 的 'upgrade'
 *   事件里调用 handleUpgrade，按 URL `/ws?channel=<name>` 分发。
 * - 仅接受白名单频道：instance:state、instance:log:official、instance:log:preview；
 *   其余 upgrade 请求直接销毁 socket。
 * - broadcast(channel, payload) 向频道内所有连接广播 JSON。
 * - 连接级 ping/pong 心跳（30s）：pong 超时视为断连并 terminate，容错僵尸连接。
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import { WebSocket, WebSocketServer } from 'ws'

/** 允许订阅的频道白名单。 */
export const WS_CHANNELS = [
  'instance:state',
  'instance:log:official',
  'instance:log:preview',
  'live:official',
  'live:preview',
] as const

export type WsChannel = (typeof WS_CHANNELS)[number]

/** 心跳间隔（ms）。 */
const HEARTBEAT_INTERVAL_MS = 30_000

function isWsChannel(value: string): value is WsChannel {
  return (WS_CHANNELS as readonly string[]).includes(value)
}

export class WsHub {
  private readonly wss = new WebSocketServer({ noServer: true })
  /** 频道 → 成员连接集合。 */
  private readonly members = new Map<WsChannel, Set<WebSocket>>()
  /** 心跳存活标记（每连接）。 */
  private readonly alive = new WeakMap<WebSocket, boolean>()
  private heartbeatTimer: NodeJS.Timeout | null = null

  /**
   * 处理 HTTP server 的 'upgrade' 事件。
   * 非法路径 / 非白名单频道 → 销毁 socket；合法 → 注册进频道并触发 'connection'。
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      socket.destroy()
      return
    }
    if (url.pathname !== '/ws') {
      socket.destroy()
      return
    }
    const channel = url.searchParams.get('channel') ?? ''
    if (!isWsChannel(channel)) {
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.register(channel, ws)
      this.wss.emit('connection', ws, req)
    })
  }

  /** 向频道内所有连接广播 JSON 负载。 */
  broadcast(channel: WsChannel, payload: unknown): void {
    const set = this.members.get(channel)
    if (!set || set.size === 0) return
    const data = JSON.stringify(payload)
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data, (err) => {
          if (err) console.error('[wsHub] send failed:', err.message)
        })
      }
    }
  }

  /** 频道当前连接数（诊断用）。 */
  channelSize(channel: WsChannel): number {
    return this.members.get(channel)?.size ?? 0
  }

  /** 停止心跳（测试 / 优雅退出用）。 */
  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private register(channel: WsChannel, ws: WebSocket): void {
    let set = this.members.get(channel)
    if (!set) {
      set = new Set()
      this.members.set(channel, set)
    }
    set.add(ws)
    this.alive.set(ws, true)

    ws.on('pong', () => this.alive.set(ws, true))
    const unregister = () => {
      set.delete(ws)
      if (set.size === 0) this.members.delete(channel)
    }
    ws.on('close', unregister)
    ws.on('error', unregister)

    this.ensureHeartbeat()
  }

  /** 全局心跳：对所有频道成员 ping；上一轮未 pong 的连接视为断连并 terminate。 */
  private ensureHeartbeat(): void {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => {
      for (const set of this.members.values()) {
        for (const ws of set) {
          if (this.alive.get(ws) === false) {
            ws.terminate()
            continue
          }
          this.alive.set(ws, false)
          ws.ping()
        }
      }
    }, HEARTBEAT_INTERVAL_MS)
    // 计时器不阻止进程退出。
    this.heartbeatTimer.unref()
  }
}

/** wsHub 单例。 */
export const wsHub = new WsHub()
