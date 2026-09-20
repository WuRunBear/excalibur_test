/**
 * 工作区服务（S2-A）。
 *
 * 存储（server/workspaces/ 已被根 .gitignore 覆盖）：
 * - <workspacesDir>/<id>/game/**          本体 game/ 的全量镜像（fs.cp 递归复制）
 * - <workspacesDir>/<id>/.base-manifest.json  基线清单 { files: {relPath: sha256}, fingerprint }
 * - <workspacesDir>/<id>/meta.json        { id, name, createdAt }
 * - <workspacesDir>/.active-workspace.json 持久化活动工作区 { id }（tsx watch 重启不丢）
 *
 * fingerprint = 对排序后 "relPath:hash\n" 串的 sha256 前 16 位（relPath 相对 game/，
 * '/' 分隔）。id 用 crypto.randomUUID()。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { gameConfigsDir, workspacesDir } from '../config.js'
import type { WorkspaceChange, WorkspaceMeta } from '../types.js'

/** 服务层可预期的错误（REST 层映射为对应 HTTP 状态码）。 */
export class WorkspaceError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'WorkspaceError'
    this.status = status
  }
}

/** 工作区目录内的固定文件名。 */
const BASE_MANIFEST_FILE = '.base-manifest.json'
const META_FILE = 'meta.json'
const ACTIVE_FILE = '.active-workspace.json'

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

export class WorkspaceService {
  // ------------------------------------------------------------------
  // 查询
  // ------------------------------------------------------------------

  /** 列出全部工作区 + 活动工作区 id。 */
  async list(): Promise<{ activeId: string | null; items: WorkspaceMeta[] }> {
    await this.ensureRoot()
    const activeId = await this.readActiveId()
    const entries = await fsp.readdir(workspacesDir, { withFileTypes: true })
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
  // 生命周期
  // ------------------------------------------------------------------

  /** 从本体 game/ 全量镜像新建工作区，并自动设为活动。 */
  async create(name: string): Promise<WorkspaceMeta> {
    const trimmed = name?.trim()
    if (!trimmed) throw new WorkspaceError(400, 'name 不能为空')
    if (trimmed.length > 64) throw new WorkspaceError(400, 'name 过长（≤64 字符）')

    await this.ensureRoot()
    if (!fs.existsSync(gameConfigsDir)) {
      throw new WorkspaceError(500, `本体配置目录不存在：${gameConfigsDir}`)
    }

    const id = crypto.randomUUID()
    const wsDir = path.join(workspacesDir, id)
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
    await fsp.mkdir(workspacesDir, { recursive: true })
  }

  private wsPath(id: string): string {
    // id 只能是路径安全段（uuid），防止拼路径注入。
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new WorkspaceError(400, `非法工作区 id：${id}`)
    }
    return path.join(workspacesDir, id)
  }

  private mustExist(id: string): string {
    const wsDir = this.wsPath(id)
    if (!fs.existsSync(path.join(wsDir, META_FILE))) {
      throw new WorkspaceError(404, `工作区不存在：${id}`)
    }
    return wsDir
  }

  private async readActiveId(): Promise<string | null> {
    try {
      const raw = await fsp.readFile(path.join(workspacesDir, ACTIVE_FILE), 'utf8')
      const parsed = JSON.parse(raw) as { id?: string | null }
      return typeof parsed.id === 'string' ? parsed.id : null
    } catch {
      return null
    }
  }

  private async setActiveId(id: string | null): Promise<void> {
    await this.ensureRoot()
    await fsp.writeFile(path.join(workspacesDir, ACTIVE_FILE), JSON.stringify({ id }), 'utf8')
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

    const changes: WorkspaceChange[] = []
    for (const [rel, hash] of Object.entries(current)) {
      const base = manifest.files[rel]
      if (base === undefined) changes.push({ path: rel, status: 'added' })
      else if (base !== hash) changes.push({ path: rel, status: 'modified' })
    }
    for (const rel of Object.keys(manifest.files)) {
      if (current[rel] === undefined) changes.push({ path: rel, status: 'deleted' })
    }
    changes.sort((a, b) => a.path.localeCompare(b.path))
    return changes
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

/** 工作区服务单例。 */
export const workspaceService = new WorkspaceService()
