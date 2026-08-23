import { describe, expect, it } from 'vitest'

import {
  MAP_CHUNK_SIZE,
  decodeChunkData,
  makeMapCacheKey,
  reassembleBlocked,
} from '../net/mapCodec'

// ---------- 测试用工具 ----------

/** 确定性伪随机图案（LCG）：同尺寸同种子恒产生同一字节序列 */
function seededBlocked(width: number, height: number, seed = 20260823): Uint8Array {
  const blocked = new Uint8Array(width * height)
  let state = seed >>> 0
  for (let i = 0; i < blocked.length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0
    blocked[i] = state & 0xff
  }
  return blocked
}

/** 条纹图案 blocked[x,y] = (x+y) & 0xff：相邻块边界差异直观可辨 */
function stripedBlocked(width: number, height: number): Uint8Array {
  const blocked = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      blocked[y * width + x] = (x + y) & 0xff
    }
  }
  return blocked
}

/** 行主序字节 → 二进制字符串 → base64（镜像 decodeChunkData 的 atob 解码路径） */
function encodeChunk(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

/**
 * 与服务端 buildMapChunks 完全一致的分块方式：
 * 块 (cx,cy) 覆盖瓦片行 [cy*16,(cy+1)*16)、列 [cx*16,(cx+1)*16)，
 * data 为该块按行主序切出的 Uint8Array 的 base64
 */
function buildChunks(
  blocked: Uint8Array,
  grid: { width: number; height: number },
): Array<{ cx: number; cy: number; data: string }> {
  const chunkCols = Math.ceil(grid.width / MAP_CHUNK_SIZE)
  const chunkRows = Math.ceil(grid.height / MAP_CHUNK_SIZE)
  const chunks: Array<{ cx: number; cy: number; data: string }> = []
  for (let cy = 0; cy < chunkRows; cy++) {
    for (let cx = 0; cx < chunkCols; cx++) {
      const chunkWidth = Math.min(MAP_CHUNK_SIZE, grid.width - cx * MAP_CHUNK_SIZE)
      const chunkHeight = Math.min(MAP_CHUNK_SIZE, grid.height - cy * MAP_CHUNK_SIZE)
      const bytes = new Uint8Array(chunkWidth * chunkHeight)
      for (let ty = 0; ty < chunkHeight; ty++) {
        const rowStart = (cy * MAP_CHUNK_SIZE + ty) * grid.width + cx * MAP_CHUNK_SIZE
        bytes.set(blocked.subarray(rowStart, rowStart + chunkWidth), ty * chunkWidth)
      }
      chunks.push({ cx, cy, data: encodeChunk(bytes) })
    }
  }
  return chunks
}

/** 确定性洗牌（Fisher–Yates + LCG），用于乱序块测试 */
function shuffled<T>(items: T[], seed = 7): T[] {
  const out = [...items]
  let state = seed >>> 0
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1664525 + 1013904223) >>> 0
    const j = state % (i + 1)
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

/** 断言两个字节数组长度一致且逐字节相等，失败时汇总所有不一致下标 */
function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length)
  const mismatches: number[] = []
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) mismatches.push(i)
  }
  expect(mismatches).toEqual([])
}

// ---------- reassembleBlocked：重组正确性 ----------

describe('reassembleBlocked', () => {
  it('64×64 网格（16 块）：重组结果与原始整包逐字节一致', () => {
    const grid = { width: 64, height: 64 }
    const blocked = seededBlocked(64, 64)
    const chunks = buildChunks(blocked, grid)
    expect(chunks).toHaveLength(16)
    expectBytesEqual(reassembleBlocked(chunks, grid), blocked)
  })

  it('32×32 网格（4 块）：重组结果与原始整包逐字节一致', () => {
    const grid = { width: 32, height: 32 }
    const blocked = stripedBlocked(32, 32)
    const chunks = buildChunks(blocked, grid)
    expect(chunks).toHaveLength(4)
    expectBytesEqual(reassembleBlocked(chunks, grid), blocked)
  })

  it('块顺序完全颠倒仍按 cx/cy 归位，重组结果不变', () => {
    const grid = { width: 64, height: 64 }
    const blocked = seededBlocked(64, 64)
    const chunks = buildChunks(blocked, grid)
    expectBytesEqual(reassembleBlocked([...chunks].reverse(), grid), blocked)
  })

  it('随机洗牌的块顺序不影响重组结果（位置由 cx/cy 决定，与数组顺序无关）', () => {
    const grid = { width: 32, height: 32 }
    const blocked = stripedBlocked(32, 32)
    const chunks = buildChunks(blocked, grid)
    expectBytesEqual(reassembleBlocked(shuffled(chunks), grid), blocked)
  })

  it('20×20 网格（非 16 倍数）：边缘块按余量缩小后重组仍逐字节一致', () => {
    const grid = { width: 20, height: 20 }
    const blocked = stripedBlocked(20, 20)
    const chunks = buildChunks(blocked, grid)
    expect(chunks).toHaveLength(4)
    // 块字节数应为：右下 4×4=16、右列 4×16=64、下排 16×4=64、左上 16×16=256
    const sizes = chunks.map((c) => decodeChunkData(c.data).length).sort((a, b) => a - b)
    expect(sizes).toEqual([16, 64, 64, 256])
    expectBytesEqual(reassembleBlocked(chunks, grid), blocked)
  })
})

// ---------- reassembleBlocked：异常校验 ----------

describe('reassembleBlocked 校验失败时显式抛错', () => {
  it('块数量少于期望（64×64 只给 15 块）时抛错', () => {
    const grid = { width: 64, height: 64 }
    const chunks = buildChunks(seededBlocked(64, 64), grid).slice(0, 15)
    expect(() => reassembleBlocked(chunks, grid)).toThrow(/地图分块数量不符/)
  })

  it('块数量多于期望（32×32 给 5 块）时抛错', () => {
    const grid = { width: 32, height: 32 }
    const chunks = buildChunks(seededBlocked(32, 32), grid)
    chunks.push({ cx: 2, cy: 2, data: encodeChunk(new Uint8Array(256)) })
    expect(() => reassembleBlocked(chunks, grid)).toThrow(/地图分块数量不符/)
  })

  it('单块字节数不符（满块截断为 255 字节）时抛错', () => {
    const grid = { width: 64, height: 64 }
    const chunks = buildChunks(seededBlocked(64, 64), grid)
    const truncated = decodeChunkData(chunks[5]!.data).subarray(0, 255)
    chunks[5] = { ...chunks[5]!, data: encodeChunk(truncated) }
    expect(() => reassembleBlocked(chunks, grid)).toThrow(/地图分块字节数不符/)
  })

  it('块坐标 cx 超出范围时抛错', () => {
    const grid = { width: 32, height: 32 }
    const chunks = buildChunks(seededBlocked(32, 32), grid)
    chunks[0] = { ...chunks[0]!, cx: 2 }
    expect(() => reassembleBlocked(chunks, grid)).toThrow(/地图分块坐标越界/)
  })

  it('块坐标为负数时抛错', () => {
    const grid = { width: 32, height: 32 }
    const chunks = buildChunks(seededBlocked(32, 32), grid)
    chunks[1] = { ...chunks[1]!, cy: -1 }
    expect(() => reassembleBlocked(chunks, grid)).toThrow(/地图分块坐标越界/)
  })

  it('块坐标重复（两块同为 (0,0)）时抛错', () => {
    const grid = { width: 32, height: 32 }
    const chunks = buildChunks(seededBlocked(32, 32), grid)
    chunks[3] = { ...chunks[0]! }
    expect(() => reassembleBlocked(chunks, grid)).toThrow(/地图分块重复/)
  })
})

// ---------- decodeChunkData ----------

describe('decodeChunkData', () => {
  it('base64 解码与编码互逆：任意字节（含 0 与 255 边界值）往返一致', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 254, 255, 42, 7])
    expectBytesEqual(decodeChunkData(encodeChunk(bytes)), bytes)
  })

  it('空字符串解码为空字节数组', () => {
    expect(decodeChunkData('')).toHaveLength(0)
  })
})

// ---------- makeMapCacheKey ----------

describe('makeMapCacheKey', () => {
  it('相同 {id,version} 生成相同缓存键', () => {
    expect(makeMapCacheKey('generated-map', '1a2b3c4d')).toBe('generated-map:1a2b3c4d')
    expect(makeMapCacheKey('generated-map', '1a2b3c4d')).toBe('generated-map:1a2b3c4d')
  })

  it('version 不同则缓存键不同', () => {
    expect(makeMapCacheKey('generated-map', '1a2b3c4d')).not.toBe(
      makeMapCacheKey('generated-map', '5e6f7a8b'),
    )
  })

  it('id 不同则缓存键不同', () => {
    expect(makeMapCacheKey('generated-map', '1a2b3c4d')).not.toBe(
      makeMapCacheKey('cave', '1a2b3c4d'),
    )
  })

  it('同 {id,version} 命中同一缓存键，实现「跳过重复拉取」；版本变化触发重新拉取', () => {
    const cache = new Map<string, { id: string; version: string }>()
    const fetched: string[] = []
    const fetchMap = (id: string, version: string) => {
      const key = makeMapCacheKey(id, version)
      const cached = cache.get(key)
      if (cached) return cached
      const value = { id, version }
      cache.set(key, value)
      fetched.push(id)
      return value
    }

    expect(fetchMap('generated-map', 'v1')).toEqual({ id: 'generated-map', version: 'v1' })
    expect(fetchMap('generated-map', 'v1')).toEqual({ id: 'generated-map', version: 'v1' })
    expect(fetched).toEqual(['generated-map']) // 第二次命中缓存，未再次拉取

    expect(fetchMap('generated-map', 'v2')).toEqual({ id: 'generated-map', version: 'v2' })
    expect(fetched).toEqual(['generated-map', 'generated-map']) // 版本变化重新拉取
  })
})
