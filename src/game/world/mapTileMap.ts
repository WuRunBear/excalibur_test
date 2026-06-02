import { Actor, Color, Rectangle, TileMap, vec } from 'excalibur'

import type { MapRuntime } from 'game/net/types'

type TileRect = { x0: number; x1: number; y0: number; y1: number }

function blockedToRects(blocked: Uint8Array, width: number, height: number): TileRect[] {
  const out: TileRect[] = []
  let active = new Map<string, TileRect>()

  for (let y = 0; y < height; y++) {
    const next = new Map<string, TileRect>()

    let x = 0
    while (x < width) {
      const idx = y * width + x
      if (blocked[idx] !== 1) {
        x++
        continue
      }

      const x0 = x
      x++
      while (x < width && blocked[y * width + x] === 1) x++
      const x1 = x - 1

      const key = `${x0},${x1}`
      const existing = active.get(key)
      if (existing) {
        existing.y1 = y
        next.set(key, existing)
      } else {
        next.set(key, { x0, x1, y0: y, y1: y })
      }
    }

    for (const [key, rect] of active) {
      if (next.has(key)) continue
      out.push(rect)
    }

    active = next
  }

  for (const rect of active.values()) out.push(rect)
  return out
}

/**
 * 根据服务端 MapRuntime 构造一个用于“查看”的 TileMap。
 *
 * 说明：
 * - 当前只可视化 blocked（阻挡格）
 * - 不做贴图与地形表现，只用于调试/查看 NPC 与玩家在地图上的运动
 *
 * @param runtime 服务端地图运行时数据
 * @returns Excalibur TileMap 实例
 */
export function createMapTileMap(runtime: MapRuntime): TileMap {
  const tileMap = new TileMap({
    name: `map:${runtime.id}`,
    pos: vec(0, 0),
    tileWidth: runtime.grid.tileWidth,
    tileHeight: runtime.grid.tileHeight,
    rows: runtime.grid.height,
    columns: runtime.grid.width,
  })

  const blockedGraphic = new Rectangle({
    width: runtime.grid.tileWidth,
    height: runtime.grid.tileHeight,
    color: Color.fromRGB(255, 255, 255, 0.18),
  })

  const { width, height } = runtime.grid
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (runtime.blocked[idx] !== 1) continue
      const tile = tileMap.getTile(x, y)
      if (!tile) continue
      tile.solid = true
      tile.addGraphic(blockedGraphic)
    }
  }

  return tileMap
}

/**
 * 基于服务端地图 blocked 网格，生成用于调试显示的“合并后矩形碰撞体”覆盖层。
 *
 * @param runtime 服务端地图运行时数据
 * @returns 需要添加到场景中的 Actor 列表
 */
export function createCollisionRectDebugActors(runtime: MapRuntime): Actor[] {
  const { width, height, tileWidth, tileHeight } = runtime.grid
  const rects = blockedToRects(runtime.blocked, width, height)

  const actors: Actor[] = []
  for (const r of rects) {
    const w = (r.x1 - r.x0 + 1) * tileWidth
    const h = (r.y1 - r.y0 + 1) * tileHeight
    const cx = ((r.x0 + r.x1 + 1) * 0.5) * tileWidth
    const cy = ((r.y0 + r.y1 + 1) * 0.5) * tileHeight

    const actor = new Actor({
      pos: vec(cx, cy),
      width: w,
      height: h,
    })
    actor.graphics.use(
      new Rectangle({
        width: w,
        height: h,
        color: Color.fromRGB(255, 0, 0, 0.18),
      }),
    )
    actors.push(actor)
  }

  return actors
}
