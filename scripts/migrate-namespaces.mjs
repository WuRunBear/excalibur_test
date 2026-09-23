#!/usr/bin/env node
/**
 * migrate-namespaces.mjs —— 存量数据迁入 per-game 命名空间（T2.6）。
 *
 * 迁移内容（docs/multi-game-plan.md §4 T2.6 八步流程）：
 *   server/workspaces/<uuid>          → server/workspaces/<gameId>/<uuid>
 *   server/backups/<stamp>            → server/backups/<gameId>/<stamp>
 *   server/workspaces/.active-workspace.json (v1 {id})
 *                                     → server/workspaces/<gameId>/.active-workspace.json (v2 {version:2,gameId,id})
 *
 * 八步映射：
 *   1 前置检查   —— 管理后端已停止 + 磁盘余量 > 2×(workspaces+backups 体积)。
 *                  注：applyService 的互斥锁是**进程内标志**（applyService.ts 的 busy
 *                  字段，Node 单线程 check-and-set），跨进程不可观测——本脚本以
 *                  "ADMIN_PORT 无监听"作为等价防线（部署窗口第 2 步本就要求停
 *                  admin；停机后 busy 恒为 false）。
 *   2 快照       —— cp -a 语义整树拷贝到 <snapshot-dir>/mig-<ts>/（fs.cpSync
 *                  recursive + preserveTimestamps）。快照是唯一回滚来源，脚本
 *                  绝不自动清理。
 *   3 迁移前指纹 —— 每个 <uuid>/game/ 用 workspaceService.describeDir（与工作区
 *                  基线同款 sha256 清单算法，直接 import 服务层复用、不复制算法）
 *                  写入 migration-report.json；备份另记 manifest.json sha256。
 *   4 移动       —— fs.rename 同文件系统原子移动进 <gameId>/；失败（如目标重名）
 *                  → 原位改名 <name>.legacy-<ts> 保留（步骤 8 策略），计入报告。
 *   5 active v2  —— 读现有 .active-workspace.json 确认真实形状后，把 v2 写到
 *                  <gameId>/.active-workspace.json（T2.4 workspaceService 的读取
 *                  位置）；旧扁平位置的 v1 原文件**保留不删**（脚本绝不删除任何
 *                  东西，浸泡期后人工清理）。
 *   6 备份核实   —— 逐个 backups 下各 stamp 目录的 manifest.json 检查 files[].path 是否绝对路径
 *                  （执行时第一步核实项：applyService 写入的是工作区相对路径；
 *                  相对 → 无需重写；绝对 → 能对 --game-configs-dir 归约则批量
 *                  重写为相对，否则标 unresolvable 并阻断 OK）。
 *   7 迁移后指纹 —— 重算全部 game/ 指纹与第 3 步逐一比对 + 备份 manifest hash
 *                  比对（被重写过的 manifest 以重写为预期、跳过 hash 比对），
 *                  全部相等才打印 MIGRATION OK。
 *   8 残留策略   —— 移动失败的原位 .legacy-<ts> 保留；无失败不创建任何 legacy；
 *                  快照/legacy/旧 v1 active 文件均保留 ≥1 发布周期，删除是人工动作。
 *
 * 幂等/防重入：已迁移（无待迁移条目且 v2 active 就位）→ 明确提示"不重复迁移"
 * 并退出 0；部分迁移（中途失败后重跑）→ 只迁移剩余条目。
 *
 * 用法（必须在仓库根，用 tsx 运行以加载服务层 TS 模块）：
 *   pnpm exec tsx scripts/migrate-namespaces.mjs [options]
 * options:
 *   --workspaces-root <dir>   缺省 <repo>/server/workspaces
 *   --backups-root <dir>      缺省 <repo>/server/backups
 *   --registry <file>         缺省 <repo>/server/games/registry.json（取 isDefault 游戏）
 *   --game-id <id>            显式指定目标 gameId（缺省 registry 的 isDefault entry）
 *   --game-configs-dir <dir>  备份绝对路径归约基准（缺省 defaultGameContext.gameConfigsDir）
 *   --snapshot-dir <dir>      快照父目录（缺省 /tmp/opencode）
 *   --admin-port <port>       管理后端端口探测（缺省 3100）
 *   --skip-admin-check        跳过管理后端停止检查（演练注入 /tmp 根时使用：
 *                             演练对象是只读副本，线上 admin 与其无并发写）
 *   --dry-run                 只做检查/扫描/打印计划，不快照不移动不写任何文件
 *
 * 退出码：0 MIGRATION OK（或幂等跳过/dry-run）；1 移动后指纹不一致；
 *         2 前置检查/参数失败；3 INCOMPLETE（存在 legacy 残留或 unresolvable 路径）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// 服务层复用（T2.4 产物）：describeDir = 与工作区基线同款 sha256 清单算法。
// .mjs 无法被裸 node 加载 TS——须用 tsx 运行（见头注释）。
// ---------------------------------------------------------------------------
let workspaceService
let readRegistry
let defaultGameContext
try {
  const wsMod = await import(new URL('../server/src/services/workspaceService.js', import.meta.url).href)
  const regMod = await import(new URL('../server/src/games/registry.js', import.meta.url).href)
  const ctxMod = await import(new URL('../server/src/gameContext.js', import.meta.url).href)
  workspaceService = wsMod.workspaceService
  readRegistry = regMod.readRegistry
  defaultGameContext = ctxMod.defaultGameContext
} catch (err) {
  console.error('[migrate] 服务层模块加载失败（本脚本须在仓库根以 tsx 运行）：')
  console.error('  pnpm exec tsx scripts/migrate-namespaces.mjs')
  console.error(`  原因: ${err instanceof Error ? err.message : err}`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    'workspaces-root': { type: 'string' },
    'backups-root': { type: 'string' },
    registry: { type: 'string' },
    'game-id': { type: 'string' },
    'game-configs-dir': { type: 'string' },
    'snapshot-dir': { type: 'string' },
    'admin-port': { type: 'string', default: '3100' },
    'skip-admin-check': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: true,
})

const workspacesRoot = path.resolve(values['workspaces-root'] ?? path.join(REPO_ROOT, 'server', 'workspaces'))
const backupsRoot = path.resolve(values['backups-root'] ?? path.join(REPO_ROOT, 'server', 'backups'))
const registryPath = path.resolve(values.registry ?? path.join(REPO_ROOT, 'server', 'games', 'registry.json'))
const snapshotParent = path.resolve(values['snapshot-dir'] ?? '/tmp/opencode')
const adminPort = Number(values['admin-port'])
const dryRun = values['dry-run'] === true

const BACKUP_ID_RE = /^\d{8}-\d{6}-[A-Za-z0-9]{4}$/ // 与 applyService.listBackups 同款白名单
const LEGACY_MARK = '.legacy-' // 保留标记：带标记的条目不再迁移（步骤 8 策略）
const now = new Date()
const runStamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}` +
  `-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`

const report = {
  script: 'scripts/migrate-namespaces.mjs',
  startedAt: new Date().toISOString(),
  dryRun,
  roots: { workspacesRoot, backupsRoot, registryPath },
  checks: {},
  gameId: null,
  snapshotDir: null,
  workspaces: [],
  backups: [],
  active: {},
  manifests: { checked: 0, withRelativePaths: 0, rewritten: 0, unresolvable: [] },
  fingerprints: { pre: {}, post: {}, mismatches: [] },
  legacy: [],
  leftovers: [],
  verdict: null,
  finishedAt: null,
}

const say = (...a) => console.log(...a)
const warn = (...a) => console.warn('  ⚠', ...a)
const die = (code, ...a) => {
  console.error('  ✗', ...a)
  report.verdict = 'ABORTED'
  report.finishedAt = new Date().toISOString()
  writeReport()
  process.exit(code)
}

function writeReport() {
  if (!report.snapshotDir) return // 快照未建时报告无处可写（dry-run 仅打印）
  const target = path.join(report.snapshotDir, 'migration-report.json')
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    say(`  报告已写入 ${target}`)
  } catch (err) {
    warn(`报告写盘失败: ${err instanceof Error ? err.message : err}`)
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 目录树字节数（lstat，不跟随符号链接）。 */
function treeSize(root) {
  let total = 0
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.isFile()) {
        try {
          total += fs.lstatSync(abs).size
        } catch {
          /* 消失的文件不计 */
        }
      }
    }
  }
  walk(root)
  return total
}

/** 文件系统可用字节；不可 statfs → null（调用方降级为警告）。 */
function freeBytes(target) {
  try {
    const st = fs.statfsSync(target)
    return st.bavail * st.bsize
  } catch {
    return null
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** 探测管理后端端口是否有监听（有 = 正在运行）。 */
function adminListening(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const done = (listening) => {
      socket.destroy()
      resolve(listening)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** 扫描待迁移条目（跳过隐藏/目标 gameId/legacy 标记/符号链接/非备份格式）。 */
function scanMigratable(root, backupWhitelist) {
  const dirs = []
  const skipped = []
  if (!fs.existsSync(root)) return { dirs, skipped }
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.name === report.gameId) continue // 已是命名空间目录
    if (e.name.startsWith('.') || e.name.includes(LEGACY_MARK)) continue
    if (!e.isDirectory() || e.isSymbolicLink()) {
      skipped.push(e.name + (e.isSymbolicLink() ? ' (symlink, 不跟随)' : ''))
      continue
    }
    if (backupWhitelist && !BACKUP_ID_RE.test(e.name)) {
      skipped.push(`${e.name} (不符合 backupId 格式)`)
      continue
    }
    dirs.push(e.name)
  }
  dirs.sort()
  return { dirs, skipped }
}

// ---------------------------------------------------------------------------
// 步骤 1：前置检查
// ---------------------------------------------------------------------------

say(`== migrate-namespaces（T2.6）${dryRun ? '—— DRY RUN ==' : '=='}`)
say(`workspaces: ${workspacesRoot}`)
say(`backups:    ${backupsRoot}`)
say(`registry:   ${registryPath}`)

// 目标 gameId：显式参数 > registry isDefault entry
if (values['game-id']) {
  report.gameId = values['game-id']
} else {
  let reg
  try {
    reg = readRegistry({ registryPath })
  } catch (err) {
    die(2, `registry 读取失败: ${err instanceof Error ? err.message : err}`)
  }
  const defaults = Object.entries(reg.games).filter(([, e]) => e.isDefault)
  if (defaults.length !== 1) {
    die(2, `registry 中 isDefault entry 数量为 ${defaults.length}（需恰为 1）；可用 --game-id 显式指定`)
  }
  report.gameId = defaults[0][0]
}
say(`目标 gameId: ${report.gameId}`)
if (!/^[\w-]+$/.test(report.gameId)) die(2, `非法 gameId：${report.gameId}`)

// 根目录存在性（workspaces 必须存在；backups 允许不存在=空备份域）
if (!fs.existsSync(workspacesRoot)) die(2, `workspaces 根不存在：${workspacesRoot}`)
report.checks.rootsExist = { workspaces: true, backups: fs.existsSync(backupsRoot) }

// 检查 a：管理后端已停止（busy 互斥锁跨进程不可观测，见头注释）
if (!values['skip-admin-check']) {
  const listening = await adminListening(adminPort)
  report.checks.adminStopped = !listening
  if (listening) {
    die(2, `管理后端仍在运行（127.0.0.1:${adminPort} 有监听）。apply 互斥锁是管理后端进程内标志，` +
      '跨进程不可观测——请先停止管理后端（部署窗口第 2 步）再执行迁移；' +
      '演练（迁移 /tmp 只读副本）可加 --skip-admin-check。')
  }
  say('检查 ✓ 管理后端已停止（无端口监听）')
} else {
  report.checks.adminStopped = 'skipped(--skip-admin-check)'
  warn('跳过管理后端停止检查（演练模式：迁移对象为 /tmp 只读副本，与线上 admin 无并发写）')
}

// 待迁移条目扫描（同时用于幂等判定）
const wsScan = scanMigratable(workspacesRoot, false)
const bkScan = fs.existsSync(backupsRoot) ? scanMigratable(backupsRoot, true) : { dirs: [], skipped: [] }
report.workspaces = wsScan.dirs.map((name) => ({ name, movedTo: `${report.gameId}/${name}` }))
report.backups = bkScan.dirs.map((name) => ({ name, movedTo: `${report.gameId}/${name}` }))
if (wsScan.skipped.length > 0 || bkScan.skipped.length > 0) {
  warn(`跳过的条目（不迁移）: ${[...wsScan.skipped, ...bkScan.skipped].join(', ')}`)
  report.leftovers.push(...wsScan.skipped.map((n) => `workspaces/${n}`), ...bkScan.skipped.map((n) => `backups/${n}`))
}

// active 文件现状（幂等判定 + 孤立/形状检测）
const flatActiveFile = path.join(workspacesRoot, '.active-workspace.json')
const gameActiveFile = path.join(workspacesRoot, report.gameId, '.active-workspace.json')
report.active = {
  flatFile: flatActiveFile,
  gameFile: gameActiveFile,
  flatExisted: fs.existsSync(flatActiveFile),
  gameExisted: fs.existsSync(gameActiveFile),
}
if (report.active.flatExisted) {
  try {
    report.active.flatContent = JSON.parse(fs.readFileSync(flatActiveFile, 'utf8'))
  } catch {
    report.active.flatContent = '(unparseable)'
  }
}

// 幂等/防重入：无待迁移条目且（v2 active 已就位 或 无 active 可转换）→ 明确提示退出
if (wsScan.dirs.length === 0 && bkScan.dirs.length === 0) {
  if (report.active.gameExisted || !report.active.flatExisted) {
    say(report.active.gameExisted
      ? `幂等检查：无待迁移条目且 ${report.gameId}/.active-workspace.json 已存在 → 已迁移，不重复迁移。`
      : '无待迁移条目、也无 active 文件 → 空命名空间，无可迁移内容。')
    say('OK（未做任何修改）')
    process.exit(0)
  }
  say('无待迁移目录，仅剩 active 文件转换（孤立/仅 active 场景）。')
}

// 检查 b：磁盘余量 > 2×(workspaces+backups 体积)
const wsSize = treeSize(workspacesRoot)
const bkSize = treeSize(backupsRoot)
const totalSize = wsSize + bkSize
report.checks.sizes = { workspacesBytes: wsSize, backupsBytes: bkSize, totalBytes: totalSize }
const freeTarget = freeBytes(workspacesRoot) ?? freeBytes(snapshotParent)
if (freeTarget === null) {
  warn('无法 statfs 获取磁盘余量（跳过该检查；请人工确认余量充足）')
  report.checks.freeBytes = null
} else {
  report.checks.freeBytes = freeTarget
  if (freeTarget <= 2 * totalSize) {
    die(2, `磁盘余量不足：可用 ${(freeTarget / 1024 ** 3).toFixed(2)} GB ≤ 2×数据体积 ${((2 * totalSize) / 1024 ** 3).toFixed(2)} GB`)
  }
  say(`检查 ✓ 磁盘余量 ${(freeTarget / 1024 ** 3).toFixed(2)} GB > 2×数据体积 ${((2 * totalSize) / 1024 ** 3).toFixed(2)} GB（数据共 ${(totalSize / 1024 ** 2).toFixed(2)} MB）`)
}

// dry-run：打印计划即止（不快照、不移动、不写任何文件）
if (dryRun) {
  say('\n-- DRY RUN 计划 --')
  say(`将迁移 ${wsScan.dirs.length} 个工作区 → workspaces/${report.gameId}/：`)
  for (const d of wsScan.dirs) say(`  ${d}`)
  say(`将迁移 ${bkScan.dirs.length} 个备份 → backups/${report.gameId}/：`)
  for (const d of bkScan.dirs) say(`  ${d}`)
  say(`active 文件：flat=${report.active.flatExisted ? JSON.stringify(report.active.flatContent) : '(无)'}；gameDir v2=${report.active.gameExisted ? '已存在' : '待写'}`)
  say('（未做任何修改）')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 步骤 2：快照（唯一回滚来源；绝不自动清理）
// ---------------------------------------------------------------------------
let snapshotDir = path.join(snapshotParent, `mig-${runStamp}`)
while (fs.existsSync(snapshotDir)) snapshotDir = `${snapshotDir}-x` // 防同秒碰撞
fs.mkdirSync(snapshotDir, { recursive: true })
report.snapshotDir = snapshotDir
fs.cpSync(workspacesRoot, path.join(snapshotDir, 'workspaces'), { recursive: true, preserveTimestamps: true, force: false, errorOnExist: true })
if (fs.existsSync(backupsRoot)) {
  fs.cpSync(backupsRoot, path.join(snapshotDir, 'backups'), { recursive: true, preserveTimestamps: true, force: false, errorOnExist: true })
} else {
  fs.mkdirSync(path.join(snapshotDir, 'backups'), { recursive: true }) // 空 backups 域占位
}
say(`步骤 2 ✓ 快照完成：${snapshotDir}（整树 cp -a 语义）`)

// ---------------------------------------------------------------------------
// 步骤 3：迁移前指纹（workspaceService.describeDir —— 与基线同款算法，直接复用）
// ---------------------------------------------------------------------------
for (const name of wsScan.dirs) {
  const gameDir = path.join(workspacesRoot, name, 'game')
  try {
    const desc = await workspaceService.describeDir(gameDir)
    report.fingerprints.pre[name] = { fingerprint: desc.fingerprint, fileCount: desc.fileCount }
  } catch {
    // 半成品工作区（无 game/）：仍迁移（rename 内容无关），指纹跳过并在报告标注
    report.fingerprints.pre[name] = { fingerprint: null, fileCount: null, note: 'game/ 缺失（半成品），指纹跳过' }
    warn(`工作区 ${name} 缺 game/ 目录（半成品）——仍将迁移，指纹跳过`)
  }
}
for (const name of bkScan.dirs) {
  const manifest = path.join(backupsRoot, name, 'manifest.json')
  report.fingerprints.pre[`backup:${name}`] = fs.existsSync(manifest)
    ? { fingerprint: sha256File(manifest), fileCount: null }
    : { fingerprint: null, fileCount: null, note: 'manifest.json 缺失' }
}
say(`步骤 3 ✓ 迁移前指纹：workspaces ${wsScan.dirs.length}（game/ 清单 sha256）+ backups manifest hash ${bkScan.dirs.length}`)

// ---------------------------------------------------------------------------
// 步骤 4：fs.rename 移入 <gameId>/（同文件系统原子）；失败 → 原位 .legacy-<ts>
// ---------------------------------------------------------------------------
function moveInto(root, name, kind) {
  const src = path.join(root, name)
  const dstDir = path.join(root, report.gameId)
  fs.mkdirSync(dstDir, { recursive: true })
  try {
    fs.renameSync(src, path.join(dstDir, name))
    return 'moved'
  } catch (err) {
    // 目标重名/其他异常：原位保留为 legacy（绝不删除），记录后继续
    const legacyName = `${name}.legacy-${runStamp}`
    try {
      fs.renameSync(src, path.join(root, legacyName))
      report.legacy.push({ kind, name, legacyName, reason: err instanceof Error ? err.message : String(err) })
      warn(`${kind} ${name} 移动失败（${err instanceof Error ? err.message : err}）→ 原位保留为 ${legacyName}`)
      return 'legacy'
    } catch (err2) {
      die(1, `${kind} ${name} 移动失败且 legacy 保留也失败（${err2 instanceof Error ? err2.message : err2}）——中止（快照在 ${snapshotDir}）`)
    }
  }
}

let legacyCount = 0
const movedWs = []
const movedBk = []
for (const name of wsScan.dirs) {
  if (moveInto(workspacesRoot, name, 'workspace') === 'moved') movedWs.push(name)
  else legacyCount++
}
for (const name of bkScan.dirs) {
  if (moveInto(backupsRoot, name, 'backup') === 'moved') movedBk.push(name)
  else legacyCount++
}
say(`步骤 4 ✓ 移动完成：workspaces ${movedWs.length}、backups ${movedBk.length}（legacy 保留 ${legacyCount}）`)

// ---------------------------------------------------------------------------
// 步骤 5：active 文件 v1 → v2（写到 <gameId>/.active-workspace.json，旧文件保留）
// ---------------------------------------------------------------------------
if (report.active.gameExisted) {
  say(`步骤 5 − ${report.gameId}/.active-workspace.json 已存在（此前已迁移），跳过改写`)
  report.active.action = 'skipped-already-v2'
} else if (report.active.flatExisted) {
  const parsed = report.active.flatContent
  let id = null
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (parsed.version === 2) {
      // 异常位置（flat 处的 v2）：仅当 gameId 匹配时按原 id 落位
      if (parsed.gameId === report.gameId && typeof parsed.id === 'string') id = parsed.id
      else warn(`flat 处 v2 active 的 gameId=${String(parsed.gameId)} 与目标不一致——不改写，请人工确认`)
    } else if (typeof parsed.id === 'string') {
      id = parsed.id // v1 形状 {id}
    }
  }
  if (id !== null) {
    const v2 = { version: 2, gameId: report.gameId, id }
    fs.mkdirSync(path.dirname(gameActiveFile), { recursive: true })
    const tmp = `${gameActiveFile}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(v2)}\n`, 'utf8')
    fs.renameSync(tmp, gameActiveFile)
    report.active.action = 'converted-v1-to-v2'
    report.active.v2 = v2
    say(`步骤 5 ✓ active v1 ${JSON.stringify({ id })} → v2 ${JSON.stringify(v2)}（写入 ${report.gameId}/.active-workspace.json；旧扁平文件保留未删）`)
    if (!wsScan.dirs.includes(id) && !fs.existsSync(path.join(workspacesRoot, report.gameId, id))) {
      warn(`active 指向的工作区 id=${id} 不在迁移条目中（孤立引用，按原样保留）`)
      report.active.orphan = true
    }
  } else if (report.active.action === undefined) {
    warn(`active 文件形状不可识别：${JSON.stringify(report.active.flatContent)}——不改写，请人工确认`)
    report.active.action = 'skipped-unrecognized'
  }
} else {
  say('步骤 5 − 无 active 文件（无活动工作区），跳过')
  report.active.action = 'none'
}

// ---------------------------------------------------------------------------
// 步骤 6：备份 manifest.json 路径核实（相对 → 无需重写；绝对 → 归约重写）
// ---------------------------------------------------------------------------
const gameConfigsDir = path.resolve(values['game-configs-dir'] ?? defaultGameContext.gameConfigsDir)
const rewrittenBackups = new Set()
for (const name of movedBk) {
  const manifestPath = path.join(backupsRoot, report.gameId, name, 'manifest.json')
  if (!fs.existsSync(manifestPath)) continue
  report.manifests.checked++
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    warn(`备份 ${name} manifest.json 解析失败（不改动；回滚时该条目会被服务层容错跳过）`)
    continue
  }
  if (!Array.isArray(manifest.files)) continue
  let changed = false
  let unresolvable = 0
  const files = manifest.files.map((f) => {
    if (!f || typeof f.path !== 'string' || !path.isAbsolute(f.path)) return f
    const rel = path.relative(gameConfigsDir, f.path).split(path.sep).join('/')
    if (rel === '' || rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) {
      unresolvable++
      return f
    }
    changed = true
    return { ...f, path: rel }
  })
  if (changed) {
    const tmp = `${manifestPath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify({ ...manifest, files }, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, manifestPath)
    rewrittenBackups.add(name)
    report.manifests.rewritten++
    warn(`备份 ${name}：manifest 含绝对路径，已按 ${gameConfigsDir} 归约重写为相对路径`)
  }
  if (unresolvable > 0) {
    report.manifests.unresolvable.push({ backup: name, count: unresolvable })
    warn(`备份 ${name}：${unresolvable} 条绝对路径无法对 ${gameConfigsDir} 归约——保留原样（回滚该条目会被服务层 400 拦截），请人工处理`)
  }
  if (!changed && unresolvable === 0) report.manifests.withRelativePaths++
}
if (report.manifests.rewritten === 0 && report.manifests.unresolvable.length === 0) {
  say(`步骤 6 ✓ 核实 ${report.manifests.checked} 份备份 manifest：files[].path 全部为工作区相对路径` +
    `（applyService 写入 change.path，相对 game/）→ 无需重写`)
}

// ---------------------------------------------------------------------------
// 步骤 7：迁移后指纹逐一比对
// ---------------------------------------------------------------------------
for (const name of movedWs) {
  const pre = report.fingerprints.pre[name]
  if (!pre || pre.fingerprint === null) continue // 半成品：步骤 3 已标注
  const desc = await workspaceService.describeDir(path.join(workspacesRoot, report.gameId, name, 'game'))
  report.fingerprints.post[name] = { fingerprint: desc.fingerprint, fileCount: desc.fileCount }
  if (desc.fingerprint !== pre.fingerprint || desc.fileCount !== pre.fileCount) {
    report.fingerprints.mismatches.push(name)
  }
}
for (const name of movedBk) {
  if (rewrittenBackups.has(name)) {
    // manifest 已按步骤 6 重写（hash 变化为预期行为）；files/ 内容未经任何写路径
    report.fingerprints.post[`backup:${name}`] = { fingerprint: null, fileCount: null, note: 'manifest 已重写，跳过 hash 比对' }
    continue
  }
  const pre = report.fingerprints.pre[`backup:${name}`]
  if (!pre || pre.fingerprint === null) continue
  const manifest = path.join(backupsRoot, report.gameId, name, 'manifest.json')
  const post = fs.existsSync(manifest) ? sha256File(manifest) : null
  report.fingerprints.post[`backup:${name}`] = { fingerprint: post, fileCount: null }
  if (post === null || post !== pre.fingerprint) {
    report.fingerprints.mismatches.push(`backup:${name}`)
  }
}

const fingerprintOk = report.fingerprints.mismatches.length === 0
const incomplete = legacyCount > 0 || report.manifests.unresolvable.length > 0
report.finishedAt = new Date().toISOString()

if (!fingerprintOk) {
  report.verdict = 'FINGERPRINT_MISMATCH'
  writeReport()
  console.error(`  ✗ 迁移后指纹不一致：${report.fingerprints.mismatches.join(', ')}`)
  console.error(`  快照（唯一回滚来源）：${snapshotDir}`)
  process.exit(1)
}
if (incomplete) {
  report.verdict = 'MIGRATION_INCOMPLETE'
  writeReport()
  say(`\nMIGRATION INCOMPLETE —— 指纹全部一致，但存在未迁移条目（legacy ${legacyCount} / unresolvable ${report.manifests.unresolvable.length}）；详见报告：${path.join(snapshotDir, 'migration-report.json')}`)
  process.exit(3)
}

report.verdict = 'MIGRATION_OK'
writeReport()
const wsFpCount = Object.keys(report.fingerprints.post).filter((k) => !k.startsWith('backup:')).length
say(`\nMIGRATION OK —— ${movedWs.length} 个工作区 + ${movedBk.length} 个备份已迁入 "${report.gameId}" 命名空间，` +
  `指纹逐一比对全等（workspaces ${wsFpCount} 项、backups ${movedBk.length} 项）。`)
say(`快照（保留 ≥1 发布周期，人工清理）：${snapshotDir}`)
if (report.active.flatExisted) {
  say(`提示：旧扁平位置 v1 active 文件保留未删（新代码只读 ${report.gameId}/.active-workspace.json），浸泡期后可人工清理。`)
}
process.exit(0)
