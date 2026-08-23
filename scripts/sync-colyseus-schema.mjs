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
 * 1. 从 ../game_server_test/src/network/colyseus/client-schema/schema.ts 拷贝到前端固定位置
 * 2. 修正 import 兼容性：本工程 tsconfig 开启 verbatimModuleSyntax（Vue 默认），
 *    而 schema-codegen 输出的 `DataChange` 是类型却混在值 import 里（TS1484）；
 *    机械拆成 `import type`，不触碰任何 schema 定义
 * 3. 执行 prettier --write，确保 lint（prettier --check）不会失败
 *
 * 使用方式：
 * - 在 excalibur_test 下运行：pnpm schema:sync
 */
const projectRoot = path.resolve(import.meta.dirname, '..')
const source = path.resolve(
  projectRoot,
  '..',
  'game_server_test',
  'src',
  'network',
  'colyseus',
  'client-schema',
  'schema.ts',
)
const target = path.resolve(projectRoot, 'src', 'game', 'net', 'schema.ts')

let sourceStat
try {
  sourceStat = await fs.stat(source)
} catch {
  console.warn(`[schema:sync] 源文件不存在（${source}），跳过同步（保留现有 schema.ts）`)
  process.exit(0)
}
if (!sourceStat.isFile()) {
  console.warn(`[schema:sync] 源路径不是文件（${source}），跳过同步`)
  process.exit(0)
}

await fs.mkdir(path.dirname(target), { recursive: true })
await fs.copyFile(source, target)

/**
 * schema-codegen 输出把类型（DataChange）混在值 import 中，
 * 与本工程 verbatimModuleSyntax 冲突（TS1484）——拆成 type-only import。
 * 只做文本级机械变换，不修改任何类/字段定义。
 */
{
  const content = await fs.readFile(target, 'utf8')
  const importRe = /import \{([^}]*)\} from '@colyseus\/schema'/
  const match = content.match(importRe)
  if (match) {
    const names = match[1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)
    const typeOnly = ['DataChange']
    const valueNames = names.filter((n) => !typeOnly.includes(n))
    const typeNames = names.filter((n) => typeOnly.includes(n))
    if (typeNames.length > 0) {
      const rewritten = [
        `import { ${valueNames.join(', ')} } from '@colyseus/schema'`,
        `import type { ${typeNames.join(', ')} } from '@colyseus/schema'`,
      ].join('\n')
      await fs.writeFile(target, content.replace(importRe, rewritten))
    }
  }
}

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
