/**
 * 管理后端配置（S1-C 完整版）—— T1.4 起本文件为兼容壳。
 *
 * 游戏特化常量（GAME_ROOT / gameLogsDir / gameLogFile / gameConfigsDir /
 * PREVIEW_PORT / OFFICIAL_PORT）已收敛到 gameContext.defaultGameContext
 * （单一出口）；本文件保留原导出名供既有消费方引用，取值全部转自 context，
 * 行为不变。official 展示端口的解析链（OFFICIAL_PORT env → 本体 .env PORT →
 * 3000）随数据一起移入 gameContext.ts。
 *
 * 仍在本文件定义的非游戏特化配置：
 * - repoRoot / workspacesDir / backupsDir（excalibur_test 侧目录）
 * - ADMIN_PORT / corsOrigins（管理后端自身配置，env 可覆盖）
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { InstanceRole } from './types.js'
import { defaultGameContext } from './gameContext.js'

/** 本文件所在目录（<excalibur_test>/server/src）。 */
const hereDir = path.dirname(fileURLToPath(import.meta.url))

/** excalibur_test 仓库根（server/ 的上一级）。 */
export const repoRoot = path.resolve(hereDir, '../..')

/**
 * 本体游戏仓库根（游戏实例的工作目录）。
 * 兼容壳：出自 defaultGameContext.gameRoot（定位规则见 gameContext.ts）。
 */
export const GAME_ROOT = defaultGameContext.gameRoot

/** 本体游戏日志目录（兼容壳，出自 defaultGameContext.gameLogsDir）。 */
export const gameLogsDir = defaultGameContext.gameLogsDir
/** 本体游戏日志文件（兼容壳，出自 defaultGameContext.gameLogFile）。 */
export const gameLogFile = defaultGameContext.gameLogFile

/** 本体配置目录（兼容壳，出自 defaultGameContext.gameConfigsDir）。 */
export const gameConfigsDir = defaultGameContext.gameConfigsDir

/** 管理端工作区目录（S2 文件系统通道使用，本阶段仅定义，不创建）。 */
export const workspacesDir = path.join(repoRoot, 'server', 'workspaces')
/** 备份目录（S3 存档通道使用，本阶段仅定义，不创建）。 */
export const backupsDir = path.join(repoRoot, 'server', 'backups')

/** 管理后端 HTTP/WS 监听端口。 */
export const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 3100)

/** 预览实例端口常量（S1 仅作展示与 PORT 注入用；兼容壳，出自 context.ports.preview）。 */
export const PREVIEW_PORT = defaultGameContext.ports.preview

/**
 * official 实例的展示端口（兼容壳，出自 context.ports.official）。
 *
 * official 启动时不注入 PORT（继承管理后端环境），实际监听端口优先级为：
 * 管理端已注入的 PORT > 本体 .env > 3000；解析链在 gameContext.ts 实现，
 * 若通过启动环境给 official 注入了 PORT，请同步设置 OFFICIAL_PORT。
 */
export const OFFICIAL_PORT = defaultGameContext.ports.official

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
