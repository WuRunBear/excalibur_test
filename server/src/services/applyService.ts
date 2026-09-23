/**
 * 落盘（Apply）服务（S4-A）——平台唯一写本体路径，安全性优先。
 *
 * 流程（execute）：
 *   互斥锁 → 活动工作区 → TOCTOU 复核（重算 changes 校验 path 集合）→
 *   文件级校验 → 整体校验终门（sidecar validateWhole，S3 结论：文件级 schema 对
 *   ecosystems 跨文件约束无感，必须以整体校验兜底）→
 *   备份 → 写回/删除 → 刷新工作区基线（changes 归零）。
 *
 * 备份结构 server/backups/<backupId>/：
 *   - files/<relPath>  被覆盖/删除文件的本体原内容（added 不存内容）
 *   - manifest.json    { backupId, createdAt, files: [{path, action}] }
 *
 * 回滚 = 完整逆操作：overwritten/deleted → 备份内容写回本体；added → 从本体删除。
 *
 * 并发：execute 与 rollback 共用进程内互斥标志（Node 单线程，进入时同步
 * check-and-set，任意 await 前生效），busy → 409。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { createTwoFilesPatch, structuredPatch } from 'diff'

import { backupsDir as defaultBackupsRoot } from '../config.js'
import { defaultGameContext, type GameContext } from '../gameContext.js'
import { sidecarManager } from '../sidecar/manager.js'
import type { SidecarClient } from '../sidecar/client.js'
import { sidecarCall } from '../sidecar/errors.js'
import { routeSchemaKind, configService, type ConfigService } from './configService.js'
import { toHolder, WorkspaceError, workspaceService, type WorkspaceService } from './workspaceService.js'
import type { ContextHolder } from './index.js'
import type {
  ApplyExecutePayload,
  ApplyFilePlan,
  ApplyPlanPayload,
  BackupFileAction,
  BackupFileEntry,
  BackupInfo,
  BackupListPayload,
  ConfigValidationError,
  RollbackPayload,
  WorkspaceChange,
} from '../types.js'

/** backupId：YYYYMMDD-HHmmss-<4 位随机>；格式校验兼防路径注入。 */
const BACKUP_ID_RE = /^\d{8}-\d{6}-[A-Za-z0-9]{4}$/

/** 统一响应里"工作区已变化"的提示语（TOCTOU 防护）。 */
const WS_CHANGED_MSG = '工作区已变化，请重新获取落盘计划'
/** 互斥 busy 提示语。 */
const BUSY_MSG = '落盘/回滚进行中，请稍后'

/** 带响应 detail 的服务错误（422 校验类需要携带明细）。 */
class ApplyDetailError extends WorkspaceError {
  readonly detail: unknown
  constructor(status: number, message: string, detail: unknown) {
    super(status, message)
    this.name = 'ApplyDetailError'
    this.detail = detail
  }
}

/** 构造参数（T2.4 per-game 实例化）。 */
export interface ApplyServiceOptions {
  /** 游戏上下文（或容器 contextHolder）。 */
  context: GameContext | ContextHolder
  /** 同一容器的 per-game 工作区服务（活动工作区/变更清单/基线刷新）。 */
  workspace: WorkspaceService
  /** 同一容器的 per-game 配置服务（文件级校验）。 */
  config: ConfigService
  /** 备份根目录（per-game 目录 = <root>/<gameId>）；缺省 config.backupsDir。 */
  backupsRoot?: string
  /** sidecar client 解析器（测试注入 stub 用）；缺省经 sidecarManager.forGame(gameId)。 */
  sidecar?: () => SidecarClient
}

export class ApplyService {
  /** execute/rollback 共用互斥标志。 */
  private busy = false
  private readonly holder: ContextHolder
  /** per-game 备份目录（<backupsRoot>/<gameId>）。 */
  private readonly backupsDir: string
  private readonly workspace: ApplyServiceOptions['workspace']
  private readonly config: ApplyServiceOptions['config']
  private readonly resolveSidecar: () => SidecarClient

  constructor(options: ApplyServiceOptions) {
    this.holder = toHolder(options.context)
    this.backupsDir = path.join(options.backupsRoot ?? defaultBackupsRoot, this.ctx.gameId)
    this.workspace = options.workspace
    this.config = options.config
    this.resolveSidecar = options.sidecar ?? (() => sidecarManager.forGame(this.ctx.gameId))
  }

  /** 当前上下文（容器热更新后自动生效）。 */
  private get ctx(): GameContext {
    return this.holder.current
  }

  // ---------------------------------------------------------------------------
  // 计划
  // ---------------------------------------------------------------------------

  /** 对当前全部 changes 出落盘计划（只读，不落锁）。 */
  async plan(): Promise<ApplyPlanPayload> {
    const { gameDir } = await this.workspace.requireActiveGameDir()
    const changes = await this.workspace.diffAgainstSource()
    const files: ApplyFilePlan[] = []
    for (const change of changes) {
      files.push(await this.buildFilePlan(gameDir, change))
    }
    return { files }
  }

  /** 单文件计划条目：读两侧内容 → diff 统计 → 文件级校验。 */
  private async buildFilePlan(gameDir: string, change: WorkspaceChange): Promise<ApplyFilePlan> {
    const wsAbs = path.join(gameDir, change.path)
    const sourceAbs = path.join(this.ctx.gameConfigsDir, change.path)

    const wsContent =
      change.status === 'deleted' ? null : await fsp.readFile(wsAbs, 'utf8')
    let sourceContent: string | null = null
    try {
      sourceContent = await fsp.readFile(sourceAbs, 'utf8')
    } catch {
      sourceContent = null // added；或本体文件在扫描后被外部移走（极小 TOCTOU 窗口）
    }

    // unified diff：added 本体侧为空串；deleted 工作区侧为空串
    const oldStr = sourceContent ?? ''
    const newStr = wsContent ?? ''
    const patch = structuredPatch(`a/${change.path}`, `b/${change.path}`, oldStr, newStr, '', '', {
      context: 3,
    })
    const additions = patch.hunks.reduce(
      (n, h) => n + h.lines.filter((l) => l.startsWith('+')).length,
      0,
    )
    const deletions = patch.hunks.reduce(
      (n, h) => n + h.lines.filter((l) => l.startsWith('-')).length,
      0,
    )
    const diff = createTwoFilesPatch(`a/${change.path}`, `b/${change.path}`, oldStr, newStr, '', '')

    // 文件级校验：deleted 无工作区内容 → 视为通过；schemaKind null → 通过
    let valid = true
    let validationErrors: ConfigValidationError[] = []
    let schemaKind: string | null = routeSchemaKind(change.path, this.ctx)
    if (change.status !== 'deleted' && schemaKind && wsContent !== null) {
      const r = await this.config.validateFile(change.path, wsContent)
      valid = r.valid
      validationErrors = r.errors
      schemaKind = r.schemaKind
    } else if (change.status === 'deleted') {
      schemaKind = routeSchemaKind(change.path, this.ctx)
    }

    return {
      path: change.path,
      status: change.status,
      additions,
      deletions,
      diff,
      sourceContent,
      valid,
      schemaKind,
      validationErrors,
    }
  }

  // ---------------------------------------------------------------------------
  // 执行落盘
  // ---------------------------------------------------------------------------

  /**
   * 执行落盘（守卫顺序见类注释）。成功后刷新工作区基线 → changes 归零。
   */
  async execute(paths: string[]): Promise<ApplyExecutePayload> {
    if (this.busy) throw new WorkspaceError(409, BUSY_MSG)
    this.busy = true
    try {
      return await this.executeLocked(paths)
    } finally {
      this.busy = false
    }
  }

  private async executeLocked(paths: string[]): Promise<ApplyExecutePayload> {
    const begunAt = Date.now()

    // a. 活动工作区
    const { id: wsId, gameDir } = await this.workspace.requireActiveGameDir()

    // b. TOCTOU 复核：重算 changes，要求 paths 非空且全部命中
    const requested = this.normalizePaths(paths)
    const changes = await this.workspace.diffAgainstSource()
    const changeMap = new Map(changes.map((c) => [c.path, c]))
    const selected: WorkspaceChange[] = []
    for (const rel of requested) {
      const entry = changeMap.get(rel)
      if (!entry) throw new WorkspaceError(409, WS_CHANGED_MSG)
      selected.push(entry)
    }

    // c. 文件级校验（deleted 视为通过）
    const invalid: { path: string; validationErrors: ConfigValidationError[] }[] = []
    for (const entry of selected) {
      if (entry.status === 'deleted') continue
      const wsAbs = path.join(gameDir, entry.path)
      let content: string
      try {
        content = await fsp.readFile(wsAbs, 'utf8')
      } catch {
        throw new WorkspaceError(409, WS_CHANGED_MSG) // 计划后有文件被删
      }
      const r = await this.config.validateFile(entry.path, content)
      if (!r.valid) invalid.push({ path: entry.path, validationErrors: r.errors })
    }
    if (invalid.length > 0) {
      throw new ApplyDetailError(422, '存在未通过校验的文件', { invalid })
    }

    // d. 整体校验终门（S3 结论：文件级 schema 对 ecosystems 等跨文件约束无感；
    //    T1.5 起经 sidecar validateWhole，落盘校验终门语义不变）
    const whole = await sidecarCall(
      this.resolveSidecar().validateWhole({ gameJsonPath: path.join(gameDir, 'game.json') }),
    )
    if (!whole.ok) {
      throw new ApplyDetailError(422, '整体校验未通过', { message: whole.message })
    }

    // e. 备份 → 写回/删除 → 刷新基线
    const backupId = this.genBackupId()
    const backupRoot = path.join(this.backupsDir, backupId)
    const backupFilesDir = path.join(backupRoot, 'files')
    await fsp.mkdir(backupFilesDir, { recursive: true })

    const manifestFiles: BackupFileEntry[] = []
    const applied: ApplyExecutePayload['applied'] = []
    for (const entry of selected) {
      const action = await this.applyOne(gameDir, backupFilesDir, entry)
      manifestFiles.push({ path: entry.path, action })
      applied.push({ path: entry.path, status: entry.status })
    }

    const manifest = {
      backupId,
      createdAt: Date.now(),
      files: manifestFiles,
    }
    await fsp.writeFile(path.join(backupRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

    await this.workspace.refreshBaseManifest(wsId)

    return { backupId, applied, durationMs: Date.now() - begunAt }
  }

  /** 单文件落盘：先备份本体原内容，再写回/删除；返回 manifest action。 */
  private async applyOne(
    gameDir: string,
    backupFilesDir: string,
    entry: WorkspaceChange,
  ): Promise<BackupFileAction> {
    const sourceAbs = path.join(this.ctx.gameConfigsDir, entry.path)
    const sourceExists = fs.existsSync(sourceAbs)

    if (entry.status === 'modified' && !sourceExists) {
      // 备份窗口内本体文件被外部移走 → 拒绝执行（TOCTOU 兜底）
      throw new WorkspaceError(409, '工作区已变化，请重新获取落盘计划')
    }
    if (entry.status === 'deleted') {
      if (sourceExists) {
        await this.backupFile(sourceAbs, backupFilesDir, entry.path)
        await fsp.unlink(sourceAbs)
        await this.pruneEmptyDirs(path.dirname(sourceAbs), this.ctx.gameConfigsDir)
      }
      return 'deleted'
    }
    // modified / added：写回工作区内容（added 无本体原内容可备份）
    if (entry.status === 'modified') {
      await this.backupFile(sourceAbs, backupFilesDir, entry.path)
    }
    const wsAbs = path.join(gameDir, entry.path)
    await fsp.mkdir(path.dirname(sourceAbs), { recursive: true })
    await fsp.copyFile(wsAbs, sourceAbs)
    return entry.status === 'added' ? 'added' : 'overwritten'
  }

  // ---------------------------------------------------------------------------
  // 备份查询 / 回滚
  // ---------------------------------------------------------------------------

  /** 备份列表（createdAt 倒序；manifest 缺失/损坏的条目跳过）。 */
  async listBackups(): Promise<BackupListPayload> {
    await fsp.mkdir(this.backupsDir, { recursive: true })
    const entries = await fsp.readdir(this.backupsDir, { withFileTypes: true })
    const items: BackupInfo[] = []
    for (const e of entries) {
      if (!e.isDirectory() || !BACKUP_ID_RE.test(e.name)) continue
      try {
        const raw = await fsp.readFile(path.join(this.backupsDir, e.name, 'manifest.json'), 'utf8')
        const m = JSON.parse(raw) as BackupInfo
        if (m && typeof m.createdAt === 'number' && Array.isArray(m.files)) {
          items.push({ backupId: e.name, createdAt: m.createdAt, files: m.files })
        }
      } catch {
        // manifest 缺失/损坏 → 容错跳过
      }
    }
    items.sort((a, b) => b.createdAt - a.createdAt)
    return { items }
  }

  /** 回滚 = 完整逆操作（互斥与 execute 共用）。 */
  async rollback(backupId: string): Promise<RollbackPayload> {
    if (this.busy) throw new WorkspaceError(409, BUSY_MSG)
    this.busy = true
    try {
      return await this.rollbackLocked(backupId)
    } finally {
      this.busy = false
    }
  }

  private async rollbackLocked(backupId: string): Promise<RollbackPayload> {
    if (!BACKUP_ID_RE.test(backupId)) {
      throw new WorkspaceError(404, `备份不存在：${backupId}`)
    }
    const backupRoot = path.join(this.backupsDir, backupId)
    const manifestPath = path.join(backupRoot, 'manifest.json')
    if (!fs.existsSync(manifestPath)) {
      throw new WorkspaceError(404, `备份不存在：${backupId}`)
    }
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as BackupInfo
    const backupFilesDir = path.join(backupRoot, 'files')
    const gameConfigsDir = this.ctx.gameConfigsDir

    const restored: BackupFileEntry[] = []
    for (const entry of manifest.files) {
      // 备份内路径同样要防穿越（manifest 可能被外部篡改）
      this.guardWithin(backupFilesDir, entry.path)
      const sourceAbs = path.join(gameConfigsDir, entry.path)

      if (entry.action === 'added') {
        // 逆操作：落盘时新增到本体的文件 → 删除
        if (fs.existsSync(sourceAbs)) {
          await fsp.unlink(sourceAbs)
          await this.pruneEmptyDirs(path.dirname(sourceAbs), gameConfigsDir)
        }
      } else {
        // overwritten / deleted：把备份的原内容写回本体
        const backupAbs = path.join(backupFilesDir, entry.path)
        await fsp.mkdir(path.dirname(sourceAbs), { recursive: true })
        await fsp.copyFile(backupAbs, sourceAbs)
      }
      restored.push({ path: entry.path, action: entry.action })
    }
    return { restored }
  }

  // ---------------------------------------------------------------------------
  // 内部工具
  // ---------------------------------------------------------------------------

  private normalizePaths(paths: unknown): string[] {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new WorkspaceError(400, 'paths 必须为非空字符串数组')
    }
    const out: string[] = []
    for (const p of paths) {
      if (typeof p !== 'string' || !p.trim()) {
        throw new WorkspaceError(400, 'paths 必须为非空字符串数组')
      }
      // 仅接受本体 game/ 下相对路径（穿越防护）
      this.guardWithin(this.ctx.gameConfigsDir, p)
      out.push(path.normalize(p).split(path.sep).join('/'))
    }
    return [...new Set(out)]
  }

  /** rel 必须能落在 rootDir 内（目录穿越防护）。 */
  private guardWithin(rootDir: string, rel: string): void {
    const abs = path.resolve(rootDir, rel)
    if (abs === rootDir || !abs.startsWith(rootDir + path.sep)) {
      throw new WorkspaceError(400, `路径越界（必须位于 ${path.basename(rootDir)} 目录内）: ${rel}`)
    }
  }

  /** 备份单个本体文件（保持相对路径结构）。 */
  private async backupFile(sourceAbs: string, backupFilesDir: string, rel: string): Promise<void> {
    const dest = path.join(backupFilesDir, rel)
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.copyFile(sourceAbs, dest)
  }

  /** 删除文件后尽力清理空父目录（止步于 game 根）。 */
  private async pruneEmptyDirs(dir: string, stopAt: string): Promise<void> {
    let cur = dir
    while (cur.startsWith(stopAt + path.sep) && cur !== stopAt) {
      try {
        const rest = await fsp.readdir(cur)
        if (rest.length > 0) return
        await fsp.rmdir(cur)
      } catch {
        return
      }
      cur = path.dirname(cur)
    }
  }

  private genBackupId(): string {
    const d = new Date()
    const pad = (n: number, w = 2) => String(n).padStart(w, '0')
    const stamp =
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
      `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
    return `${stamp}-${rand}`
  }
}

/**
 * apply 服务单例（compat 壳，T2.4）。
 *
 * 绑定 defaultGameContext（≡ forGame('gst') 语义）+ workspaceService/configService
 * 单例；backupsRoot 缺省 → per-game 备份目录为 `<repoRoot>/server/backups/gst`
 * （存量数据仍在旧扁平位置，目录迁移是 T2.6）。路由层改接 servicesFor 是
 * T2.7 的事，本单例保证过渡期行为连续。
 */
export const applyService = new ApplyService({
  context: defaultGameContext,
  workspace: workspaceService,
  config: configService,
})
