import { describe, expect, it, vi } from 'vitest'

import {
  computeLayout,
  drawGeometry,
  extractEntityRulePins,
  normalizeGeometry,
  regionBorderColor,
  regionCentroid,
  regionColor,
  type GeometryView,
} from '@/utils/mapCanvas'

/** 4×4 视图：region0 占 6 格、region1 占 3 格、region2 占 1 格、其余无区域。 */
function makeView(overrides: Partial<GeometryView> = {}): GeometryView {
  const width = 4
  const height = 4
  const regionOfTile = new Int32Array(width * height).fill(-1)
  // region0：左上 2×3
  for (let ty = 0; ty < 3; ty++) {
    for (let tx = 0; tx < 2; tx++) regionOfTile[ty * width + tx] = 0
  }
  // region1：右上 3 格
  regionOfTile[0 * width + 2] = 1
  regionOfTile[0 * width + 3] = 1
  regionOfTile[1 * width + 2] = 1
  // region2：右下角
  regionOfTile[3 * width + 3] = 2
  return {
    key: 'home',
    version: 'abcdef1234567890',
    width,
    height,
    walkable: new Uint8Array(width * height).fill(1),
    tiles: null,
    regions: [
      { index: 0, name: 'home' },
      { index: 1, name: 'forest' },
      { index: 2, name: 'cave' },
    ],
    regionOfTile,
    regionAreas: [
      { index: 0, name: 'home', count: 6 },
      { index: 1, name: 'forest', count: 3 },
      { index: 2, name: 'cave', count: 1 },
    ],
    ...overrides,
  }
}

describe('normalizeGeometry', () => {
  it('扁平数组主路径：字段定长、区域面积按实际统计', () => {
    const view = normalizeGeometry({
      key: 'home',
      version: 'v1',
      grid: { width: 2, height: 2 },
      tiles: [1, 2, 3, 4],
      walkable: [1, 0, 1, 1],
      regions: { home: { name: 'home', meta: {} } },
      regionOfTile: [0, 0, -1, 0],
    })
    expect(view.walkable).toEqual(new Uint8Array([1, 0, 1, 1]))
    expect(view.tiles).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(view.regionAreas).toEqual([{ index: 0, name: 'home', count: 3 }])
  })

  it('防御越界：短数组补零、长数组截断、非法区域值收敛为 -1', () => {
    const view = normalizeGeometry({
      grid: { width: 3, height: 2 },
      walkable: [1],
      tiles: [1, 2, 3, 4, 5, 6, 7, 8],
      regionOfTile: [0, 99, -5, 1.5, 'x'],
    })
    expect(view.walkable).toEqual(new Uint8Array([1, 0, 0, 0, 0, 0]))
    expect(view.tiles).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]))
    // 0 合法、99 越界保留（面积统计容错）、-5/1.5/'x' → -1
    expect([...view.regionOfTile]).toEqual([0, 99, -1, -1, -1, -1])
    expect(view.regionAreas.map((area) => area.index).sort((a, b) => a - b)).toEqual([0, 99])
  })

  it('分块 base64 兜底：走 mapCodec 重组', () => {
    // 2×2 网格 → 1 个 16×16 块（边缘块截断为 2×2=4 字节）
    const bytes = Uint8Array.from([1, 0, 0, 1])
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    const view = normalizeGeometry({
      grid: { width: 2, height: 2 },
      walkable: [{ cx: 0, cy: 0, data: btoa(binary) }],
      regionOfTile: [],
    })
    expect(view.walkable).toEqual(bytes)
  })

  it('缺 grid 尺寸时抛错（绝不静默渲染错图）', () => {
    expect(() => normalizeGeometry({ walkable: [1] })).toThrow()
  })
})

describe('computeLayout', () => {
  it('等比取整并居中', () => {
    const layout = computeLayout(32, 32, 400, 300)
    expect(layout.tile).toBe(9) // floor(min(12.5, 9.375))
    expect(layout.mapWidth).toBe(288)
    expect(layout.offsetX).toBe(56)
    expect(layout.offsetY).toBe(6)
  })

  it('tile 夹取 [1, maxTile]，画布过小时保持 1', () => {
    expect(computeLayout(4, 4, 400, 400, 24).tile).toBe(24)
    expect(computeLayout(1000, 1000, 100, 100).tile).toBe(1)
  })
})

describe('regionCentroid', () => {
  it('按区域瓦片求均值并取整', () => {
    const view = makeView()
    expect(regionCentroid(view, 1)).toEqual({ cx: 2, cy: 0 }) // (2,0)(3,0)(2,1) → x=7/3≈2, y=1/3≈0
    expect(regionCentroid(view, 2)).toEqual({ cx: 3, cy: 3 })
  })

  it('不存在的区域返回 null', () => {
    expect(regionCentroid(makeView(), 9)).toBeNull()
  })
})

describe('drawGeometry', () => {
  function makeCtx() {
    return {
      fillStyle: '',
      strokeStyle: '',
      globalAlpha: 1,
      lineWidth: 0,
      rects: [] as Array<{ x: number; y: number; w: number; h: number; style: string }>,
      fills: 0,
      fillRect(x: number, y: number, w: number, h: number): void {
        this.rects.push({ x, y, w, h, style: this.fillStyle })
      },
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill(): void {
        this.fills += 1
      },
      stroke: vi.fn(),
    }
  }

  it('所有绘制都落在画布地图矩形内（不越界）', () => {
    const view = makeView()
    const layout = computeLayout(view.width, view.height, 200, 200, 24)
    const ctx = makeCtx()
    drawGeometry(ctx, view, layout, { pins: [{ cx: 1, cy: 1, label: 'x' }] })

    const right = layout.offsetX + layout.mapWidth
    const bottom = layout.offsetY + layout.mapHeight
    for (const rect of ctx.rects) {
      expect(rect.x).toBeGreaterThanOrEqual(layout.offsetX)
      expect(rect.y).toBeGreaterThanOrEqual(layout.offsetY)
      expect(rect.x + rect.w).toBeLessThanOrEqual(right)
      expect(rect.y + rect.h).toBeLessThanOrEqual(bottom)
    }
    expect(ctx.rects.length).toBeGreaterThan(0)
  })

  it('底色格数 = 宽×高，pin 产生圆点填充', () => {
    const view = makeView() // 4×4=16 格
    const layout = computeLayout(view.width, view.height, 200, 200, 24)
    const ctx = makeCtx()
    drawGeometry(ctx, view, layout, { pins: [{ cx: 0, cy: 0, label: 'a' }] })
    // 16 底色 + region overlay/border + 网格（tile>=8）+ pin
    expect(ctx.rects.length).toBeGreaterThanOrEqual(16)
    expect(ctx.fills).toBe(1)
    expect(ctx.arc).toHaveBeenCalled()
  })

  it('region 着色：overlay 用区域对应色，边界用同色相加深色', () => {
    const view = makeView()
    const layout = computeLayout(view.width, view.height, 200, 200, 24)
    const ctx = makeCtx()
    drawGeometry(ctx, view, layout)
    const tile = layout.tile

    // (0,0) 属于 region0：底色之上应有 regionColor(0) 的整格 overlay
    const overlay = ctx.rects.find(
      (r) =>
        r.x === layout.offsetX &&
        r.y === layout.offsetY &&
        r.w === tile &&
        r.h === tile &&
        r.style === regionColor(0),
    )
    expect(overlay).toBeDefined()

    // region0 最右列 (1,0) 的右邻是 region1 → 该处应有 regionBorderColor(0) 的 1px 竖边界
    const border = ctx.rects.find(
      (r) =>
        r.x === layout.offsetX + 2 * tile - 1 &&
        r.y === layout.offsetY &&
        r.w === 1 &&
        r.h === tile &&
        r.style === regionBorderColor(0),
    )
    expect(border).toBeDefined()

    // 区域间颜色互不相同（每 region 一色）
    expect(regionColor(0)).not.toBe(regionColor(1))
    expect(regionColor(1)).not.toBe(regionColor(2))
  })
})

describe('extractEntityRulePins', () => {
  it('从未知形状 JSON 中提取 map/region 引用条目', () => {
    const rules = {
      version: 1,
      entries: [
        { map: 'home', region: 'forest', kind: 'spawn-wolf', extra: { nested: true } },
        { mapKey: 'home', regionId: 2, name: '宝箱' },
        { only: 'unrelated' },
      ],
    }
    const pins = extractEntityRulePins(rules)
    expect(pins).toHaveLength(2)
    expect(pins[0]).toMatchObject({ map: 'home', region: 'forest', summary: 'spawn-wolf' })
    expect(pins[1]).toMatchObject({ map: 'home', region: 2, summary: '宝箱' })
  })

  it('数量限制与去重', () => {
    const entries = Array.from({ length: 300 }, (_, index) => ({
      map: 'home',
      region: 'forest',
      kind: `k${index}`,
    }))
    expect(extractEntityRulePins(entries)).toHaveLength(200)
    expect(extractEntityRulePins([{ map: 'home', region: 'a', kind: 'x' }])).toHaveLength(1)
  })
})
