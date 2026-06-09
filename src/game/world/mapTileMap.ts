import { Actor, Color, Rectangle, TileMap, vec } from 'excalibur'

import type { CollisionDebugSnapshot, MapRuntime } from 'game/net/types'

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

export function createServerColliderDebugActors(snapshot: CollisionDebugSnapshot): Actor[] {
  const actors: Actor[] = []

  for (const body of snapshot.bodies) {
    if (body.shape === 'circle') {
      const actor = new Actor({
        pos: vec(body.x, body.y),
        radius: body.r,
        color: Color.fromRGB(0, 255, 0, 0.12),
      })
      actors.push(actor)
      continue
    }

    const cx = body.x + body.width * 0.5
    const cy = body.y + body.height * 0.5
    const actor = new Actor({
      pos: vec(cx, cy),
      width: body.width,
      height: body.height,
    })
    actor.graphics.use(
      new Rectangle({
        width: body.width,
        height: body.height,
        color: body.kind === 'map' ? Color.fromRGB(0, 128, 255, 0.18) : Color.fromRGB(0, 255, 0, 0.18),
      }),
    )
    actors.push(actor)
  }

  return actors
}
