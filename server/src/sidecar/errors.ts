/**
 * sidecar 错误 → REST 语义错误映射（T1.7 收敛：全平台单一实现）。
 *
 * 此前 toRestError/sidecarCall 在 configService.ts、toWorkspaceError 在
 * mapService.ts 各有一份（T1.5/T1.6 并行期的重复），本文件合并为唯一出处，
 * configService / applyService / registries 路由 / mapService 全部改引。
 *
 * §0.2 错误码 → REST 状态映射（文案逐字保留收敛前的 configService 版）：
 *   bad_request        → 400（message 原样）
 *   game_config_error  → 422（message 原样；调用方可传 configErrorMessage
 *                          定制文案，mapService 用它保留 `地图生成失败：` 前缀）
 *   driver_error       → 500（`sidecar driver 异常：` 前缀）
 *   unavailable        → 503（`sidecar 不可用：` 前缀）
 *   timeout            → 504（message 原样）
 * 非 SidecarError 原样透传（保持既有错误语义）。映射产物为 WorkspaceError，
 * 由 handleError 按其自带 status 响应。
 */
import { WorkspaceError } from '../services/workspaceService.js'
import { SidecarError } from './client.js'

function toRestError(err: unknown, configErrorMessage?: (message: string) => string): unknown {
  if (!(err instanceof SidecarError)) return err
  switch (err.code) {
    case 'bad_request':
      return new WorkspaceError(400, err.message)
    case 'game_config_error':
      return new WorkspaceError(422, configErrorMessage ? configErrorMessage(err.message) : err.message)
    case 'driver_error':
      return new WorkspaceError(500, `sidecar driver 异常：${err.message}`)
    case 'unavailable':
      return new WorkspaceError(503, `sidecar 不可用：${err.message}`)
    case 'timeout':
      return new WorkspaceError(504, err.message)
  }
}

/**
 * sidecar RPC 调用统一包装：拒绝时按 §0.2 错误码映射为 REST 语义错误再抛出。
 * configErrorMessage 仅作用于 game_config_error（422）的 message 定制，
 * 其余四码文案固定（见头注释）。
 */
export async function sidecarCall<T>(
  rpc: Promise<T>,
  configErrorMessage?: (message: string) => string,
): Promise<T> {
  try {
    return await rpc
  } catch (err) {
    throw toRestError(err, configErrorMessage)
  }
}
