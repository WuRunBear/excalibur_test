/**
 * GameContext —— 全部"游戏特化"常量的单一出口（T1.4）。
 *
 * Phase 1（单游戏）里 defaultGameContext 以数据固化现状行为（gameId 'gst'，
 * 全部取值与原 config.ts / instanceManager.ts / configService.ts 硬编码一致）；
 * Phase 2 工厂化时按 gameId → GameContext 生成 per-game 上下文，消费方
 * （config 兼容壳 / instanceManager / saveService / logStream / liveState /
 * configService.routeSchemaKind）不再持有游戏特化硬编码。
 *
 * 约定：
 * - 本文件位于 <excalibur_test>/server/src/，按相对层数定位本体仓库
 *   game_server_test（../../../game_server_test/），GAME_ROOT 环境变量可覆盖。
 * - 派生目录（logs / saves / game）只定义路径；是否创建由使用方负责
 *   （本阶段只有 gameLogsDir 需要容错不存在）。
 * - ports.official 的解析优先级：OFFICIAL_PORT env → 本体 .env 的 PORT → 3000
 *   （official 不注入 PORT，展示值只能尽力解析，详见 config.ts 原注释语义）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * schema 路由表条目：relPath（'/' 分隔，相对工作区 game/）→ schemaKind。
 *
 * - pattern：完整锚定（^...$）的正则源串（new RegExp(pattern) 使用）。
 * - kind：'*' 语义表示 kind = 命中文件的文件名（去 .json 后缀，即规则名，
 *   如 rules/combat.json → 'combat'）；其余为字面 kind（如 'GameDefinition'）。
 */
export interface SchemaRoute {
  pattern: string
  kind: string
}

/** 单个游戏的全部特化上下文。 */
export interface GameContext {
  /** 游戏标识（Phase 2 per-game 工厂的键）。 */
  gameId: string
  /** 本体游戏仓库根（游戏实例的工作目录）。 */
  gameRoot: string
  /** 本体配置目录（<gameRoot>/game，S2-A 工作区镜像源）。 */
  gameConfigsDir: string
  /** 本体游戏日志目录（winston File transport 写 <gameRoot>/logs/game.log）。 */
  gameLogsDir: string
  /** 本体游戏日志文件（logStream tail 的目标，不存在时容错等待）。 */
  gameLogFile: string
  /** official 存档目录（<gameRoot>/data/saves）。 */
  savesDir: string
  /** 本体环境文件（official 展示端口解析链读取 .env 的 PORT 用）。 */
  envFile: string
  /** 双角色展示端口（official 见上方解析链；preview 恒 3200）。 */
  ports: { official: number; preview: number }
  /** 游戏实例启动命令（win32 下 pnpm → pnpm.cmd 的平台适配留在消费方）。 */
  start: { command: string; args: string[] }
  /** preview 实例注入的环境变量**名**（值由消费方在 spawn 前动态解析）。 */
  envInjection: { port: string; configPath: string; saveDir: string }
  /** 配置文件 schema 路由表（configService.routeSchemaKind 的数据源）。 */
  schemaRoutes: SchemaRoute[]
  /** Colyseus 房间名（liveState server 侧 join；web 端本 Phase 仍用常量）。 */
  roomName: string
}

/**
 * 从本体 .env 解析 PORT（模仿游戏进程 dotenv 的读取位置与不覆盖语义的近似值）。
 * 解析失败（文件不存在 / 无 PORT 行）返回 undefined。
 */
function readGameEnvPort(envFile: string): number | undefined {
  try {
    const raw = fs.readFileSync(envFile, 'utf8')
    const m = /^PORT\s*=\s*(\d+)\s*(?:#.*)?$/m.exec(raw)
    return m ? Number(m[1]) : undefined
  } catch {
    return undefined
  }
}

/**
 * 本体游戏仓库根。默认从 server/src/gameContext.ts 向上三层定位：
 * src → server → excalibur_test → game/，GAME_ROOT 环境变量可覆盖。
 */
const gameRoot = path.resolve(
  process.env.GAME_ROOT ?? fileURLToPath(new URL('../../../game_server_test/', import.meta.url)),
)

const gameConfigsDir = path.join(gameRoot, 'game')
const gameLogsDir = path.join(gameRoot, 'logs')
const envFile = path.join(gameRoot, '.env')

/** 当前游戏上下文（Phase 1 单游戏：全部值取自现状代码，行为不变）。 */
export const defaultGameContext: GameContext = {
  gameId: 'gst',
  gameRoot,
  gameConfigsDir,
  gameLogsDir,
  gameLogFile: path.join(gameLogsDir, 'game.log'),
  savesDir: path.join(gameRoot, 'data', 'saves'),
  envFile,
  ports: {
    official: Number(process.env.OFFICIAL_PORT ?? readGameEnvPort(envFile) ?? 3000),
    preview: 3200,
  },
  start: { command: 'pnpm', args: ['dev'] },
  envInjection: { port: 'PORT', configPath: 'GAME_CONFIG_PATH', saveDir: 'SAVE_DIR' },
  schemaRoutes: [
    { pattern: '^game\\.json$', kind: 'GameDefinition' },
    { pattern: '^entities\\/[^/]+\\.json$', kind: 'Archetype' },
    { pattern: '^maps\\/registry\\.json$', kind: 'MapRegistry' },
    { pattern: '^rules\\/combat\\.json$', kind: '*' },
    { pattern: '^rules\\/needs\\.json$', kind: '*' },
    { pattern: '^rules\\/crafting\\.json$', kind: '*' },
    { pattern: '^rules\\/daynight\\.json$', kind: '*' },
    { pattern: '^rules\\/server\\.json$', kind: '*' },
  ],
  roomName: 'game',
}
