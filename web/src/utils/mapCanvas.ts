/**
 * 地图几何 → Canvas 2D 渲染的纯函数模块（S5-B）。
 *
 * - normalizeGeometry：把 /api/maps/:key/geometry 的快照归一化为渲染视图
 *   （扁平数组为主路径，兼容分块 base64 形态——复用 maprender/mapCodec 的重组逻辑）；
 * - computeLayout：画布坐标映射（等比 tile，居中，越界安全）；
 * - drawGeometry：walkable 底色 + tiles 纹理 + 网格线 + region 着色/边界 + 规则点位；
 * - extractEntityRulePins：从原样 entity-rules JSON 宽容提取 map/region 引用条目。
 *
 * 全部为纯函数，便于用 mock ctx 做越界断言测试。
 */
import { reassembleBlocked } from 'maprender/mapCodec'

/** 归一化后的区域（regions 快照键序即 regionOfTile 的索引序）。 */
export interface MapRegion {
  index: number
  name: string
}

/** 渲染视图（所有数组长度恒等于 width × height）。 */
export interface GeometryView {
  key: string
  version: string
  width: number
  height: number
  /** 0/1 通行位图 */
  walkable: Uint8Array
  /** 地面语义 id（缺失时为 null） */
  tiles: Uint8Array | null
  regions: MapRegion[]
  /** 每格区域索引（无区域为 -1） */
  regionOfTile: Int32Array
  /** 区域索引 → 覆盖瓦片数（按 regionOfTile 实际统计，含快照未声明但出现的索引） */
  regionAreas: Array<{ index: number; name: string; count: number }>
}

export interface CanvasLayout {
  tile: number
  offsetX: number
  offsetY: number
  mapWidth: number
  mapHeight: number
}

/** 规则点位（cell 坐标；由 entity-rules 条目宽容提取）。 */
export interface EntityRulePin {
  map: string | null
  /** 区域名（或数字索引） */
  region: string | number | null
  summary: string
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

function isChunkedData(value: unknown): value is Array<{ cx: number; cy: number; data: string }> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    typeof value[0] === 'object' &&
    value[0] !== null &&
    'data' in (value[0] as Record<string, unknown>)
  )
}

/**
 * 把快照数组字段归一化为定长 Uint8Array：
 * - 分块 base64 形态 → reassembleBlocked 重组（契约兜底）；
 * - 扁平 number[] → 截断 / 补零到 width × height（防越界）；
 * - 缺失 → 全零。
 */
function normalizeByteField(raw: unknown, width: number, height: number, fallback = 0): Uint8Array {
  const total = width * height
  const out = new Uint8Array(total)
  if (raw === null || raw === undefined) return out

  if (isChunkedData(raw)) {
    const chunks = raw.map((chunk) => ({
      cx: Number(chunk.cx),
      cy: Number(chunk.cy),
      data: String(chunk.data),
    }))
    const assembled = reassembleBlocked(chunks, { width, height })
    out.set(assembled.subarray(0, total))
    return out
  }

  if (typeof raw === 'string') {
    // 整段 base64 → 按字节解码
    try {
      const binary = atob(raw)
      const limit = Math.min(total, binary.length)
      for (let i = 0; i < limit; i++) out[i] = binary.charCodeAt(i) & 0xff
    } catch {
      // 非 base64：放弃该字段，保持 fallback
    }
    return out
  }

  if (Array.isArray(raw)) {
    const limit = Math.min(total, raw.length)
    for (let i = 0; i < limit; i++) {
      const value = Number(raw[i])
      out[i] = Number.isFinite(value)
        ? Math.max(0, Math.min(255, Math.trunc(value))) & 0xff
        : fallback
    }
    return out
  }

  return out
}

/** 区域索引字段：长度对齐 + 非法值收敛为 -1（无区域）。 */
function normalizeRegionOfTile(raw: unknown, width: number, height: number): Int32Array {
  const total = width * height
  const out = new Int32Array(total).fill(-1)
  if (!Array.isArray(raw)) return out
  const limit = Math.min(total, raw.length)
  for (let i = 0; i < limit; i++) {
    const value = Number(raw[i])
    out[i] = Number.isInteger(value) && value >= 0 ? value : -1
  }
  return out
}

/** 快照 → 渲染视图；regions 容错（对象 / 数组 / 缺失），区域名缺失时用索引占位。 */
export function normalizeGeometry(raw: unknown): GeometryView {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('地图几何数据格式异常')
  }
  const snapshot = raw as Record<string, unknown>
  const grid = (snapshot.grid ?? {}) as Record<string, unknown>
  const width = Math.max(1, Math.floor(Number(grid.width) || 0))
  const height = Math.max(1, Math.floor(Number(grid.height) || 0))
  if (
    !Number.isFinite(Number(grid.width)) ||
    !Number.isFinite(Number(grid.height)) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error('地图几何缺少有效的 grid 尺寸')
  }

  const walkable = normalizeByteField(snapshot.walkable, width, height)
  const tilesRaw = snapshot.tiles
  const tiles =
    tilesRaw === null || tilesRaw === undefined ? null : normalizeByteField(tilesRaw, width, height)
  const regionOfTile = normalizeRegionOfTile(snapshot.regionOfTile, width, height)

  // regions：Record<区域名, {name, meta}> 主路径；数组 / 其他形态兜底
  const regions: MapRegion[] = []
  const regionsRaw = snapshot.regions
  if (Array.isArray(regionsRaw)) {
    regionsRaw.forEach((item, index) => {
      const name =
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { name?: unknown }).name === 'string'
          ? ((item as { name: string }).name as string)
          : `区域 ${index}`
      regions.push({ index, name })
    })
  } else if (typeof regionsRaw === 'object' && regionsRaw !== null) {
    Object.keys(regionsRaw as Record<string, unknown>).forEach((name, index) => {
      regions.push({ index, name })
    })
  }

  // 区域面积：以 regionOfTile 实际出现为准（含快照未声明索引，名字用索引占位）
  const counts = new Map<number, number>()
  for (let i = 0; i < regionOfTile.length; i++) {
    const index = regionOfTile[i] ?? -1
    if (index >= 0) counts.set(index, (counts.get(index) ?? 0) + 1)
  }
  const regionAreas = [...counts.entries()]
    .map(([index, count]) => ({
      index,
      name: regions.find((region) => region.index === index)?.name ?? `区域 ${index}`,
      count,
    }))
    .sort((a, b) => b.count - a.count)

  return {
    key: typeof snapshot.key === 'string' ? snapshot.key : '',
    version: typeof snapshot.version === 'string' ? snapshot.version : '',
    width,
    height,
    walkable,
    tiles,
    regions,
    regionOfTile,
    regionAreas,
  }
}

// ---------------------------------------------------------------------------
// 布局与坐标映射
// ---------------------------------------------------------------------------

/**
 * 等比布局：tile = floor(min(vw/w, vh/h))，夹取 [1, maxTile]，地图在画布内居中。
 * 画布小于最小可读尺寸时 tile 保持 1、偏移可为负（由绘制侧裁剪，不越界写像素）。
 */
export function computeLayout(
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  maxTile = 24,
): CanvasLayout {
  const safeW = Math.max(1, width)
  const safeH = Math.max(1, height)
  const inner = Math.floor(Math.min(viewportWidth / safeW, viewportHeight / safeH))
  const tile = Math.max(1, Math.min(maxTile, Number.isFinite(inner) ? inner : 1))
  const mapWidth = tile * safeW
  const mapHeight = tile * safeH
  return {
    tile,
    offsetX: Math.floor((viewportWidth - mapWidth) / 2),
    offsetY: Math.floor((viewportHeight - mapHeight) / 2),
    mapWidth,
    mapHeight,
  }
}

/** 区域质心（cell 坐标，四舍五入）；该区域无瓦片时返回 null。 */
export function regionCentroid(
  view: Pick<GeometryView, 'width' | 'height' | 'regionOfTile'>,
  regionIndex: number,
): { cx: number; cy: number } | null {
  let sumX = 0
  let sumY = 0
  let count = 0
  for (let ty = 0; ty < view.height; ty++) {
    for (let tx = 0; tx < view.width; tx++) {
      if (view.regionOfTile[ty * view.width + tx] === regionIndex) {
        sumX += tx
        sumY += ty
        count += 1
      }
    }
  }
  if (count === 0) return null
  return { cx: Math.round(sumX / count), cy: Math.round(sumY / count) }
}

/** 区域色：索引确定（黄金角散布色相），保证同区域同色、小数量下不易撞色。 */
export function regionColor(index: number): string {
  const hue = Math.abs(Math.round(index * 137.508)) % 360
  return `hsl(${hue}, 62%, 62%)`
}

/** 区域边界色（同色相加深）。 */
export function regionBorderColor(index: number): string {
  const hue = Math.abs(Math.round(index * 137.508)) % 360
  return `hsl(${hue}, 62%, 38%)`
}

// ---------------------------------------------------------------------------
// 绘制
// ---------------------------------------------------------------------------

export interface DrawPin {
  /** cell 坐标 */
  cx: number
  cy: number
  label: string
}

export interface DrawOptions {
  /** 区域索引 → 颜色（默认 regionColor） */
  regionColorFor?: (index: number) => string
  /** 规则点位（cell 坐标） */
  pins?: DrawPin[]
}

/**
 * 绘制上下文：CanvasRenderingContext2D 的结构化子集。
 * fillStyle / strokeStyle 取其原生联合类型（string | CanvasGradient | CanvasPattern），
 * 让真实 ctx 与测试 mock（仅 string）都能赋值；本模块只写入字符串常量。
 */
export interface GeometryDrawContext {
  fillStyle: CanvasRenderingContext2D['fillStyle']
  strokeStyle: CanvasRenderingContext2D['strokeStyle']
  globalAlpha: number
  lineWidth: number
  fillRect: (x: number, y: number, w: number, h: number) => void
  beginPath: () => void
  arc: (x: number, y: number, r: number, start: number, end: number) => void
  fill: () => void
  stroke: () => void
}

/** walkable 格的三档微差纹理底色（按 tiles id 取模，无 tiles 时用第一档）。 */
const TILE_SHADES = ['#e9f1ee', '#dfeae6', '#d5e4df'] as const

/**
 * 绘制几何快照。全部绘制都在 layout 对应的地图矩形内（含 1px 网格线与 2px 区域边界），
 * 不会写出画布；pin 半径除外（按设计允许悬出边缘，由调用方裁剪）。
 */
export function drawGeometry(
  ctx: GeometryDrawContext,
  view: GeometryView,
  layout: CanvasLayout,
  options: DrawOptions = {},
): void {
  const { tile, offsetX, offsetY } = layout
  const regionColorFor = options.regionColorFor ?? regionColor

  // 1. 底色：walkable 浅色（tiles 提供三档微差纹理），阻挡深色
  for (let ty = 0; ty < view.height; ty++) {
    for (let tx = 0; tx < view.width; tx++) {
      const i = ty * view.width + tx
      const x = offsetX + tx * tile
      const y = offsetY + ty * tile
      if (!view.walkable[i]) {
        ctx.fillStyle = '#33413d'
      } else if (view.tiles) {
        const tileId = view.tiles[i] ?? 0
        ctx.fillStyle = TILE_SHADES[tileId % TILE_SHADES.length] ?? '#e9f1ee'
      } else {
        ctx.fillStyle = '#e9f1ee'
      }
      ctx.fillRect(x, y, tile, tile)
    }
  }

  // 2. region 着色叠加 + 右/下边界描边
  for (let ty = 0; ty < view.height; ty++) {
    for (let tx = 0; tx < view.width; tx++) {
      const i = ty * view.width + tx
      const regionIndex = view.regionOfTile[i] ?? -1
      if (regionIndex < 0) continue
      const x = offsetX + tx * tile
      const y = offsetY + ty * tile

      ctx.globalAlpha = 0.4
      ctx.fillStyle = regionColorFor(regionIndex)
      ctx.fillRect(x, y, tile, tile)
      ctx.globalAlpha = 1

      const rightIndex = tx + 1 < view.width ? view.regionOfTile[i + 1] : -1
      const downIndex = ty + 1 < view.height ? view.regionOfTile[i + view.width] : -1
      if (rightIndex !== regionIndex) {
        ctx.fillStyle = regionBorderColor(regionIndex)
        ctx.fillRect(x + tile - 1, y, 1, tile)
      }
      if (downIndex !== regionIndex) {
        ctx.fillStyle = regionBorderColor(regionIndex)
        ctx.fillRect(x, y + tile - 1, tile, 1)
      }
    }
  }

  // 3. 网格线（tile 足够大时），画在地图矩形内
  if (tile >= 8) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.07)'
    for (let tx = 1; tx < view.width; tx++) {
      ctx.fillRect(offsetX + tx * tile - 1, offsetY, 1, layout.mapHeight - 1)
    }
    for (let ty = 1; ty < view.height; ty++) {
      ctx.fillRect(offsetX, offsetY + ty * tile - 1, layout.mapWidth - 1, 1)
    }
  }

  // 4. 规则点位：墨青圆点 + 白描边（半径随 tile 缩放）
  for (const pin of options.pins ?? []) {
    const px = offsetX + (pin.cx + 0.5) * tile
    const py = offsetY + (pin.cy + 0.5) * tile
    const radius = Math.max(4, tile * 0.55)
    ctx.beginPath()
    ctx.arc(px, py, radius, 0, Math.PI * 2)
    ctx.fillStyle = '#0f766e'
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = '#ffffff'
    ctx.stroke()
  }
}

// ---------------------------------------------------------------------------
// entity-rules 点位提取（宽容未知 JSON 形状）
// ---------------------------------------------------------------------------

const MAP_KEYS = ['map', 'mapKey', 'mapId'] as const
const REGION_KEYS = ['region', 'regionName', 'regionId'] as const
const SUMMARY_KEYS = ['name', 'kind', 'type', 'description', 'desc', 'action', 'rule'] as const

function firstStringOf(node: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = node[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function firstRegionOf(node: Record<string, unknown>): string | number | null {
  for (const key of REGION_KEYS) {
    const value = node[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

/** 深度遍历 JSON，收集同时引用 map / region 的条目（去重、限量，防未知结构爆炸）。 */
export function extractEntityRulePins(rules: unknown, limit = 200): EntityRulePin[] {
  const pins: EntityRulePin[] = []
  const seen = new Set<string>()

  const visit = (node: unknown): void => {
    if (pins.length >= limit) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (typeof node !== 'object' || node === null) return

    const record = node as Record<string, unknown>
    const map = firstStringOf(record, MAP_KEYS)
    const region = firstRegionOf(record)
    if (map !== null || region !== null) {
      const summary =
        firstStringOf(record, SUMMARY_KEYS) ??
        JSON.stringify(stripUnknownMeta(record)).slice(0, 120)
      const key = `${map ?? ''}|${String(region ?? '')}|${summary}`
      if (!seen.has(key)) {
        seen.add(key)
        pins.push({ map, region, summary })
      }
    }
    for (const value of Object.values(record)) {
      if (value !== null && typeof value === 'object') visit(value)
    }
  }

  visit(rules)
  return pins
}

/** 摘要兜底用：去掉深层嵌套 / 函数等，保留标量字段的紧凑 JSON。 */
function stripUnknownMeta(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      out[key] = value
    }
  }
  return out
}
