import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * 同步 Colyseus Schema（前后端协议）到前端工程。
 *
 * 背景：
 * - 服务端使用 schema-codegen 生成 client-schema/schema.ts
 * - 前端必须使用同一份 Schema 才能正确解码 RoomState 的增量补丁
 *
 * 做法：
 * 1. 从 ../game/src/network/colyseus/client-schema/schema.ts 拷贝到前端固定位置
 * 2. 执行 prettier --write，确保 lint（prettier --check）不会失败
 *
 * 使用方式：
 * - 在 excalibur_test 下运行：pnpm schema:sync
 */
const projectRoot = path.resolve(import.meta.dirname, '..')
const source = path.resolve(
  projectRoot,
  '..',
  'game',
  'src',
  'network',
  'colyseus',
  'client-schema',
  'schema.ts',
)
const target = path.resolve(projectRoot, 'src', 'game', 'net', 'schema.ts')

await fs.mkdir(path.dirname(target), { recursive: true })
await fs.copyFile(source, target)

const execFileAsync = promisify(execFile)
/**
 * prettier 可执行文件路径（跨平台兼容）。
 */
const prettierBin = path.resolve(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'prettier.cmd' : 'prettier',
)
await execFileAsync(prettierBin, ['--write', target], { cwd: projectRoot })
