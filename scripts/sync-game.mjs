#!/usr/bin/env node
/**
 * sync-game.mjs —— 游戏 导入/更新/移除 CLI（T2.5）。
 *
 * 封装 server/src/services/gameSyncService.ts 的同一逻辑（REST T2.7 亦调用该
 * 服务层），输出各阶段进度（clone / install / probe / smoke 等，带累计耗时）。
 *
 * 用法：
 *   node scripts/sync-game.mjs import --type git   --url <url> --ref <ref> [--id <id>] [--name <name>]
 *   node scripts/sync-game.mjs import --type local --path <path>          [--id <id>] [--name <name>]
 *   node scripts/sync-game.mjs sync   --id <id>
 *   node scripts/sync-game.mjs remove --id <id>
 *
 * 可选注入（测试/隔离用，默认走真实 server/games/registry.json）：
 *   --registry <path>    registry.json 路径
 *   --games-dir <dir>    games 目录（<dir>/<id>/checkout 与 <dir>/<id>/game.json）
 *
 * 说明：
 * - 相对 --path 以**平台仓库根**为基准锚定（与 registry entry 存储语义一致）；
 * - 服务层是 TS 源码：本脚本首跑时若未挂 tsx loader，会自动以
 *   `node --import tsx` 重启自身（tsx 从 server 工作区解析，绝对路径注入，
 *   与用户 cwd 无关）；
 * - 退出码：成功 0；失败 1（错误行带错误码语义，如 [422]/[409]/[404]）。
 */
/* eslint-disable no-console */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// tsx 自举：服务层是 TS 源码，普通 node 跑不了 —— 无 loader 时重启自身
// ---------------------------------------------------------------------------

const SELF_PATH = fileURLToPath(import.meta.url)

if (!process.env.SYNC_GAME_TSX_CHILD) {
  const repoRoot = path.resolve(path.dirname(SELF_PATH), '..')
  const require = createRequire(path.join(repoRoot, 'server', 'package.json'))
  let tsxEntry
  try {
    tsxEntry = require.resolve('tsx')
  } catch {
    console.error('错误: 无法解析 tsx（应存在于 server 工作区 devDependencies）。请先 pnpm install。')
    process.exit(1)
  }
  const child = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(tsxEntry).href, SELF_PATH, ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env: { ...process.env, SYNC_GAME_TSX_CHILD: '1' },
    },
  )
  process.exit(child.status ?? 1)
}

// ---- 以下逻辑运行在 tsx loader 下，可 import TS 服务层 ----

/** 进程启动时刻（阶段进度与总耗时共用；tsx 自举耗时计入总耗时）。 */
const t0 = Date.now()

const USAGE = `用法:
  node scripts/sync-game.mjs import --type git   --url <url> --ref <ref> [--id <id>] [--name <name>]
  node scripts/sync-game.mjs import --type local --path <path>          [--id <id>] [--name <name>]
  node scripts/sync-game.mjs sync   --id <id>
  node scripts/sync-game.mjs remove --id <id>

可选: --registry <path> --games-dir <dir>（测试注入；默认真实 server/games/）

示例:
  node scripts/sync-game.mjs import --type git --url git@github.com:WuRunBear/game_server_test.git --ref main --id gst-clone
  node scripts/sync-game.mjs import --type local --path ../game_server_test --id gst-local
  node scripts/sync-game.mjs sync --id gst-clone
  node scripts/sync-game.mjs remove --id gst-clone`

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        flags[key] = 'true'
      } else {
        flags[key] = value
        i++
      }
    } else {
      positional.push(arg)
    }
  }
  return { flags, positional }
}

function fail(message, hint) {
  console.error(`错误: ${message}`)
  if (hint) console.error(hint)
  process.exit(1)
}

async function main() {
  const { gameSyncService, GameSyncError } = await import('../server/src/services/gameSyncService.ts')
  const { sidecarManager } = await import('../server/src/sidecar/manager.ts')

  const { flags, positional } = parseArgs(process.argv.slice(2))
  const command = positional[0]

  if (!command || flags.help || flags.h) {
    console.log(USAGE)
    process.exit(command ? 0 : 1)
  }

  const options = {
    registryPath: flags.registry,
    gamesDir: flags['games-dir'],
    onProgress: (event) => {
      const t = ((Date.now() - t0) / 1000).toFixed(1)
      console.log(`[${t.padStart(6)}s] [${event.stage}] ${event.message}`)
    },
  }

  const exitWithError = (err) => {
    if (err instanceof GameSyncError) {
      const status = { bad_source: 422, not_registered: 404, conflict: 409, command_failed: 500, probe_failed: 422, smoke_failed: 422 }[err.code] ?? 500
      console.error(`[${status}][${err.code}] ${err.message}`)
      if (err.detail && err.detail !== err.message) console.error(`  detail: ${err.detail}`)
    } else if (err && err.name === 'RegistryError') {
      console.error(`[500][registry:${err.code}] ${err.message}`)
    } else if (err && err.name === 'ManifestValidationError') {
      console.error(`[422][manifest] ${err.message}`)
    } else {
      console.error(`[500][unexpected] ${err?.stack ?? String(err)}`)
    }
    process.exitCode = 1
  }

  try {
    if (command === 'import') {
      const type = flags.type
      const base = { id: flags.id, name: flags.name }
      let params
      if (type === 'git') {
        if (!flags.url) fail('git 源需要 --url <url>', USAGE)
        if (!flags.ref) fail('git 源需要 --ref <ref>', USAGE)
        params = { source: { type: 'git', url: flags.url, ref: flags.ref }, ...base }
      } else if (type === 'local') {
        if (!flags.path) fail('local 源需要 --path <path>', USAGE)
        params = { source: { type: 'local', path: flags.path }, ...base }
      } else {
        fail(`--type 需为 git | local（实际: ${type ?? '(缺省)'})`, USAGE)
      }
      console.log(`导入游戏: type=${type}${flags.id ? ` id=${flags.id}` : '（id 自动推导）'}`)
      const result = await gameSyncService.importGame(params, options)
      printResult(result)
      return
    }

    if (command === 'sync') {
      if (!flags.id) fail('sync 需要 --id <id>', USAGE)
      console.log(`同步游戏: id=${flags.id}`)
      const result = await gameSyncService.syncGame(flags.id, options)
      printResult(result)
      return
    }

    if (command === 'remove') {
      if (!flags.id) fail('remove 需要 --id <id>', USAGE)
      console.log(`移除游戏: id=${flags.id}`)
      const result = gameSyncService.removeGame(flags.id, options)
      console.log(`✔ 已移除 ${result.gameId}`)
      for (const note of result.notes) console.log(`  - ${note}`)
      return
    }

    fail(`未知命令: ${command}`, USAGE)
  } catch (err) {
    exitWithError(err)
  } finally {
    // 收干净本进程可能 spawn 的 driver（冒烟正常路径已在服务层 stop()，这里是兜底）
    try {
      sidecarManager.stopAll()
    } catch {
      // 尽力而为
    }
  }
}

function printResult(result) {
  const actionText = { imported: '导入', updated: '更新', noop: '同步' }[result.action] ?? result.action
  if (result.action === 'noop') {
    console.log(`✔ ${result.gameId} 指纹未变化，no-op（commit=${result.commit.slice(0, 12)}）`)
  } else {
    console.log(`✔ ${actionText}完成: ${result.gameId}`)
    console.log(`  commit       : ${result.commit}`)
    console.log(`  lockfileHash : ${result.lockfileHash || '(空, 无 pnpm-lock.yaml)'}`)
    console.log(`  指纹来源     : ${result.fingerprintSource}`)
    if (result.ports) console.log(`  ports        : official=${result.ports.official} preview=${result.ports.preview}`)
    console.log(`  install      : ${result.installRan ? '已执行' : '跳过'}`)
    if (result.smoke) {
      console.log(
        `  冒烟(五类)   : systems=${result.smoke.systems} archetypes=${result.smoke.archetypes} actions=${result.smoke.actions} components=${result.smoke.components} mapGenerators=${result.smoke.mapGenerators}`,
      )
    }
  }
  if (result.notes?.length) {
    console.log('  notes:')
    for (const note of result.notes) console.log(`    - ${note}`)
  }
  console.log(`  总耗时       : ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

await main()
