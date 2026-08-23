/**
 * 地图运行时数据编解码纯函数模块。
 *
 * 说明：
 * - 本模块只包含纯函数，无任何副作用与外部依赖，便于独立单元测试
 * - 分块协议：服务端把 blocked 阻挡数据按 16×16 瓦片切成块，
 *   每块按行主序编为 Uint8Array 切片后 base64 编码传输
 */

/**
 * 地图分块边长（瓦片数）。
 *
 * 说明：
 * - 服务端按 16×16 瓦片切块，满块为 256 字节
 * - 边缘块不足 16×16 时按实际大小截断
 */
export const MAP_CHUNK_SIZE = 16

/**
 * 将 base64 字符串解码为 Uint8Array。
 *
 * @param base64 base64 字符串
 * @returns 二进制字节数组
 */
export function decodeChunkData(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * 把服务端分块传输的阻挡数据按行主序重组为扁平 blocked 数组。
 *
 * 说明：
 * - 分块 (cx, cy) 覆盖瓦片行 [cy*16, (cy+1)*16)、列 [cx*16, (cx+1)*16)
 * - 地图宽高不是 16 的整数倍时，最后一列/最后一行的块相应变小
 * - 校验分块数量与字节总数，不符时显式抛错（绝不静默错配）
 *
 * @param chunks 服务端分块列表（每块含块坐标与 base64 数据）
 * @param grid 地图网格（宽高以瓦片计）
 * @returns 扁平 blocked 数组（长度 = width * height，行主序）
 */
export function reassembleBlocked(
  chunks: Array<{ cx: number; cy: number; data: string }>,
  grid: { width: number; height: number },
): Uint8Array {
  const chunkCols = Math.ceil(grid.width / MAP_CHUNK_SIZE)
  const chunkRows = Math.ceil(grid.height / MAP_CHUNK_SIZE)
  const expectedChunkCount = chunkCols * chunkRows
  if (chunks.length !== expectedChunkCount) {
    throw new Error(
      `地图分块数量不符：期望 ${expectedChunkCount}（${chunkCols}×${chunkRows}），实际 ${chunks.length}`,
    )
  }

  const blocked = new Uint8Array(grid.width * grid.height)
  const seen = new Set<string>()
  let totalBytes = 0

  for (const chunk of chunks) {
    const { cx, cy, data } = chunk
    if (cx < 0 || cy < 0 || cx >= chunkCols || cy >= chunkRows) {
      throw new Error(
        `地图分块坐标越界：(${cx}, ${cy})，期望范围 [0,${chunkCols})×[0,${chunkRows})`,
      )
    }
    const key = `${cx},${cy}`
    if (seen.has(key)) {
      throw new Error(`地图分块重复：(${cx}, ${cy})`)
    }
    seen.add(key)

    const bytes = decodeChunkData(data)
    const chunkWidth = Math.min(MAP_CHUNK_SIZE, grid.width - cx * MAP_CHUNK_SIZE)
    const chunkHeight = Math.min(MAP_CHUNK_SIZE, grid.height - cy * MAP_CHUNK_SIZE)
    const expectedBytes = chunkWidth * chunkHeight
    if (bytes.length !== expectedBytes) {
      throw new Error(
        `地图分块字节数不符：(${cx}, ${cy}) 期望 ${expectedBytes} 字节，实际 ${bytes.length} 字节`,
      )
    }
    totalBytes += bytes.length

    for (let ty = 0; ty < chunkHeight; ty++) {
      const rowStart = (cy * MAP_CHUNK_SIZE + ty) * grid.width + cx * MAP_CHUNK_SIZE
      blocked.set(bytes.subarray(ty * chunkWidth, (ty + 1) * chunkWidth), rowStart)
    }
  }

  if (totalBytes !== grid.width * grid.height) {
    throw new Error(
      `地图阻挡数据总字节数不符：期望 ${grid.width * grid.height}，实际 ${totalBytes}`,
    )
  }

  return blocked
}

/**
 * 生成地图缓存键。
 *
 * 说明：
 * - 供后续以 {id, version} 为键缓存地图运行时数据使用
 * - 版本变化（内容哈希不同）时缓存键随之变化，天然失效
 *
 * @param id 地图 id
 * @param version 地图版本号（内容哈希）
 * @returns 缓存键（格式 `${id}:${version}`）
 */
export function makeMapCacheKey(id: string, version: string): string {
  return `${id}:${version}`
}
