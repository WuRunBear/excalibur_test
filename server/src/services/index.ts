/**
 * per-game 服务容器（T2.4）—— servicesFor(gameId) 聚合全部领域服务。
 *
 * 模式（docs/multi-game-plan.md §4 T2.4）：每个服务从"模块级全局单例"改为
 * "构造器收 GameContext + 按 gameId 缓存的实例"；本文件是唯一聚合点：
 *
 * - servicesFor(gameId, options?)：按 gameId（+ 注入 options）取/建该游戏的
 *   全套服务实例 { workspace, config, map, save, apply, log, live, instances }；
 *   容器内部共享一个 contextHolder，gameContext.forGame 重建 context（manifest/
 *   registry 文件变化）后下次调用自动热更新到既有实例（进程句柄/环形缓冲/
 *   观察会话等有状态对象不重建）。
 * - invalidateServicesFor(gameId, options?)：显式丢弃容器缓存（下次全新构建；
 *   注意**不**停止已拉起的游戏进程——实例生命周期独立，由 REST stop 管理）。
 * - compat 策略：各服务文件仍导出绑定 defaultGameContext（≡ forGame('gst')
 *   语义）的模块级单例；servicesFor('gst')（**缺省 options**）直接复用这批
 *   单例（含 instanceManagers 记录），与 index.ts 的启动接线共享同一批实例，
 *   路由层（T2.7 才改接）过渡期零改动、无状态分叉。带注入 options 的
 *   servicesFor('gst', {...}) 则走普通容器（测试命名空间隔离用）。
 * - sidecar：服务方法在**调用时点**经 sidecarManager.forGame(gameId) 解析
 *   client（指纹变化/重建后自动拿新 client），不再持有模块级单例 sidecar；
 *   各服务构造器可注入 sidecar 解析器（测试 stub 用）。
 *
 * 循环引用说明：本文件 ↔ instanceManager.ts（工厂委托）互相 import，均只在
 * 函数体内使用对方导出（ESM live binding，无 TDZ 风险）。
 */
import { defaultGameContext, forGame, type ForGameOptions, type GameContext } from '../gameContext.js'
import { sidecarManager } from '../sidecar/manager.js'
import type { SidecarClient } from '../sidecar/client.js'
import { ApplyService, applyService } from './applyService.js'
import { ConfigService, configService } from './configService.js'
import { InstanceManager, instanceManagers } from './instanceManager.js'
import { LiveStateService, liveState } from './liveState.js'
import { LogStreamService, logStream } from './logStream.js'
import { MapService, mapService } from './mapService.js'
import { SaveService, saveService } from './saveService.js'
import { WorkspaceService, workspaceService } from './workspaceService.js'
import type { InstanceRole } from '../types.js'

/** 容器内共享的可变 context 引用：servicesFor 检测到 context 重建时整体热更新。 */
export interface ContextHolder {
  current: GameContext
}

/** servicesFor 可注入项（ForGameOptions 透传 gameContext + 存储根目录注入）。 */
export interface ServicesForOptions extends ForGameOptions {
  /** 工作区根目录（per-game 目录 = <root>/<gameId>）；缺省 config.workspacesDir。 */
  workspacesRoot?: string
  /** 备份根目录（per-game 目录 = <root>/<gameId>）；缺省 config.backupsDir。 */
  backupsRoot?: string
}

/** 单个游戏的全部服务实例（T2.4 聚合；路由层 T2.7 起经此寻址）。 */
export interface GameServices {
  gameId: string
  /** 当前上下文（热更新后随取随新）。 */
  readonly context: GameContext
  /** sidecar client（调用时点经 sidecarManager.forGame(gameId) 解析，恒为当前指纹的 client）。 */
  sidecar(): SidecarClient
  workspace: WorkspaceService
  config: ConfigService
  map: MapService
  save: SaveService
  apply: ApplyService
  /** 日志流（tail + 环形缓冲；start/stop 由接线方负责）。 */
  log: LogStreamService
  /** liveState 观察（per-game 内部态 key = `<gameId>:<role>`）。 */
  live: LiveStateService
  /** 双实例管理器（official/preview 各一，进程句柄状态跨调用保持）。 */
  instances: Record<InstanceRole, InstanceManager>
}

// ---------------------------------------------------------------------------
// 容器缓存
// ---------------------------------------------------------------------------

interface ContainerSlot {
  holder: ContextHolder
  services: GameServices
}

/** 缓存键含注入路径（测试注入 /tmp 与真实路径互不串台），同 gameContext.forGame。 */
function containerKey(gameId: string, options?: ServicesForOptions): string {
  return [
    options?.registryPath ?? '(default-registry)',
    options?.gamesDir ?? '(default-games)',
    options?.workspacesRoot ?? '(default-workspaces)',
    options?.backupsRoot ?? '(default-backups)',
    gameId,
  ].join('\u0000')
}

function hasInjectableRoots(options?: ServicesForOptions): boolean {
  return (
    options?.registryPath !== undefined ||
    options?.gamesDir !== undefined ||
    options?.workspacesRoot !== undefined ||
    options?.backupsRoot !== undefined
  )
}

const containers = new Map<string, ContainerSlot>()

/** 缺省 gst 容器（compat 单例集合）的惰性构建缓存。 */
let defaultGstServices: GameServices | null = null

/**
 * compat 单例集合 = servicesFor('gst')（缺省 options）：
 * 直接复用各服务文件的模块级单例与 instanceManagers 记录——它们绑定
 * defaultGameContext（值恒等于 forGame('gst') 的合成结果：local 源锚
 * ../game_server_test、端口 3001/3200、roomName 'game'），且不依赖 registry
 * 播种（模块加载零风险）。缺省 options 的判定保证测试注入路径时走普通容器。
 */
function defaultServicesForGst(): GameServices {
  if (defaultGstServices) return defaultGstServices
  defaultGstServices = {
    gameId: defaultGameContext.gameId,
    get context(): GameContext {
      return defaultGameContext
    },
    sidecar: () => sidecarManager.forGame(defaultGameContext.gameId),
    workspace: workspaceService,
    config: configService,
    map: mapService,
    save: saveService,
    apply: applyService,
    log: logStream,
    live: liveState,
    instances: instanceManagers,
  }
  return defaultGstServices
}

/** 普通容器构建（全部服务同一 holder；sidecar 经 manager 按 gameId 解析）。 */
function buildServices(gameId: string, holder: ContextHolder, options?: ServicesForOptions): GameServices {
  const workspace = new WorkspaceService({ context: holder, workspacesRoot: options?.workspacesRoot })
  const sidecarResolver: (() => SidecarClient) | undefined = options
    ? () => sidecarManager.forGame(gameId, { registryPath: options.registryPath, gamesDir: options.gamesDir })
    : undefined
  const config = new ConfigService({ context: holder, workspace, ...(sidecarResolver ? { sidecar: sidecarResolver } : {}) })
  const map = new MapService({ context: holder, workspace, ...(sidecarResolver ? { sidecar: sidecarResolver } : {}) })
  const save = new SaveService({ context: holder, workspace })
  const apply = new ApplyService({
    context: holder,
    workspace,
    config,
    ...(options?.backupsRoot ? { backupsRoot: options.backupsRoot } : {}),
    ...(sidecarResolver ? { sidecar: sidecarResolver } : {}),
  })
  const log = new LogStreamService({ context: holder })
  const live = new LiveStateService({ context: holder })
  const instances: Record<InstanceRole, InstanceManager> = {
    official: new InstanceManager({ gameId, role: 'official', context: holder, workspace }),
    preview: new InstanceManager({ gameId, role: 'preview', context: holder, workspace }),
  }
  const services: GameServices = {
    gameId,
    get context(): GameContext {
      return holder.current
    },
    sidecar: () => sidecarResolver?.() ?? sidecarManager.forGame(gameId),
    workspace,
    config,
    map,
    save,
    apply,
    log,
    live,
    instances,
  }
  return services
}

/**
 * per-game 服务容器入口（T2.4）。
 *
 * - gameId 为缺省游戏且未注入任何 options → 返回 compat 单例集合（见
 *   defaultServicesForGst；与既有模块级单例完全同实例）；
 * - 其余 → 普通容器：gameContext.forGame(gameId, options) 解析 context（未注册
 *   游戏 → GameContextError，T2.7 映射 404）；缓存命中且 context 对象未重建 →
 *   直接返回；context 重建（manifest/registry 变化）→ 热更新 holder，既有
 *   服务实例（含运行中实例的句柄状态）原样保留。
 */
export function servicesFor(gameId: string, options?: ServicesForOptions): GameServices {
  if (gameId === defaultGameContext.gameId && !hasInjectableRoots(options)) {
    return defaultServicesForGst()
  }
  const key = containerKey(gameId, options)
  const slot = containers.get(key)
  const ctx = forGame(gameId, options)
  if (slot) {
    if (slot.holder.current !== ctx) slot.holder.current = ctx // context 热更新
    return slot.services
  }
  const holder: ContextHolder = { current: ctx }
  const services = buildServices(gameId, holder, options)
  containers.set(key, { holder, services })
  return services
}

/**
 * 显式丢弃容器缓存（下次 servicesFor 全新构建）。返回是否存在并已删除。
 * **不停止**已拉起的游戏进程、不杀 sidecar driver（需要时另调
 * sidecarManager.invalidate(gameId)）——实例生命周期独立是平台既有语义。
 * 缺省 gst 容器（compat 单例集合）不可丢弃，恒返回 false。
 */
export function invalidateServicesFor(gameId: string, options?: ServicesForOptions): boolean {
  if (gameId === defaultGameContext.gameId && !hasInjectableRoots(options)) return false
  return containers.delete(containerKey(gameId, options))
}

// ---------------------------------------------------------------------------
// 供 T2.7 使用的静态再导出（路由层从此只 import services/index.js）
// ---------------------------------------------------------------------------

// 服务类（测试/工具需要直构时用；运行时请走 servicesFor）
export { ApplyService } from './applyService.js'
export { ConfigService } from './configService.js'
export { InstanceManager } from './instanceManager.js'
export { LiveStateService, liveChannel } from './liveState.js'
export { LogStreamService } from './logStream.js'
export { MapService } from './mapService.js'
export { SaveService } from './saveService.js'
export { WorkspaceService } from './workspaceService.js'
// 错误类型（routes/helpers 仍从原文件 import，此处仅为收敛预留）
export { ConflictError } from './instanceManager.js'
export { ValidationFailedError } from './configService.js'
export { WorkspaceError } from './workspaceService.js'
