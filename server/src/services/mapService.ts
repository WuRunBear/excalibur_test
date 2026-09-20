/**
 * 地图工具服务（S5-A）：geometry 预览 / 导出 / 双源 registry 读取。
 *
 * 双源：'workspace'（活动工作区 game/maps/registry.json，默认）| 'official'（本体）。
 * geometry 生成 = gameBridge.buildMapGeometry（纯函数，不启动游戏，不受 S3
 * ecosystems 完整性约束影响）+ GeneratorRegistry 取自 getRegistries().mapGeneratorRegistry。
 * tiled 类型图不走 pipeline 生成 → 400 明确报错。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  bootstrapFramework,
  buildMapGeometry,
  exportGeometryArtifacts,
  getRegistries,
  serializeGeometry,
} from '../../gameBridge/index.js'
import type { SerializedMapGeometry, TilePalette } from '../../gameBridge/index.js'
import { gameConfigsDir } from '../config.js'
import { WorkspaceError, workspaceService } from './workspaceService.js'
import type {
  EntityRulesPayload,
  MapSource,
  MapPipelineStep,
  MapSummary,
  MapsPayload,
} from '../types.js'

/** registry.json 结构（只声明用到的字段，其余透传给 buildMapGeometry 前剥离）。 */
interface RegistryFile {
  maps: Record<string, Record<string, unknown>>
}

/** source 参数规整：缺省 workspace；非法值 400。 */
function normalizeSource(input: unknown): MapSource {
  if (input === undefined || input === null || input === '') return 'workspace'
  if (input === 'workspace' || input === 'official') return input
  throw new WorkspaceError(400, `非法 source "${String(input)}"（expected "workspace" | "official"）`)
}

export class MapService {
  /** 双源 registry 读取（保留声明顺序）；缺文件 → 404。 */
  async listMaps(sourceInput: unknown): Promise<MapsPayload> {
    const source = normalizeSource(sourceInput)
    const raw = await this.readRegistry(source)
    const maps: MapSummary[] = Object.entries(raw.maps).map(([key, entry]) => ({
      key,
      kind: entry.kind === 'tiled' ? 'tiled' : 'pipeline',
      ...(typeof entry.seed === 'number' ? { seed: entry.seed } : {}),
      ...(typeof entry.initialAgeTicks === 'number' ? { initialAgeTicks: entry.initialAgeTicks } : {}),
      ...(Array.isArray(entry.pipeline) ? { pipeline: entry.pipeline as MapSummary['pipeline'] } : {}),
    }))
    return { source, maps }
  }

  /** entity-rules.json 原样 JSON（演化规则点位叠加用）。 */
  async entityRules(sourceInput: unknown): Promise<EntityRulesPayload> {
    const source = normalizeSource(sourceInput)
    const rootDir = await this.rootDirFor(source)
    const file = path.join(rootDir, 'maps', 'entity-rules.json')
    if (!fs.existsSync(file)) {
      throw new WorkspaceError(404, `entity-rules.json 不存在（${source}）`)
    }
    return { source, rules: JSON.parse(await fsp.readFile(file, 'utf8')) }
  }

  /** 单图 geometry 预览（SerializedMapGeometry，与本体 /maps/runtime 同形）。 */
  async geometry(key: string, sourceInput: unknown): Promise<SerializedMapGeometry> {
    const source = normalizeSource(sourceInput)
    const geometry = await this.buildGeometry(source, key)
    return serializeGeometry(geometry)
  }

  /**
   * 导出 png/json：exportGeometryArtifacts 写入每请求独立的临时目录，
   * 调用方（路由）传输后负责清理返回的 dir。
   */
  async exportMap(
    key: string,
    sourceInput: unknown,
    format: string | undefined,
    paletteB64: string | undefined,
  ): Promise<{ filePath: string; dir: string; filename: string; contentType: string }> {
    const source = normalizeSource(sourceInput)
    if (format !== undefined && format !== 'png' && format !== 'json') {
      throw new WorkspaceError(400, `非法 format "${format}"（expected "png" | "json"）`)
    }
    const fmt = format ?? 'png'
    const palette = this.parsePalette(paletteB64)

    const geometry = await this.buildGeometry(source, key)
    const dir = path.join(os.tmpdir(), `admin-map-export-${crypto.randomUUID()}`)
    const { jsonPath, pngPath } = exportGeometryArtifacts(geometry, {
      outDir: dir,
      ...(palette ? { palette } : {}),
    })
    return {
      dir,
      filePath: fmt === 'png' ? pngPath : jsonPath,
      filename: `${key}.${fmt}`,
      contentType: fmt === 'png' ? 'image/png' : 'application/json',
    }
  }

  // ---------------------------------------------------------------------------
  // 内部实现
  // ---------------------------------------------------------------------------

  /**
   * 加载期预处理 + 单次生成 MapGeometry。
   *
   * 复刻本体 loadGameDefinition.resolveMapConfigs 的加载期约定（buildMapGeometry
   * 积木零文件 I/O）：
   * - pipeline 图：params.tiledPath → 读文件（相对 registry 所在 maps/ 目录）
   *   内联为 params.tiled；
   * - tiled 图：转为 {generator:'tiled-source', params:{tiled}} 管道——但按 S5
   *   契约直接 400（前端只预览 pipeline 图）。
   * 管道错误（未注册积木/出口结构）→ 422。
   */
  private async buildGeometry(source: MapSource, key: string) {
    const { rootDir, registryDir, entry } = await this.mapEntry(source, key)
    if (entry.kind === 'tiled') {
      throw new WorkspaceError(400, 'tiled 类型地图不支持 pipeline 几何生成')
    }
    bootstrapFramework()

    const pipeline: { generator: string; params?: Record<string, unknown> }[] = []
    const steps = Array.isArray(entry.pipeline) ? (entry.pipeline as MapPipelineStep[]) : []
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index]
      const params = (step.params ?? {}) as Record<string, unknown>
      if (params.tiledPath === undefined) {
        pipeline.push(step)
        continue
      }
      if (params.tiled !== undefined) {
        throw new WorkspaceError(422, `地图 "${key}" 管道步骤 ${index}：tiled 与 tiledPath 只能声明其一`)
      }
      if (typeof params.tiledPath !== 'string') {
        throw new WorkspaceError(422, `地图 "${key}" 管道步骤 ${index}：tiledPath 必须为字符串`)
      }
      // 防穿越：模板必须位于 maps/ 目录（registryDir）内
      const tiledAbs = path.resolve(registryDir, params.tiledPath)
      if (!tiledAbs.startsWith(registryDir + path.sep)) {
        throw new WorkspaceError(400, `地图 "${key}" 管道步骤 ${index}：tiledPath 越界`)
      }
      let tiledJson: unknown
      try {
        tiledJson = JSON.parse(await fsp.readFile(tiledAbs, 'utf8'))
      } catch (err) {
        throw new WorkspaceError(
          422,
          `地图 "${key}" 管道步骤 ${index}：tiledPath "${params.tiledPath}" 加载失败（${err instanceof Error ? err.message : String(err)}）`,
        )
      }
      const { tiledPath: _omit, ...rest } = params
      pipeline.push({ generator: step.generator, params: { ...rest, tiled: tiledJson } })
    }

    const config = {
      key,
      seed: typeof entry.seed === 'number' ? entry.seed : 0,
      pipeline,
    }
    try {
      return buildMapGeometry(config, getRegistries().mapGeneratorRegistry)
    } catch (err) {
      // 管道引用未注册积木 / 出口结构硬错误 → 配置问题
      throw new WorkspaceError(
        422,
        `地图生成失败：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** 双源根目录（registry/entity-rules 所在的 game 目录）。 */
  private async rootDirFor(source: MapSource): Promise<string> {
    if (source === 'official') return gameConfigsDir
    return workspaceService.requireActiveGameDir().then((r) => r.gameDir)
  }

  private async readRegistry(source: MapSource): Promise<RegistryFile> {
    const rootDir = await this.rootDirFor(source)
    const file = path.join(rootDir, 'maps', 'registry.json')
    if (!fs.existsSync(file)) {
      throw new WorkspaceError(404, `registry.json 不存在（${source}）`)
    }
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as RegistryFile
    if (!parsed || typeof parsed !== 'object' || !parsed.maps || typeof parsed.maps !== 'object') {
      throw new WorkspaceError(422, `registry.json 结构非法（${source}）：缺少 maps 对象`)
    }
    return parsed
  }

  /** 单图原始条目 + 目录信息（registryDir 用于 tiledPath 内联）。 */
  private async mapEntry(
    source: MapSource,
    key: string,
  ): Promise<{ rootDir: string; registryDir: string; entry: Record<string, unknown> }> {
    const rootDir = await this.rootDirFor(source)
    const registryDir = path.join(rootDir, 'maps')
    const file = path.join(registryDir, 'registry.json')
    if (!fs.existsSync(file)) {
      throw new WorkspaceError(404, `registry.json 不存在（${source}）`)
    }
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as RegistryFile
    if (!parsed || typeof parsed !== 'object' || !parsed.maps || typeof parsed.maps !== 'object') {
      throw new WorkspaceError(422, `registry.json 结构非法（${source}）：缺少 maps 对象`)
    }
    const entry = parsed.maps[key]
    if (!entry) {
      throw new WorkspaceError(404, `地图不存在：${key}（${source}）`)
    }
    return { rootDir, registryDir, entry }
  }

  /**
   * palette 传递：query 传 base64(JSON)；JSON 形如 {"1":[92,148,80],"2":[...]([a])}。
   * 解析/结构失败 → 400。
   */
  private parsePalette(raw: string | undefined): TilePalette | undefined {
    if (raw === undefined || raw === '') return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
    } catch {
      throw new WorkspaceError(400, 'palette 解析失败：需要 base64 编码的 JSON')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new WorkspaceError(400, 'palette 解析失败：需要对象 {"<tileId>":[r,g,b,(a)]}')
    }
    const out: Record<number, readonly [number, number, number, number]> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const tileId = Number(k)
      const arr = Array.isArray(v) ? v : []
      const ok =
        Number.isInteger(tileId) &&
        tileId >= 0 &&
        (arr.length === 3 || arr.length === 4) &&
        arr.every((x) => typeof x === 'number' && x >= 0 && x <= 255)
      if (!ok) {
        throw new WorkspaceError(400, `palette 解析失败：条目 "${k}" 不是 [r,g,b,(a)] 0-255 数组`)
      }
      out[tileId] = [...arr, ...(arr.length === 3 ? [255] : [])] as unknown as readonly [
        number,
        number,
        number,
        number,
      ]
    }
    return out as TilePalette
  }
}

/** 地图服务单例。 */
export const mapService = new MapService()
