/**
 * 管理后端配置（S1-C 完整版）。
 *
 * 约定：
 * - 本文件位于 <excalibur_test>/server/src/，按相对层数定位本体仓库
 *   game_server_test（../../../game_server_test/），GAME_ROOT 环境变量可覆盖。
 * - 派生目录（logs / workspaces / backups）只定义路径；是否创建由使用方负责
 *   （本阶段只有 gameLogsDir 需要容错不存在）。
 * - 端口均可在启动管理后端时用环境变量覆盖。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { InstanceRole } from './types.js'

/** 本文件所在目录（<excalibur_test>/server/src）。 */
const hereDir = path.dirname(fileURLToPath(import.meta.url))

/** excalibur_test 仓库根（server/ 的上一级）。 */
export const repoRoot = path.resolve(hereDir, '../..')

/**
 * 本体游戏仓库根（游戏实例的工作目录）。
 * 默认从 server/src/config.ts 向上三层定位：src → server → excalibur_test → game/。
 */
export const GAME_ROOT = path.resolve(
  process.env.GAME_ROOT ?? fileURLToPath(new URL('../../../game_server_test/', import.meta.url)),
)

/** 本体游戏日志目录（winston File transport 写 <游戏cwd>/logs/game.log，游戏 cwd = GAME_ROOT）。 */
export const gameLogsDir = path.join(GAME_ROOT, 'logs')
/** 本体游戏日志文件（logStream tail 的目标，不存在时容错等待）。 */
export const gameLogFile = path.join(gameLogsDir, 'game.log')

/** 本体配置目录（S2-A 工作区镜像源：<GAME_ROOT>/game）。 */
export const gameConfigsDir = path.join(GAME_ROOT, 'game')

/** 管理端工作区目录（S2 文件系统通道使用，本阶段仅定义，不创建）。 */
export const workspacesDir = path.join(repoRoot, 'server', 'workspaces')
/** 备份目录（S3 存档通道使用，本阶段仅定义，不创建）。 */
export const backupsDir = path.join(repoRoot, 'server', 'backups')

/** 管理后端 HTTP/WS 监听端口。 */
export const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 3100)

/** 预览实例端口常量（S1 仅作展示与 PORT 注入用）。 */
export const PREVIEW_PORT = 3200

/**
 * 从本体 .env 解析 PORT（模仿游戏进程 dotenv 的读取位置与不覆盖语义的近似值）。
 * 解析失败（文件不存在 / 无 PORT 行）返回 undefined。
 */
function readGameEnvPort(): number | undefined {
  try {
    const raw = fs.readFileSync(path.join(GAME_ROOT, '.env'), 'utf8')
    const m = /^PORT\s*=\s*(\d+)\s*(?:#.*)?$/m.exec(raw)
    return m ? Number(m[1]) : undefined
  } catch {
    return undefined
  }
}

/**
 * official 实例的展示端口。
 *
 * official 启动时不注入 PORT（继承管理后端环境），游戏进程的 dotenv 会再读
 * 本体 .env，因此实际监听端口优先级为：管理端已注入的 PORT > 本体 .env > 3000。
 * 管理端无法得知未来注入值，这里按 OFFICIAL_PORT env → 本体 .env → 3000 解析
 * 展示值；若通过启动环境给 official 注入了 PORT，请同步设置 OFFICIAL_PORT。
 */
export const OFFICIAL_PORT = Number(process.env.OFFICIAL_PORT ?? readGameEnvPort() ?? 3000)

/** 角色 → 展示端口。 */
export function rolePort(role: InstanceRole): number {
  return role === 'official' ? OFFICIAL_PORT : PREVIEW_PORT
}

/** 管理端 CORS 白名单（CORS_ORIGINS 逗号分隔可覆盖）。 */
export const corsOrigins: string[] = (() => {
  const raw = process.env.CORS_ORIGINS?.trim()
  if (!raw) return ['http://localhost:5173', 'http://localhost:5174']
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
})()
