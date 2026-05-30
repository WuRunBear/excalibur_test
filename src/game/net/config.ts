/**
 * 规范化服务器连接地址。
 *
 * 说明：
 * - Colyseus 客户端需要一个“带协议的端点”，例如 ws://localhost:3000 或 wss://example.com
 * - 这里对空字符串做兜底，避免环境变量没配导致启动即报错
 *
 * @param value 原始端点字符串
 * @returns 规范化后的端点字符串
 */
function normalizeServerEndpoint(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return 'ws://localhost:3000'
  return trimmed
}

/**
 * 将 ws/wss 端点转换为 http/https 端点，用于 fetch 地图等 HTTP 接口。
 *
 * @param wsEndpoint WebSocket 端点
 * @returns HTTP 端点
 */
function wsToHttpEndpoint(wsEndpoint: string): string {
  if (wsEndpoint.startsWith('wss://')) return `https://${wsEndpoint.slice('wss://'.length)}`
  if (wsEndpoint.startsWith('ws://')) return `http://${wsEndpoint.slice('ws://'.length)}`
  return wsEndpoint
}

/**
 * Colyseus 服务端连接地址。
 *
 * 约定：
 * - 默认连接本机服务端：ws://localhost:3000
 * - 通过 Vite 环境变量覆盖：VITE_GAME_SERVER_URL=ws://<host>:<port>
 */
export const gameServerUrl = normalizeServerEndpoint(
  (import.meta.env.VITE_GAME_SERVER_URL as string | undefined) ?? 'ws://localhost:3000',
)

/**
 * HTTP 基础地址（用于拉取地图等非 WebSocket 资源）。
 */
export const gameServerHttpBaseUrl = wsToHttpEndpoint(gameServerUrl)
