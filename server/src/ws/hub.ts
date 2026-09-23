/**
 * WebSocket 频道中心（S1-C；T2.7 频道寻址游戏化）。
 *
 * - WebSocketServer({ noServer: true })：由 index.ts 在 HTTP server 的 'upgrade'
 *   事件里调用 handleUpgrade，按 URL `/ws?channel=<name>` 分发。
 * - 频道公式（docs/multi-game-plan.md §4 T2.4/T2.7，per-game 寻址）：
 *   - `instance:state:{gameId}`          实例状态快照广播
 *   - `instance:log:{gameId}:{role}`     实例子进程/文件日志广播
 *   - `live:{gameId}:{role}`             liveState 采样广播（liveChannel 生成）
 * - 白名单（T2.7）：固定 tuple 改**模式校验** `^(instance:state|instance:log|live):
 *   [\w-]+(?::[\w-]+)?$`，再叠加结构收紧——段数与 role 必须与上方广播公式一致。
 *   细化的原因：粗正则无法实现规格的两条硬性要求——"旧频道名不保留"
 *   （live:official / instance:log:official 等恰好能被粗正则命中）与验证项
 *   "live:{gameId}（缺 role）被拒"。细化后旧频道名一律拒绝（web 与 server
 *   同窗口发布，见 T2.8）。
 * - broadcast(channel, payload) 向频道内所有连接广播 JSON。
 * - 连接级 ping/pong 心跳（30s）：pong 超时视为断连并 terminate，容错僵尸连接。
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import { WebSocket, WebSocketServer } from 'ws'

import type { InstanceRole } from '../types.js'

/**
 * 频道名粗校验正则（T2.7 规格）：命名空间前缀 + [\w-] 段。
 * 仅作第一道过滤；能否订阅以 isWsChannel 的结构校验为准。
 */
export const WS_CHANNEL_PATTERN = /^(instance:state|instance:log|live):[\w-]+(?::[\w-]+)?$/

/** 合法订阅频道（动态 per-game 命名；以 isWsChannel 为唯一判定源）。 */
export type WsChannel = string

/** 实例角色字面量（频道 role 段校验用；与 types.InstanceRole 保持一致）。 */
const INSTANCE_ROLES: readonly string[] = ['official', 'preview']

/**
 * 频道白名单判定：粗正则 + 广播公式结构校验（段数/role）。
 * - `instance:state:{gameId}`           ✓（3 段；快照无 role 维度）
 * - `instance:log:{gameId}:{role}`      ✓（4 段，role ∈ official|preview）
 * - `live:{gameId}:{role}`              ✓（3 段，role ∈ official|preview）
 * - `live:{gameId}` / `live:official` / `instance:log:official`（旧名或缺段）✗
 */
export function isWsChannel(value: string): boolean {
  if (!WS_CHANNEL_PATTERN.test(value)) return false
  const parts = value.split(':')
  if (parts[0] === 'instance' && parts[1] === 'state') {
    return parts.length === 3
  }
  if (parts[0] === 'instance' && parts[1] === 'log') {
    return parts.length === 4 && INSTANCE_ROLES.includes(parts[3] ?? '')
  }
  // live:{gameId}:{role}
  return parts.length === 3 && INSTANCE_ROLES.includes(parts[2] ?? '')
}

/** 心跳间隔（ms）。 */
const HEARTBEAT_INTERVAL_MS = 30_000

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
