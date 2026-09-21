/**
 * 实例目标：
 * - official：正式实例（默认，行为与历史版本一致）
 * - preview：预览实例（后续 UI 车道接入下拉切换用）
 */
export type InstanceTarget = 'official' | 'preview'

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
 * 按实例目标解析 Colyseus 服务端连接地址。
 *
 * 约定：
 * - official：默认连接本机服务端 ws://localhost:3000，通过 VITE_GAME_SERVER_URL 覆盖
 * - preview：默认连接预览服务端 ws://localhost:3200，通过 VITE_PREVIEW_SERVER_URL 覆盖
 *
 * @param target 实例目标（默认 official，行为与历史版本一致）
 * @returns 规范化后的 WebSocket 端点
 */
export function resolveServerUrl(target: InstanceTarget = 'official'): string {
  if (target === 'preview') {
    return normalizeServerEndpoint(
      (import.meta.env.VITE_PREVIEW_SERVER_URL as string | undefined) ?? 'ws://localhost:3200',
    )
  }
  return normalizeServerEndpoint(
    (import.meta.env.VITE_GAME_SERVER_URL as string | undefined) ?? 'ws://localhost:3000',
  )
}

/**
 * 由 WebSocket 端点派生 HTTP 基础地址（用于拉取地图等非 WebSocket 资源）。
 *
 * @param wsEndpoint WebSocket 端点
 * @returns HTTP 基础地址
 */
function resolveHttpBaseUrl(wsEndpoint: string): string {
  return wsToHttpEndpoint(wsEndpoint)
}

/**
 * 由任意 ws/wss 端点派生 HTTP 基础地址（公开版本）。
 *
 * 用途：观察视图按实例目标切换连接地址后，地图等 HTTP 资源
 * 需要从同一实例拉取（而不是固定 official 的 HTTP 基址）。
 *
 * @param wsEndpoint WebSocket 端点
 * @returns HTTP 基础地址
 */
export function resolveHttpBaseUrlFromWs(wsEndpoint: string): string {
  return resolveHttpBaseUrl(wsEndpoint)
}

/**
 * Colyseus 服务端连接地址（official 实例，模块加载时解析一次）。
 */
export const gameServerUrl = resolveServerUrl('official')

/**
 * HTTP 基础地址（用于拉取地图等非 WebSocket 资源）。
 */
export const gameServerHttpBaseUrl = resolveHttpBaseUrl(gameServerUrl)
