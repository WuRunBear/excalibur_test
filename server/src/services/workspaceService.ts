/**
 * 工作区服务（S2-A）。
 *
 * 存储（server/workspaces/ 已被根 .gitignore 覆盖；T2.4 起**按游戏命名空间**）：
 * - <workspacesDir>/<gameId>/<id>/game/**    本体 game/ 的全量镜像（fs.cp 递归复制）
 * - <workspacesDir>/<gameId>/<id>/.base-manifest.json  基线清单 { files: {relPath: sha256}, fingerprint }
 * - <workspacesDir>/<gameId>/<id>/meta.json  { id, name, createdAt }
 * - <workspacesDir>/<gameId>/.active-workspace.json    持久化活动工作区（tsx watch 重启不丢）
 *
 * 活动工作区文件 v2 格式（T2.4/T2.6）：{ version: 2, gameId, id }。
 * **只认 v2**：读到 v1（{ id }）→ fail-fast 报错并提示运行目录迁移脚本
 * （scripts/migrate-namespaces.mjs，T2.6）——故意不做静默兼容（规格 T2.6 第 5 步）。
 *
 * fingerprint = 对排序后 "relPath:hash\n" 串的 sha256 前 16 位（relPath 相对 game/，
 * '/' 分隔）。id 用 crypto.randomUUID()。
 *
 * T2.4 per-game 实例化：构造器收 context（contextHolder 可选，services/index.ts
 * 的容器用它做 context 热更新）；workspacesRoot 可注入（测试用 /tmp，缺省
 * config.workspacesDir），per-game 目录 = <workspacesRoot>/<gameId>。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { workspacesDir as defaultWorkspacesRoot } from '../config.js'
import { defaultGameContext, type GameContext } from '../gameContext.js'
import type { ContextHolder } from './index.js'
import type { WorkspaceChange, WorkspaceMeta } from '../types.js'

/**
 * GameContext | ContextHolder → ContextHolder（各服务构造器共用的规整助手）。
 * 容器（services/index.ts）传 holder 实现 context 热更新；单例/直构传裸 context。
 */
export function toHolder(context: GameContext | ContextHolder): ContextHolder {
  return isHolder(context) ? context : { current: context }
}

function isHolder(value: GameContext | ContextHolder): value is ContextHolder {
  return typeof value === 'object' && value !== null && 'current' in value
}

/** 服务层可预期的错误（REST 层映射为对应 HTTP 状态码；可选 detail 随响应透出）。 */
export class WorkspaceError extends Error {
  readonly status: number
  readonly detail?: unknown
  constructor(status: number, message: string, detail?: unknown) {
    super(message)
    this.name = 'WorkspaceError'
    this.status = status
    this.detail = detail
  }
}

/** 工作区目录内的固定文件名。 */
const BASE_MANIFEST_FILE = '.base-manifest.json'
const META_FILE = 'meta.json'
const ACTIVE_FILE = '.active-workspace.json'

/** 活动工作区文件 v2 格式（T2.4；迁移脚本 T2.6 负责把 v1 升级到这里）。 */
interface ActiveWorkspaceFileV2 {
  version: 2
  gameId: string
  id: string
}

interface BaseManifest {
  files: Record<string, string>
  fingerprint: string
}

interface MetaFile {
  id: string
  name: string
  createdAt: number
}

function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

async function sha256File(filePath: string): Promise<string> {
  const content = await fsp.readFile(filePath)
  return crypto.createHash('sha256').update(content).digest('hex')
}

/** 构造参数（T2.4 per-game 实例化）。 */
export interface WorkspaceServiceOptions {
  /** 游戏上下文（或 services/index.ts 容器的 contextHolder，支持热更新）。 */
  context: GameContext | ContextHolder
  /** 工作区根目录（per-game 目录 = <root>/<gameId>）；缺省 config.workspacesDir。 */
  workspacesRoot?: string
}

export class WorkspaceService {
  private readonly holder: ContextHolder
  /** per-game 工作区目录（<workspacesRoot>/<gameId>）。 */
  private readonly workspacesDir: string
  private readonly workspacesRoot: string

  constructor(options: WorkspaceServiceOptions) {
    this.holder = toHolder(options.context)
    this.workspacesRoot = options.workspacesRoot ?? defaultWorkspacesRoot
    this.workspacesDir = path.join(this.workspacesRoot, this.ctx.gameId)
  }

  /** 当前上下文（容器热更新后自动生效）。 */
  private get ctx(): GameContext {
    return this.holder.current
  }

  // ------------------------------------------------------------------
  // 查询
  // ------------------------------------------------------------------

  /** 列出全部工作区 + 活动工作区 id。 */
  async list(): Promise<{ activeId: string | null; items: WorkspaceMeta[] }> {
    await this.ensureRoot()
    const activeId = await this.readActiveId()
    const entries = await fsp.readdir(this.workspacesDir, { withFileTypes: true })
    const items: WorkspaceMeta[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      try {
        items.push(await this.getMeta(entry.name))
      } catch {
        // 半成品/损坏目录：跳过而非让整个列表 500。
      }
    }
    items.sort((a, b) => a.createdAt - b.createdAt)
    return { activeId, items }
  }

  /** 单个工作区 meta（含变更数统计）；不存在抛 404。 */
  async getMeta(id: string): Promise<WorkspaceMeta> {
    const wsDir = this.mustExist(id)
    const meta = await this.readMeta(wsDir)
    const changes = await this.diffAgainstBase(wsDir)
    return {
      id: meta.id,
      name: meta.name,
      createdAt: meta.createdAt,
      baseFingerprint: await this.readFingerprint(wsDir),
      changedFiles: changes.length,
    }
  }

  /** 当前镜像 vs 基线清单的文件级变更。 */
  async changes(id: string): Promise<{ files: WorkspaceChange[] }> {
    const wsDir = this.mustExist(id)
    return { files: await this.diffAgainstBase(wsDir) }
  }

  // ------------------------------------------------------------------
  // S3-A：目录清单描述 / vs 本体对比 / 预览注入材料
  // ------------------------------------------------------------------

  /**
   * 描述任意目录的清单级快照（fingerprint 与工作区基线同算法：
   * 排序 "relPath:sha256\n" 串的 sha256 前 16 位）。
   * 供 config-context 的"本体 game/ 当前清单"与"工作区当前清单"使用。
   */
  async describeDir(rootDir: string): Promise<{
    fingerprint: string
    fileCount: number
    files: Record<string, string>
  }> {
    if (!fs.existsSync(rootDir)) {
      throw new WorkspaceError(404, `目录不存在：${rootDir}`)
    }
    const files = await this.scanHashes(rootDir)
    return { fingerprint: fingerprintOf(files), fileCount: Object.keys(files).length, files }
  }

  /** 活动工作区（当前镜像）vs 本体 game/ 的逐文件对比（S4 落盘 diff 的清单级基础）。 */
  async diffAgainstSource(): Promise<WorkspaceChange[]> {
    const source = await this.describeDir(this.ctx.gameConfigsDir)
    const activeId = await this.getActiveId()
    if (!activeId) return []
    try {
      const wsDir = this.mustExist(activeId)
      const gameDir = path.join(wsDir, 'game')
      const current = fs.existsSync(gameDir) ? await this.scanHashes(gameDir) : {}
      return diffMaps(source.files, current)
    } catch {
      // 活动工作区已被删：无差异可比。
      return []
    }
  }

  /** 活动工作区 game/ 的清单摘要；无活动工作区 / 已被删 / 镜像缺 game 目录 → null。 */
  async describeActiveWorkspaceGame(): Promise<{
    id: string
    name: string
    fingerprint: string
    fileCount: number
  } | null> {
    const id = await this.getActiveId()
    if (!id) return null
    let wsDir: string
    try {
      wsDir = this.mustExist(id)
    } catch {
      return null
    }
    const gameDir = path.join(wsDir, 'game')
    if (!fs.existsSync(gameDir)) return null
    const desc = await this.describeDir(gameDir)
    const meta = await this.readMeta(wsDir)
    return { id, name: meta.name, fingerprint: desc.fingerprint, fileCount: desc.fileCount }
  }

  /**
   * S4-A：落盘后把基线清单刷新为当前工作区状态（/api/workspaces/:id/changes 归零）。
   * 返回新指纹（应与活动工作区 game/ 清单一致）。
   */
  async refreshBaseManifest(id: string): Promise<string> {
    const wsDir = this.mustExist(id)
    const gameDir = path.join(wsDir, 'game')
    const files = await this.scanHashes(gameDir)
    const manifest: BaseManifest = { files, fingerprint: fingerprintOf(files) }
    await fsp.writeFile(path.join(wsDir, BASE_MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8')
    return manifest.fingerprint
  }

  // ------------------------------------------------------------------
  // 生命周期
  // ------------------------------------------------------------------

  /** 从本体 game/ 全量镜像新建工作区，并自动设为活动。 */
  async create(name: string): Promise<WorkspaceMeta> {
    const trimmed = name?.trim()
    if (!trimmed) throw new WorkspaceError(400, 'name 不能为空')
    if (trimmed.length > 64) throw new WorkspaceError(400, 'name 过长（≤64 字符）')

    await this.ensureRoot()
    const gameConfigsDir = this.ctx.gameConfigsDir
    if (!fs.existsSync(gameConfigsDir)) {
      throw new WorkspaceError(500, `本体配置目录不存在：${gameConfigsDir}`)
    }

    const id = crypto.randomUUID()
    const wsDir = path.join(this.workspacesDir, id)
    const gameDir = path.join(wsDir, 'game')
    await fsp.mkdir(wsDir, { recursive: true })
    await fsp.cp(gameConfigsDir, gameDir, { recursive: true })

    const files = await this.scanHashes(gameDir)
    const manifest: BaseManifest = { files, fingerprint: fingerprintOf(files) }
    await fsp.writeFile(path.join(wsDir, BASE_MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8')

    const meta: MetaFile = { id, name: trimmed, createdAt: Date.now() }
    await fsp.writeFile(path.join(wsDir, META_FILE), JSON.stringify(meta, null, 2), 'utf8')

    await this.setActiveId(id)
    return {
      id,
      name: meta.name,
      createdAt: meta.createdAt,
      baseFingerprint: manifest.fingerprint,
      changedFiles: 0,
    }
  }

  /** 设为活动工作区；不存在抛 404。 */
  async activate(id: string): Promise<WorkspaceMeta> {
    await this.mustExist(id)
    await this.setActiveId(id)
    return this.getMeta(id)
  }

  /** 重命名。 */
  async rename(id: string, name: string): Promise<WorkspaceMeta> {
    const trimmed = name?.trim()
    if (!trimmed) throw new WorkspaceError(400, 'name 不能为空')
    if (trimmed.length > 64) throw new WorkspaceError(400, 'name 过长（≤64 字符）')
    const wsDir = this.mustExist(id)
    const meta = await this.readMeta(wsDir)
    meta.name = trimmed
    await fsp.writeFile(path.join(wsDir, META_FILE), JSON.stringify(meta, null, 2), 'utf8')
    return this.getMeta(id)
  }

  /** 删除工作区（连带目录）；删的是活动工作区则 activeId 置 null。 */
  async remove(id: string): Promise<{ id: string }> {
    const wsDir = this.mustExist(id)
    await fsp.rm(wsDir, { recursive: true, force: true })
    if ((await this.readActiveId()) === id) {
      await this.setActiveId(null)
    }
    return { id }
  }

  // ------------------------------------------------------------------
  // 活动工作区（供 configService 使用）
  // ------------------------------------------------------------------

  /** 当前活动工作区 id（无则 null）。 */
  async getActiveId(): Promise<string | null> {
    await this.ensureRoot()
    return this.readActiveId()
  }

  /** 活动工作区 game 目录绝对路径；无活动工作区抛错（REST → 400 "未设置活动工作区"）。 */
  async requireActiveGameDir(): Promise<{ id: string; gameDir: string }> {
    const id = await this.getActiveId()
    if (!id) throw new WorkspaceError(400, '未设置活动工作区')
    const wsDir = this.mustExist(id)
    return { id, gameDir: path.join(wsDir, 'game') }
  }

  // ------------------------------------------------------------------
  // 内部实现
  // ------------------------------------------------------------------

  private async ensureRoot(): Promise<void> {
    await fsp.mkdir(this.workspacesDir, { recursive: true })
  }

  private wsPath(id: string): string {
    // id 只能是路径安全段（uuid），防止拼路径注入。
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new WorkspaceError(400, `非法工作区 id：${id}`)
    }
    return path.join(this.workspacesDir, id)
  }

  private mustExist(id: string): string {
    const wsDir = this.wsPath(id)
    if (!fs.existsSync(path.join(wsDir, META_FILE))) {
      throw new WorkspaceError(404, `工作区不存在：${id}`)
    }
    return wsDir
  }

  /**
   * 读活动工作区 id（v2 格式）。
   * - 文件不存在 / JSON 损坏 → null（与改前容错语义一致）；
   * - **v1 旧格式（无 version:2）或 gameId 不匹配 → 抛错并提示跑迁移脚本**
   *   （规格 T2.6 第 5 步：故意 fail-fast，不做静默兼容；REST → 500）。
   */
  private async readActiveId(): Promise<string | null> {
    let raw: string
    try {
      raw = await fsp.readFile(path.join(this.workspacesDir, ACTIVE_FILE), 'utf8')
    } catch {
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null // 损坏文件：维持改前的容错（视为无活动工作区）
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 2
    ) {
      throw new WorkspaceError(
        500,
        '活动工作区文件为 v1 旧格式（缺 version:2）——请先运行目录迁移脚本 ' +
          'scripts/migrate-namespaces.mjs 将存量工作区迁入 per-game 命名空间（T2.6），新版服务只认 v2 格式',
      )
    }
    const v2 = parsed as Partial<ActiveWorkspaceFileV2>
    if (v2.gameId !== this.ctx.gameId || typeof v2.id !== 'string') {
      throw new WorkspaceError(
        500,
        `活动工作区文件 gameId 不匹配（文件 ${String(v2.gameId)} ≠ 当前 ${this.ctx.gameId}）或 id 字段缺失——请检查 ${ACTIVE_FILE}`,
      )
    }
    return v2.id === '' ? null : v2.id
  }

  /** 写活动工作区（v2 格式：{ version: 2, gameId, id }）。 */
  private async setActiveId(id: string | null): Promise<void> {
    await this.ensureRoot()
    const file: ActiveWorkspaceFileV2 = { version: 2, gameId: this.ctx.gameId, id: id ?? '' }
    await fsp.writeFile(path.join(this.workspacesDir, ACTIVE_FILE), JSON.stringify(file), 'utf8')
  }

  private async readMeta(wsDir: string): Promise<MetaFile> {
    const raw = await fsp.readFile(path.join(wsDir, META_FILE), 'utf8')
    return JSON.parse(raw) as MetaFile
  }

  private async readFingerprint(wsDir: string): Promise<string> {
    try {
      const raw = await fsp.readFile(path.join(wsDir, BASE_MANIFEST_FILE), 'utf8')
      return (JSON.parse(raw) as BaseManifest).fingerprint
    } catch {
      return ''
    }
  }

  /** 递归扫描目录，返回 { 相对路径('/' 分隔): sha256 }（只含普通文件）。 */
  private async scanHashes(rootDir: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {}
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(abs)
        } else if (entry.isFile()) {
          files[this.toRelPath(rootDir, abs)] = await sha256File(abs)
        }
      }
    }
    await walk(rootDir)
    return files
  }

  private toRelPath(rootDir: string, abs: string): string {
    return path.relative(rootDir, abs).split(path.sep).join('/')
  }

  /** 当前 game/ 目录与基线清单对比：added / modified / deleted（路径按字典序）。 */
  private async diffAgainstBase(wsDir: string): Promise<WorkspaceChange[]> {
    const gameDir = path.join(wsDir, 'game')
    let manifest: BaseManifest
    try {
      const raw = await fsp.readFile(path.join(wsDir, BASE_MANIFEST_FILE), 'utf8')
      manifest = JSON.parse(raw) as BaseManifest
    } catch {
      return [] // 无基线清单（半成品）：视为无基线可比
    }
    const current = fs.existsSync(gameDir) ? await this.scanHashes(gameDir) : {}
    return diffMaps(manifest.files, current)
  }

  /**
   * 预览实例的 env 注入材料（S3-A）：活动工作区的 game.json 绝对路径与
   * .preview-saves 目录（自动创建）。无活动工作区或镜像缺 game.json → null
   * （调用方回退为仅注入 PORT 并记日志）。
   */
  async getPreviewInjection(): Promise<{ configPath: string; saveDir: string } | null> {
    const id = await this.getActiveId()
    if (!id) return null
    let wsDir: string
    try {
      wsDir = this.mustExist(id)
    } catch {
      return null
    }
    const configPath = path.join(wsDir, 'game', 'game.json')
    if (!fs.existsSync(configPath)) return null
    const saveDir = path.join(wsDir, '.preview-saves')
    await fsp.mkdir(saveDir, { recursive: true })
    return { configPath, saveDir }
  }

  /** S6-A：活动工作区的 .preview-saves 目录（不自动创建）；无活动工作区 → 400。 */
  async getPreviewSavesDir(): Promise<string> {
    const id = await this.getActiveId()
    if (!id) throw new WorkspaceError(400, '未设置活动工作区')
    const wsDir = this.mustExist(id)
    return path.join(wsDir, '.preview-saves')
  }
}

/** fingerprint：排序后 "relPath:hash\n" 串的 sha256 前 16 位。 */
function fingerprintOf(files: Record<string, string>): string {
  const canonical = Object.keys(files)
    .sort()
    .map((rel) => `${rel}:${files[rel]}\n`)
    .join('')
  return sha256Hex(canonical).slice(0, 16)
}

/** 通用清单对比：base 为基准（本体/基线），current 为当前；added/modified/deleted 按路径字典序。 */
function diffMaps(base: Record<string, string>, current: Record<string, string>): WorkspaceChange[] {
  const changes: WorkspaceChange[] = []
  for (const [rel, hash] of Object.entries(current)) {
    const baseHash = base[rel]
    if (baseHash === undefined) changes.push({ path: rel, status: 'added' })
    else if (baseHash !== hash) changes.push({ path: rel, status: 'modified' })
  }
  for (const rel of Object.keys(base)) {
    if (current[rel] === undefined) changes.push({ path: rel, status: 'deleted' })
  }
  changes.sort((a, b) => a.path.localeCompare(b.path))
  return changes
}

/**
 * 工作区服务单例（compat 壳，T2.4）。
 *
 * 绑定 defaultGameContext（≡ forGame('gst') 的语义等价物，不依赖 registry 播种，
 * 保证模块加载零风险）；workspacesRoot 缺省 → per-game 目录为
 * `<repoRoot>/server/workspaces/gst`（存量数据仍在旧扁平位置，目录迁移是 T2.6）。
 * 路由层改接 servicesFor(gameId) 是 T2.7 的事，本单例保证过渡期行为连续。
 */
export const workspaceService = new WorkspaceService({ context: defaultGameContext })
