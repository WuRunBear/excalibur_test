/**
 * 存档管理服务（S6-A）。
 *
 * scope：'official'（GAME_ROOT/data/saves）| 'preview'（活动工作区 .preview-saves，
 * 无活动工作区 → 400 "未设置活动工作区"）。
 *
 * 活跃存档 saveId 从本体 game/rules/server.json 的 saveId 字段读取（缺省 'main'）。
 * summary 只对可解析且形如 WorldRecord（tick + maps + entities）的文件给出，
 * 其余容错为 null。文件名白名单：目录内 .json；所有路径经目录内规约（防穿越）。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { GAME_ROOT, gameConfigsDir } from '../config.js'
import { WorkspaceError, workspaceService } from './workspaceService.js'
import type {
  SaveDetailPayload,
  SaveEntry,
  SaveRestorePayload,
  SaveScope,
  SaveSummary,
  SavesPayload,
} from '../types.js'

/** 存档文件名白名单（防穿越/隐藏文件/非 json）。 */
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/

interface WorldRecordLike {
  id?: unknown
  savedAt?: unknown
  tick?: unknown
  timeOfDay?: unknown
  maps?: unknown
  entities?: unknown
}

function normalizeScope(input: unknown): SaveScope {
  if (input === undefined || input === null || input === '') return 'official'
  if (input === 'official' || input === 'preview') return input
  throw new WorkspaceError(400, `非法 scope "${String(input)}"（expected "official" | "preview"）`)
}

export class SaveService {
  /** 列出存档（.json 文件，summary 尽力解析）。 */
  async list(scopeInput: unknown): Promise<SavesPayload> {
    const scope = normalizeScope(scopeInput)
    const dir = await this.dirFor(scope)
    const saves: SaveEntry[] = []
    if (fs.existsSync(dir)) {
      const names = (await fsp.readdir(dir)).filter((n) => FILE_NAME_RE.test(n)).sort()
      for (const file of names) {
        const abs = path.join(dir, file)
        const st = await fsp.stat(abs)
        if (!st.isFile()) continue
        saves.push({
          file,
          saveId: file.replace(/\.json$/, ''),
          sizeBytes: st.size,
          mtime: st.mtimeMs,
          summary: await this.summarizeFile(abs),
        })
      }
    }
    return { scope, dir, saves }
  }

  /** 单文件详情：maps 键 + topKinds（按 count 排序前 10）。 */
  async detail(file: string, scopeInput: unknown): Promise<SaveDetailPayload> {
    const scope = normalizeScope(scopeInput)
    const dir = await this.dirFor(scope)
    const { abs } = this.resolveFile(dir, file)
    const summary = await this.summarizeFile(abs)
    if (!summary) {
      return { file, summary: null, maps: [], topKinds: [] }
    }
    const record = JSON.parse(await fsp.readFile(abs, 'utf8')) as WorldRecordLike
    const maps = Object.keys((record.maps ?? {}) as Record<string, unknown>).map((mapKey) => ({ mapKey }))
    const kindStats = summary.kindStats
    const topKinds = Object.entries(kindStats)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([kind, count]) => ({ kind, count }))
    return { file, summary, maps, topKinds }
  }

  /** 删除存档文件（白名单 + 存在性校验）。 */
  async remove(file: string, scopeInput: unknown): Promise<{ file: string }> {
    const scope = normalizeScope(scopeInput)
    const dir = await this.dirFor(scope)
    const { abs } = this.resolveFile(dir, file)
    if (!fs.existsSync(abs)) {
      throw new WorkspaceError(404, `存档不存在：${file}`)
    }
    await fsp.unlink(abs)
    return { file }
  }

  /** restore：把该文件内容复制为目录内 <saveId>.json（saveId 读本体 rules/server.json）。 */
  async restore(file: string, scopeInput: unknown): Promise<SaveRestorePayload> {
    const scope = normalizeScope(scopeInput)
    const dir = await this.dirFor(scope)
    const { abs } = this.resolveFile(dir, file)
    if (!fs.existsSync(abs)) {
      throw new WorkspaceError(404, `存档不存在：${file}`)
    }
    const saveId = await this.activeSaveId()
    const target = path.join(dir, `${saveId}.json`)
    // 读后写（同路径自恢复幂等，copyFile 自拷贝在部分平台会报错）
    const content = await fsp.readFile(abs)
    await fsp.writeFile(target, content)
    return { restoredTo: `${saveId}.json`, warnRestart: scope === 'official' }
  }

  /** download 传输材料（路由负责 attachment 头）。 */
  async readForDownload(file: string, scopeInput: unknown): Promise<{ filename: string; contentType: string; content: Buffer }> {
    const scope = normalizeScope(scopeInput)
    const dir = await this.dirFor(scope)
    const { abs } = this.resolveFile(dir, file)
    if (!fs.existsSync(abs)) {
      throw new WorkspaceError(404, `存档不存在：${file}`)
    }
    return {
      filename: path.basename(abs),
      contentType: 'application/json',
      content: await fsp.readFile(abs),
    }
  }

  // ---------------------------------------------------------------------------
  // 内部实现
  // ---------------------------------------------------------------------------

  private async dirFor(scope: SaveScope): Promise<string> {
    if (scope === 'official') {
      return path.join(GAME_ROOT, 'data', 'saves')
    }
    return workspaceService.getPreviewSavesDir()
  }

  /** 文件名白名单 + 目录内规约（防穿越）。返回规整后的文件名与绝对路径。 */
  private resolveFile(dir: string, file: string): { name: string; abs: string } {
    if (typeof file !== 'string' || !FILE_NAME_RE.test(file)) {
      throw new WorkspaceError(400, `非法存档文件名：${file}`)
    }
    const abs = path.resolve(dir, file)
    if (!abs.startsWith(path.resolve(dir) + path.sep)) {
      throw new WorkspaceError(400, `路径越界：${file}`)
    }
    return { name: file, abs }
  }

  /** 活跃存档 saveId：本体 rules/server.json 的 saveId（缺省 'main'，容错）。 */
  private async activeSaveId(): Promise<string> {
    try {
      const raw = await fsp.readFile(path.join(gameConfigsDir, 'rules', 'server.json'), 'utf8')
      const parsed = JSON.parse(raw) as { saveId?: unknown }
      if (typeof parsed.saveId === 'string' && /^[A-Za-z0-9_-]+$/.test(parsed.saveId)) {
        return parsed.saveId
      }
    } catch {
      // 缺文件/解析失败 → 缺省
    }
    return 'main'
  }

  /** 尽力解析 WorldRecord 摘要；JSON 失败 / 非存档结构 → null。 */
  private async summarizeFile(abs: string): Promise<SaveSummary | null> {
    let record: WorldRecordLike
    try {
      record = JSON.parse(await fsp.readFile(abs, 'utf8')) as WorldRecordLike
    } catch {
      return null
    }
    if (
      typeof record !== 'object' ||
      record === null ||
      typeof record.tick !== 'number' ||
      typeof record.maps !== 'object' ||
      record.maps === null ||
      !Array.isArray(record.entities)
    ) {
      return null
    }
    const entities = record.entities as { kind?: unknown }[]
    const kindStats: Record<string, number> = {}
    for (const e of entities) {
      if (e && typeof e.kind === 'string') {
        kindStats[e.kind] = (kindStats[e.kind] ?? 0) + 1
      }
    }
    const timeOfDay =
      record.timeOfDay && typeof record.timeOfDay === 'object'
        ? (record.timeOfDay as { hour?: unknown; phase?: unknown })
        : null
    return {
      tick: record.tick,
      savedAt: typeof record.savedAt === 'number' ? record.savedAt : 0,
      mapCount: Object.keys(record.maps as Record<string, unknown>).length,
      entityCount: entities.length,
      timeOfDay:
        timeOfDay && typeof timeOfDay.hour === 'number'
          ? { hour: timeOfDay.hour, phase: typeof timeOfDay.phase === 'number' ? timeOfDay.phase : 0 }
          : null,
      kindStats,
    }
  }
}

/** 存档服务单例。 */
export const saveService = new SaveService()
