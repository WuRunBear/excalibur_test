/**
 * 配置读写与校验服务（S2-A）。
 *
 * - 全部操作作用于活动工作区的 game/ 镜像（无活动工作区 → "未设置活动工作区"）。
 * - schema 一律经 gameBridge 引用（services 禁止直接 import framework）。
 * - schema 路由表（relPath → schemaKind，kind=规则名时直接用文件名干）：
 *     game.json                 → GameDefinition
 *     entities/*.json           → Archetype
 *     maps/registry.json        → MapRegistry
 *     rules/{combat,needs,crafting,daynight,server}.json → 对应规则名
 *     其余                      → null（不校验，PUT 视为通过）
 *   形态适配说明（S2-A 探针实测）：本体 entities/*.json 每文件为**单个 Archetype
 *   对象**（loadArchetypesFiles 逐文件 ArchetypeSchema.parse(raw)），wolf.json 直接
 *   safeParse 通过，无需数组/包装层适配；maps/registry.json 顶层 {maps:{...}} 与
 *   MapRegistrySchema 直接匹配。
 * - path 解析做目录穿越防护：resolve 后必须落在工作区 game 目录内。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import {
  ArchetypeSchema,
  CombatRuleSchema,
  CraftingRuleSchema,
  DayNightRuleSchema,
  GameDefinitionSchema,
  MapRegistrySchema,
  NeedsRuleSchema,
  ServerRuleSchema,
  validateWholeConfig,
} from '../../gameBridge/index.js'
import { WorkspaceError, workspaceService } from './workspaceService.js'
import type { ConfigTreeNode, ConfigValidationError, WorkspaceChange } from '../types.js'

/**
 * schema 最小结构接口（safeParse 形状）。
 *
 * 不 import zod 的 ZodType：本体 schema 与 server 依赖的 zod 可能是不同实例
 * （pnpm 双仓），类类型不兼容；此处只依赖"有 safeParse"这一结构事实。
 */
interface SafeParseLike {
  safeParse(data: unknown):
    | { success: true; data: unknown }
    | { success: false; error: { issues: readonly { path: PropertyKey[]; message: string }[] } }
}

/** 已登记 schema 的路由表（其他路径 schemaKind=null 不校验）。 */
const SCHEMA_TABLE: Record<string, SafeParseLike> = {
  GameDefinition: GameDefinitionSchema,
  Archetype: ArchetypeSchema,
  MapRegistry: MapRegistrySchema,
  combat: CombatRuleSchema,
  needs: NeedsRuleSchema,
  crafting: CraftingRuleSchema,
  daynight: DayNightRuleSchema,
  server: ServerRuleSchema,
}

/** relPath（'/' 分隔，相对工作区 game/）→ schemaKind；不在路由表内 → null。 */
export function routeSchemaKind(relPath: string): string | null {
  const norm = relPath.split(path.sep).join('/')
  if (norm === 'game.json') return 'GameDefinition'
  if (/^entities\/[^/]+\.json$/.test(norm)) return 'Archetype'
  if (norm === 'maps/registry.json') return 'MapRegistry'
  const rule = /^rules\/(combat|needs|crafting|daynight|server)\.json$/.exec(norm)
  if (rule) return rule[1]
  return null
}

/** 校验失败错误（REST 层映射 422，detail 携带 errors）。 */
export class ValidationFailedError extends Error {
  readonly errors: ConfigValidationError[]
  constructor(errors: ConfigValidationError[]) {
    super('校验失败')
    this.name = 'ValidationFailedError'
    this.errors = errors
  }
}

/** 统一路径规整（统一 '/' 分隔、去掉多余 './'），供 tree/file 共用。 */
function normalizeRel(input: string): string {
  return path.normalize(input).split(path.sep).join('/').replace(/^\.\//, '')
}

/**
 * 目录穿越防护：resolve 后必须严格落在 gameDir 内。
 * 返回绝对路径；越界抛 400。
 */
function resolveWithin(gameDir: string, relInput: string): string {
  const abs = path.resolve(gameDir, relInput)
  if (abs !== gameDir && !abs.startsWith(gameDir + path.sep)) {
    throw new WorkspaceError(400, `路径越界（必须位于工作区 game 目录内）: ${relInput}`)
  }
  return abs
}

export class ConfigService {
  // ------------------------------------------------------------------
  // 树 / 读
  // ------------------------------------------------------------------

  /** 活动工作区 game/ 的配置文件树（目录在前、同级字典序）。 */
  async tree(): Promise<{ tree: ConfigTreeNode }> {
    const { gameDir } = await workspaceService.requireActiveGameDir()
    if (!fs.existsSync(gameDir)) {
      throw new WorkspaceError(404, '活动工作区缺少 game 目录（镜像损坏）')
    }
    return {
      tree: {
        name: 'game',
        path: '',
        type: 'dir',
        children: await this.buildChildren(gameDir, ''),
      },
    }
  }

  /** 读文件原文 + schemaKind；不存在抛 404。 */
  async readFile(relInput: string): Promise<{ path: string; content: string; schemaKind: string | null }> {
    const rel = normalizeRel(this.requirePath(relInput))
    const { gameDir } = await workspaceService.requireActiveGameDir()
    const abs = resolveWithin(gameDir, rel)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new WorkspaceError(404, `文件不存在：${rel}`)
    }
    return {
      path: rel,
      content: await fsp.readFile(abs, 'utf8'),
      schemaKind: routeSchemaKind(rel),
    }
  }

  // ------------------------------------------------------------------
  // 写 / 校验
  // ------------------------------------------------------------------

  /**
   * 写文件（PUT）：.json 先语法解析（错误带行号提示），再按路由表 schema 校验，
   * 通过后写盘（保留用户原始格式串）。允许新建文件（父目录自动创建）。
   */
  async writeFile(relInput: string, content: string): Promise<{ path: string; valid: true }> {
    if (typeof content !== 'string') {
      throw new WorkspaceError(400, 'content 必须为字符串')
    }
    const rel = normalizeRel(this.requirePath(relInput))
    const { gameDir } = await workspaceService.requireActiveGameDir()
    const abs = resolveWithin(gameDir, rel)
    if (abs === gameDir) {
      throw new WorkspaceError(400, '路径必须指向文件而非目录')
    }

    if (rel.endsWith('.json')) {
      // 1) 语法校验（错误消息带行号提示，尽力解析 Node 的 (line X column Y)）
      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch (err) {
        throw new WorkspaceError(400, `JSON 语法错误：${syntaxMessage(err as Error, content)}`)
      }
      // 2) schema 校验（路由表未命中的文件视为通过）
      const kind = routeSchemaKind(rel)
      if (kind) {
        const schema = SCHEMA_TABLE[kind]
        const result = schema.safeParse(parsed)
        if (!result.success) {
          throw new ValidationFailedError(
            this.mapZodIssues(result.error.issues, content),
          )
        }
      }
    }

    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, content, 'utf8')
    return { path: rel, valid: true }
  }

  /** 单文件校验（不写盘）。 */
  async validateFile(
    relInput: string,
    content: string,
  ): Promise<{ schemaKind: string | null; valid: boolean; errors: ConfigValidationError[] }> {
    if (typeof content !== 'string') {
      throw new WorkspaceError(400, 'content 必须为字符串')
    }
    const rel = normalizeRel(this.requirePath(relInput))
    const kind = routeSchemaKind(rel)
    if (!kind) return { schemaKind: null, valid: true, errors: [] }

    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch (err) {
      return {
        schemaKind: kind,
        valid: false,
        errors: [
          { jsonPath: '$', message: `JSON 语法错误：${syntaxMessage(err as Error, content)}` },
        ],
      }
    }
    const result = SCHEMA_TABLE[kind].safeParse(parsed)
    if (result.success) return { schemaKind: kind, valid: true, errors: [] }
    return {
      schemaKind: kind,
      valid: false,
      errors: this.mapZodIssues(result.error.issues, content),
    }
  }

  /** 整体校验（Spike-2 核心函数，经 gameBridge）：活动工作区 game.json 绝对路径。 */
  async validateAll(): Promise<{ valid: boolean; message: string }> {
    const { gameDir } = await workspaceService.requireActiveGameDir()
    const result = validateWholeConfig(path.join(gameDir, 'game.json'))
    return { valid: result.ok, message: result.message }
  }

  // ------------------------------------------------------------------
  // 内部实现
  // ------------------------------------------------------------------

  private requirePath(relInput: unknown): string {
    if (typeof relInput !== 'string' || !relInput.trim()) {
      throw new WorkspaceError(400, 'path 必须为非空字符串')
    }
    return relInput
  }

  /** 递归构树：目录在前、同级按 name 字典序；返回指定目录的 children 列表。 */
  private async buildChildren(rootDir: string, relPrefix: string): Promise<ConfigTreeNode[]> {
    const entries = await fsp.readdir(path.join(rootDir, relPrefix), { withFileTypes: true })
    const dirs: ConfigTreeNode[] = []
    const files: ConfigTreeNode[] = []
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        dirs.push({
          name: entry.name,
          path: rel,
          type: 'dir',
          children: await this.buildChildren(rootDir, rel),
        })
      } else if (entry.isFile()) {
        files.push({ name: entry.name, path: rel, type: 'file' })
      }
    }
    const byName = (a: ConfigTreeNode, b: ConfigTreeNode) => a.name.localeCompare(b.name)
    return [...dirs.sort(byName), ...files.sort(byName)]
  }

  /**
   * zod issues → ConfigValidationError[]。
   * jsonPath：属性用 "." 连接、数组下标用 "[i]"（如 components[0].kind）。
   * line：取 path 最深的字符串 key，在原文逐行扫描首个 `"key"` 匹配行（启发式，
   * 尽力而为；找不到省略）。
   */
  private mapZodIssues(issues: readonly { path: PropertyKey[]; message: string }[], content: string): ConfigValidationError[] {
    return issues.map((issue) => {
      const jsonPath = formatJsonPath(issue.path)
      return {
        jsonPath,
        message: issue.message,
        ...lineHint(deepestKey(issue.path), content),
      }
    })
  }
}

/** ['components',0,'kind'] → "components[0].kind"；空 path → "$"。 */
function formatJsonPath(pathSegs: PropertyKey[]): string {
  let out = ''
  for (const seg of pathSegs) {
    if (typeof seg === 'number') out += `[${seg}]`
    else out += out ? `.${String(seg)}` : String(seg)
  }
  return out || '$'
}

/** path 中最深的字符串 key（数字下标向前回溯），供行定位用。 */
function deepestKey(pathSegs: PropertyKey[]): string | undefined {
  for (let i = pathSegs.length - 1; i >= 0; i--) {
    const seg = pathSegs[i]
    if (typeof seg === 'string') return seg
  }
  return undefined
}

/** 行定位启发式：逐行找首个 `"key"` 匹配（1 基行号），找不到返回空。 */
function lineHint(key: string | undefined, content: string): { line?: number } {
  if (!key) return {}
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`"${key}"`)) return { line: i + 1 }
  }
  return {}
}

/** JSON 语法错误消息：透传原始 message，并尽力附上行号（Node 22 自带 / 位置换算）。 */
function syntaxMessage(err: Error, content: string): string {
  const raw = err.message
  const withLine = /\(line (\d+) column (\d+)\)/.exec(raw)
  if (withLine) return raw
  const pos = /position (\d+)/.exec(raw)
  if (pos) {
    const line = content.slice(0, Number(pos[1])).split('\n').length
    return `${raw}（约第 ${line} 行）`
  }
  return raw
}

/** 配置服务单例。 */
export const configService = new ConfigService()

/** 供路由使用的类型再导出（避免路由直接依赖服务内部）。 */
export type { WorkspaceChange }
