/**
 * gameSyncService —— 游戏 导入/更新/移除 全流程服务层（T2.5）。
 *
 * 职责（docs/multi-game-plan.md §4 T2.5 / §6 Q2/Q6）：
 * - git 源导入：clone --filter=blob:none → checkout ref → rev-parse HEAD →
 *   lockfileHash（pnpm-lock.yaml sha256）→ 按需 pnpm install（Q6：默认
 *   --ignore-scripts，manifest.trustScripts=true 才放行 scripts）→ probeManifest
 *   写 <gamesDir>/<id>/game.json → upsertGame（端口池分配）→ sidecarManager
 *   invalidate → listRegistries 冒烟；任一步失败整体回滚（删 checkout 与
 *   manifest、registry 不残留）。
 * - local 源导入：不 clone、跳过 install（Q6：假定开发者自行管理依赖）；校验
 *   源目录存在且含 framework/index.ts（缺失 → 422 语义错误，信息含具体缺失项）；
 *   指纹取源目录 git rev-parse HEAD（非 git → 目录 mtime hash 并标注）。
 * - 更新 syncGame(id)：幂等重跑（git：fetch+checkout+指纹比较；local：重探测+
 *   指纹比较）；指纹没变 → no-op 返回（registry/manifest 均不写）。
 * - 移除 removeGame(id)：registry 删项 + 删 <gamesDir>/<id>/（checkout 与
 *   manifest；local 源的外部源目录**绝不动**）+ sidecar invalidate；
 *   workspaces/backups 不在本目录、天然不动。
 * - 导入中状态：isImporting(id)（供 T2.7 路由对服务调用返回 409）；并发同 id
 *   导入/同步直接抛 GameSyncError('conflict')（409 语义，模式同 ConflictError）。
 *
 * REST 状态码映射约定（T2.7 消费）：
 * - GameSyncError.bad_source / .probe_failed / .smoke_failed → 422；
 * - GameSyncError.conflict → 409（复用 instanceManager.ConflictError 的 409 冲突
 *   语义模式；不直接 import 该类——instanceManager 是 T2.4 的并行改造热区，
 *   sync 服务与其解耦更稳）；
 * - GameSyncError.not_registered → 404；
 * - GameSyncError.command_failed → 500（detail 携带 stderr 尾部）；
 * - RegistryError → registry 域既有语义（bad_game_id 400、ports_exhausted 500 等）；
 * - ManifestValidationError → 422。
 *
 * 实现注意：
 * - git/pnpm 子进程用**异步 spawn**（不用 spawnSync）：install/clone 可达分钟级，
 *   阻塞事件循环会让同进程的并发导入探测（409 路径）无法工作；
 * - 一切写盘只在 <gamesDir>/<id>/（平台自留地）与 registry.json（原子替换），
 *   local 源的外部目录零写入（R4）；
 * - 冒烟后 client.stop() 把 driver 收干净（下次 RPC lazy 重启，不留孤儿）。
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { DEFAULT_GAMES_DIR, manifestPathFor } from '../gameContext.js'
import { probeManifest } from '../games/manifest.js'
import {
  getGame,
  removeGame,
  resolveLocalGamePath,
  upsertGame,
  type GameRegistryEntry,
  type GameSource,
  type LocalGameSource,
} from '../games/registry.js'
import { sidecarManager } from '../sidecar/manager.js'

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** sync 域错误；code → REST 状态码映射见文件头注释（T2.7 消费）。 */
export class GameSyncError extends Error {
  constructor(
    readonly code:
      | 'bad_source'
      | 'not_registered'
      | 'conflict'
      | 'command_failed'
      | 'probe_failed'
      | 'smoke_failed',
    message: string,
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'GameSyncError'
  }
}

// ---------------------------------------------------------------------------
// 类型（入参 / 进度 / 结果）
// ---------------------------------------------------------------------------

/** 导入入参：source 二选一（Q2 双源），id/name 可省略（id 缺省从 source 推导）。 */
export interface ImportGameParams {
  source: GameSource
  id?: string
  name?: string
}

/** 进度阶段（T2.10 导入对话框展示的四阶段 = clone/install/probe/smoke，另有辅助阶段）。 */
export type SyncStage =
  | 'validate'
  | 'clone'
  | 'fetch'
  | 'checkout'
  | 'fingerprint'
  | 'install'
  | 'probe'
  | 'register'
  | 'smoke'
  | 'rollback'
  | 'noop'
  | 'done'

export interface SyncProgressEvent {
  gameId: string
  stage: SyncStage
  message: string
}

/** 冒烟结果（五类注册表计数；与 listRegistries 结果键一致）。 */
export interface SmokeCounts {
  systems: number
  archetypes: number
  actions: number
  components: number
  mapGenerators: number
}

export interface GameSyncResult {
  gameId: string
  action: 'imported' | 'updated' | 'noop'
  /** 最近 commit（git 源=平台 clone 的 HEAD；local 源=源目录 HEAD 或 mtime hash 标注值）。 */
  commit: string
  lockfileHash: string
  /** 指纹来源：git=平台 clone；git-head=local 源 git HEAD；dir-mtime=local 非 git 回退。 */
  fingerprintSource: 'git' | 'git-head' | 'dir-mtime'
  ports?: { official: number; preview: number }
  /** 本次是否实际执行了 pnpm install（git 源）。 */
  installRan: boolean
  smoke?: SmokeCounts
  notes: string[]
}

/** 可注入路径与进度回调（测试用 /tmp 路径；CLI 接 onProgress 打印阶段）。 */
export interface GameSyncOptions {
  registryPath?: string
  gamesDir?: string
  onProgress?: (event: SyncProgressEvent) => void
}

// ---------------------------------------------------------------------------
// 导入中状态跟踪（并发同 id → 409；模块级共享，跨实例语义一致）
// ---------------------------------------------------------------------------

const busyIds = new Set<string>()

/** 该游戏是否正在导入/同步（T2.7 路由层对服务调用返回 409 的判定源）。 */
export function isImporting(gameId: string): boolean {
  return busyIds.has(gameId)
}

// ---------------------------------------------------------------------------
// 超时与常量
// ---------------------------------------------------------------------------

/** git 短操作（checkout / rev-parse / local 源指纹）。 */
const GIT_SHORT_TIMEOUT_MS = 120_000
/** git fetch（更新流）。 */
const GIT_FETCH_TIMEOUT_MS = 5 * 60_000
/** git clone（blobless，含网络）。 */
const GIT_CLONE_TIMEOUT_MS = 15 * 60_000
/** pnpm install（可达数分钟）。 */
const INSTALL_TIMEOUT_MS = 15 * 60_000
/** 冒烟 RPC：首探含 driver spawn + framework 自举，放宽到 60s（§0.2 默认 15s 的显式覆盖）。 */
const SMOKE_TIMEOUT_MS = 60_000

const GAME_ID_RE = /^[\w-]+$/

// ---------------------------------------------------------------------------
// 子进程 runner（异步；错误归一为 GameSyncError.command_failed，detail=stderr 尾部）
// ---------------------------------------------------------------------------

interface RunOptions {
  cwd: string
  timeoutMs: number
  label: string
  /** 追加环境变量（如 CI=1 让 pnpm 非交互）。 */
  envAdd?: Record<string, string>
}

interface RunOk {
  stdout: string
  stderr: string
}

function tail(text: string, max = 1500): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`
}

function run(command: string, args: readonly string[], opts: RunOptions): Promise<RunOk> {
  return new Promise<RunOk>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let done = false
    const child = spawn(command, [...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.envAdd },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try {
        child.kill('SIGKILL')
      } catch {
        // 进程已消失
      }
      reject(new GameSyncError('command_failed', `${opts.label} 超时（>${opts.timeoutMs}ms，已 SIGKILL）`))
    }, opts.timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < 1_000_000) stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 1_000_000) stderr += chunk
    })
    child.on('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(new GameSyncError('command_failed', `${opts.label} 无法启动（${command}）: ${err.message}`))
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(
        new GameSyncError(
          'command_failed',
          `${opts.label} 失败（exit ${code}）: ${tail(stderr) || '(无 stderr)'}`,
          tail(stderr),
        ),
      )
    })
  })
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function emitOf(gameId: string, options: GameSyncOptions): (stage: SyncStage, message: string) => void {
  return (stage, message) => options.onProgress?.({ gameId, stage, message })
}

function assertGameId(gameId: string): void {
  if (typeof gameId !== 'string' || !GAME_ID_RE.test(gameId) || gameId.length > 64) {
    throw new GameSyncError(
      'bad_source',
      `非法 gameId：${JSON.stringify(gameId)}（需匹配 /^[\\w-]+$/ 且长度 ≤ 64）`,
    )
  }
}

/** id 缺省时从 source 推导（git=URL 末段去 .git；local=目录名）。 */
function deriveGameIdFromSource(source: GameSource): string {
  const raw =
    source.type === 'git'
      ? (source.url.replace(/\/+$/, '').split('/').pop() ?? '')
      : path.basename(source.path)
  const cleaned = raw
    .replace(/\.git$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!cleaned) {
    throw new GameSyncError('bad_source', `无法从 source 推导 gameId（raw=${JSON.stringify(raw)}），请显式传 id`)
  }
  return cleaned
}

function assertSourceShape(source: GameSource): void {
  if (typeof source !== 'object' || source === null) {
    throw new GameSyncError('bad_source', 'source 需为对象（{ type:"git", url, ref } 或 { type:"local", path }）')
  }
  if (source.type === 'git') {
    if (typeof source.url !== 'string' || source.url.trim().length === 0) {
      throw new GameSyncError('bad_source', 'git 源需要非空 source.url')
    }
    if (typeof source.ref !== 'string' || source.ref.trim().length === 0) {
      throw new GameSyncError('bad_source', 'git 源需要非空 source.ref（分支/标签/commit）')
    }
    return
  }
  if (source.type === 'local') {
    if (typeof source.path !== 'string' || source.path.trim().length === 0) {
      throw new GameSyncError('bad_source', 'local 源需要非空 source.path')
    }
    return
  }
  throw new GameSyncError('bad_source', `source.type 需为 'git' | 'local'`)
}

function hashFileSha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** pnpm-lock.yaml 的 sha256；缺失 → { hash:'', present:false }（lockfileHash 记空串）。 */
function lockfileHashOf(dir: string): { hash: string; present: boolean } {
  const file = path.join(dir, 'pnpm-lock.yaml')
  if (!fs.existsSync(file)) return { hash: '', present: false }
  return { hash: hashFileSha256(file), present: true }
}

/** 目录 mtime hash（local 非 git 源的指纹回退；与 sidecar/manager.ts 同算法）。 */
function dirMtimeHash(dir: string): string {
  let mtimeMs = 0
  try {
    mtimeMs = fs.statSync(dir).mtimeMs
  } catch {
    // 不可 stat → 0（后续冒烟自会失败走回滚）
  }
  return `mtime:${createHash('sha256').update(String(mtimeMs)).digest('hex').slice(0, 16)}`
}

function readManifestRaw(manifestFile: string): string | null {
  try {
    return fs.readFileSync(manifestFile, 'utf8')
  } catch {
    return null
  }
}

/** 既有 manifest 的 trustScripts（Q6 白名单开关；缺省/解析失败一律 false）。 */
function trustScriptsOfRaw(raw: string | null): boolean {
  if (raw === null) return false
  try {
    const parsed: unknown = JSON.parse(raw)
    return (
      typeof parsed === 'object' && parsed !== null && (parsed as { trustScripts?: unknown }).trustScripts === true
    )
  } catch {
    return false
  }
}

/** 原子写文本文件：同目录临时文件 + rename（与 registry/manifest 写盘同策略）。 */
function atomicWriteFile(file: string, content: string): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    fs.writeFileSync(tmp, content, 'utf8')
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // 尽力而为
    }
    throw err
  }
}

function rmRf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function gamesDirOf(options: GameSyncOptions): string {
  return options.gamesDir ?? DEFAULT_GAMES_DIR
}

/** local 源硬校验：目录存在 + 含 framework/index.ts（缺失 → 422，信息含具体缺失项）。 */
function assertLocalSourceDir(resolvedPath: string): void {
  const missing: string[] = []
  if (!isDirectory(resolvedPath)) {
    missing.push(`源目录不存在或不是目录：${resolvedPath}`)
  } else {
    const frameworkIndex = path.join(resolvedPath, 'framework', 'index.ts')
    if (!fs.existsSync(frameworkIndex)) {
      missing.push(`缺少 framework/index.ts：${frameworkIndex}`)
    }
  }
  if (missing.length > 0) {
    throw new GameSyncError('bad_source', `local 源校验失败：${missing.join('；')}`, missing.join('\n'))
  }
}

/** local 源指纹：git HEAD 优先；非 git → 目录 mtime hash 并标注（返回 commit 与来源）。 */
async function localSourceFingerprint(
  resolvedPath: string,
): Promise<{ commit: string; source: 'git-head' | 'dir-mtime' }> {
  try {
    const r = await run('git', ['rev-parse', 'HEAD'], {
      cwd: resolvedPath,
      timeoutMs: GIT_SHORT_TIMEOUT_MS,
      label: `git rev-parse HEAD（${resolvedPath}）`,
    })
    const head = r.stdout.trim()
    if (/^[0-9a-f]{7,40}$/.test(head)) return { commit: head, source: 'git-head' }
  } catch {
    // 非 git 目录 / git 不可用 → mtime 回退
  }
  return { commit: dirMtimeHash(resolvedPath), source: 'dir-mtime' }
}

/**
 * probe manifest 并原子写盘 <gamesDir>/<id>/game.json（探测失败 → 422 语义）。
 * 返回 manifest 供后续使用。
 */
function probeAndWriteManifest(
  gameId: string,
  probeDir: string,
  manifestFile: string,
): void {
  const probe = probeManifest(probeDir, { id: gameId })
  if (!probe.ok) {
    const detail = probe.errors.map((e) => `${e.path.length > 0 ? e.path.join('.') : '(root)'}: ${e.message}`).join('; ')
    throw new GameSyncError('probe_failed', `manifest 探测失败（${probeDir}）: ${detail}`, detail)
  }
  atomicWriteFile(manifestFile, `${JSON.stringify(probe.manifest, null, 2)}\n`)
}

/**
 * install 决策与执行（Q6）：lockfileHash 变化或 node_modules 缺失（首装）才跑；
 * trustScripts=true（既有 manifest）→ 允许 scripts，否则 --ignore-scripts。
 * 返回是否实际执行。
 */
async function maybeInstall(
  gameId: string,
  dir: string,
  prevLockfileHash: string,
  prevManifestRaw: string | null,
  notes: string[],
  emit: (stage: SyncStage, message: string) => void,
): Promise<boolean> {
  const lockfile = lockfileHashOf(dir)
  const hasNodeModules = isDirectory(path.join(dir, 'node_modules'))
  if (hasNodeModules && lockfile.hash === prevLockfileHash) {
    notes.push('lockfile 指纹未变化且 node_modules 已存在：跳过 pnpm install')
    return false
  }
  const trust = trustScriptsOfRaw(prevManifestRaw)
  // --ignore-workspace 必需：checkout 物理嵌套在平台仓内（server/games/<id>/checkout），
  // 且游戏仓自带 packages-less 的 pnpm-workspace.yaml —— 不忽略 workspace 时 pnpm
  // 要么报 "packages field missing or empty"，要么被平台根 workspace 收编而装错依赖。
  // 忽略后 checkout 作为独立项目安装（Q6 语义不变）。
  const args = trust ? ['install', '--ignore-workspace'] : ['install', '--ignore-scripts', '--ignore-workspace']
  emit('install', `pnpm ${args.join(' ')}（trustScripts=${trust}）…`)
  await run('pnpm', args, {
    cwd: dir,
    timeoutMs: INSTALL_TIMEOUT_MS,
    label: `pnpm install（${gameId}）`,
    envAdd: { CI: '1' },
  })
  notes.push(
    trust
      ? 'trustScripts=true：pnpm install 放行 scripts（Q6 白名单）'
      : 'pnpm install --ignore-scripts（Q6 默认：scripts 未放行）',
  )
  if (!lockfile.present) notes.push('仓库无 pnpm-lock.yaml：lockfileHash 记空串')
  return true
}

/**
 * 冒烟：sidecarManager.forGame(id) → listRegistries → 五类计数；无论成败
 * finally 里 client.stop() 收干净 driver（下次 RPC lazy 重启）。
 */
async function smokeRegistries(gameId: string, options: GameSyncOptions): Promise<SmokeCounts> {
  const client = sidecarManager.forGame(gameId, {
    registryPath: options.registryPath,
    gamesDir: options.gamesDir,
  })
  try {
    const regs = await client.listRegistries(SMOKE_TIMEOUT_MS)
    const counts: SmokeCounts = {
      systems: regs.systems.length,
      archetypes: regs.archetypes.length,
      actions: regs.actions.length,
      components: Object.keys(regs.components).length,
      mapGenerators: regs.mapGenerators.length,
    }
    if (counts.systems === 0) {
      throw new GameSyncError(
        'smoke_failed',
        `冒烟失败：listRegistries 返回 systems 为空（${JSON.stringify(counts)}）——game 配置不完整或 framework 不可用`,
      )
    }
    return counts
  } catch (err) {
    if (err instanceof GameSyncError) throw err
    throw new GameSyncError('smoke_failed', `冒烟失败（listRegistries）: ${(err as Error).message}`)
  } finally {
    client.stop()
  }
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class GameSyncService {
  /** 该游戏是否正在导入/同步。 */
  isImporting(gameId: string): boolean {
    return isImporting(gameId)
  }

  // -------------------------------------------------------------------------
  // 导入（git / local 双源，Q2）
  // -------------------------------------------------------------------------

  /**
   * 导入新游戏。任一步失败整体回滚：
   * - git 源：删 <gamesDir>/<id>/checkout、删已写 manifest、registry 无残留；
   * - local 源：删已写 manifest、registry 无残留（外部源目录绝不动）。
   * 已注册 id 的重复导入 → GameSyncError('conflict')（更新请走 syncGame）。
   */
  async importGame(params: ImportGameParams, options: GameSyncOptions = {}): Promise<GameSyncResult> {
    const source = params.source
    assertSourceShape(source)
    const gameId = (params.id ?? '').trim() || deriveGameIdFromSource(source)
    assertGameId(gameId)
    const emit = emitOf(gameId, options)

    if (busyIds.has(gameId)) {
      throw new GameSyncError('conflict', `游戏 ${gameId} 正在导入/同步中（isImporting=true），请稍后再试`)
    }
    if (getGame(gameId, { registryPath: options.registryPath })) {
      throw new GameSyncError('conflict', `游戏已注册：${gameId}（重复导入；如需更新请使用 syncGame）`)
    }
    busyIds.add(gameId)

    const registryPath = options.registryPath
    const gamesDir = gamesDirOf(options)
    const gameDir = path.join(gamesDir, gameId)
    const manifestFile = manifestPathFor(gameId, { gamesDir })
    const notes: string[] = []
    let entryWritten = false

    try {
      let commit = ''
      let lockfileHash = ''
      let fingerprintSource: GameSyncResult['fingerprintSource'] = 'git'
      let installRan = false
      let probeDir: string

      if (source.type === 'git') {
        const checkoutDir = path.join(gameDir, 'checkout')
        emit('clone', `git clone --filter=blob:none ${source.url} → ${checkoutDir}`)
        fs.mkdirSync(gameDir, { recursive: true })
        rmRf(checkoutDir) // 清掉历史失败残留，保证 clone 目标干净
        await run('git', ['clone', '--filter=blob:none', source.url, checkoutDir], {
          cwd: gameDir,
          timeoutMs: GIT_CLONE_TIMEOUT_MS,
          label: `git clone --filter=blob:none（${gameId}）`,
        })
        emit('checkout', `git checkout ${source.ref}`)
        await run('git', ['checkout', source.ref], {
          cwd: checkoutDir,
          timeoutMs: GIT_SHORT_TIMEOUT_MS,
          label: `git checkout ${source.ref}（${gameId}）`,
        })
        emit('fingerprint', '解析 HEAD commit 与 lockfile 指纹')
        const head = await run('git', ['rev-parse', 'HEAD'], {
          cwd: checkoutDir,
          timeoutMs: GIT_SHORT_TIMEOUT_MS,
          label: `git rev-parse HEAD（${gameId}）`,
        })
        commit = head.stdout.trim()
        fingerprintSource = 'git'
        installRan = await maybeInstall(gameId, checkoutDir, '', readManifestRaw(manifestFile), notes, emit)
        lockfileHash = lockfileHashOf(checkoutDir).hash // install 后重取（install 可能触碰 lockfile）
        probeDir = checkoutDir
      } else {
        // local 源：不 clone、跳过 install（Q6）
        const resolvedPath = resolveLocalGamePath(source as LocalGameSource)
        emit('validate', `校验 local 源目录：${resolvedPath}`)
        assertLocalSourceDir(resolvedPath)
        emit('fingerprint', '解析源目录指纹（git HEAD 优先，非 git 回退 mtime hash）')
        const fp = await localSourceFingerprint(resolvedPath)
        commit = fp.commit
        fingerprintSource = fp.source
        if (fp.source === 'dir-mtime') {
          notes.push('源目录不是 git 仓库（或 rev-parse 失败）：指纹退化为目录 mtime hash 并标注（dir-mtime）')
        }
        const lockfile = lockfileHashOf(resolvedPath)
        lockfileHash = lockfile.hash
        if (!lockfile.present) notes.push('源目录无 pnpm-lock.yaml：lockfileHash 记空串')
        notes.push('local 源跳过 pnpm install（Q6：假定开发者自行管理依赖）')
        probeDir = resolvedPath
      }

      emit('probe', `probeManifest(${probeDir}) → ${manifestFile}`)
      probeAndWriteManifest(gameId, probeDir, manifestFile)

      emit('register', `upsertGame(${gameId}）——端口池分配并持久化`)
      const now = new Date().toISOString()
      const entry = upsertGame(
        gameId,
        {
          name: (params.name ?? '').trim() || gameId,
          isDefault: false, // 导入流不产生默认游戏（isDefault 由 PATCH/播种管理）
          source,
          resolved: { commit, syncedAt: now, lockfileHash },
          createdAt: now,
          // ports 省略 → 端口池 first-fit 分配并随本次写入落盘
        },
        { registryPath },
      )
      entryWritten = true
      emit('register', `ports official=${entry.ports.official} preview=${entry.ports.preview}`)

      // 指纹已写入 registry：显式失效 manager/gameContext 缓存，再 warm 冒烟
      sidecarManager.invalidate(gameId, { registryPath, gamesDir })
      emit('smoke', 'listRegistries 冒烟（首探会 spawn driver）…')
      const smoke = await smokeRegistries(gameId, options)
      emit('smoke', `冒烟通过: systems=${smoke.systems} archetypes=${smoke.archetypes} actions=${smoke.actions} components=${smoke.components} mapGenerators=${smoke.mapGenerators}`)

      const result: GameSyncResult = {
        gameId,
        action: 'imported',
        commit,
        lockfileHash,
        fingerprintSource,
        ports: entry.ports,
        installRan,
        smoke,
        notes,
      }
      emit('done', `导入完成：${gameId}`)
      return result
    } catch (err) {
      emit('rollback', `导入失败，回滚: ${(err as Error).message}`)
      try {
        if (entryWritten) removeGame(gameId, { registryPath })
      } catch {
        // 回滚尽力而为，不掩盖原错误
      }
      try {
        if (source.type === 'git') rmRf(path.join(gameDir, 'checkout')) // 先删 checkout
        fs.rmSync(manifestFile, { force: true })
        fs.rmdirSync(gameDir) // 空（git 源）则删净；local 源此时也应为空
      } catch {
        // 尽力而为
      }
      try {
        sidecarManager.invalidate(gameId, { registryPath, gamesDir })
      } catch {
        // 尽力而为
      }
      throw err
    } finally {
      busyIds.delete(gameId)
    }
  }

  // -------------------------------------------------------------------------
  // 更新（幂等重跑）
  // -------------------------------------------------------------------------

  /**
   * 幂等更新：git 源 fetch+checkout+指纹比较；local 源重探测+指纹比较。
   * 指纹没变 → no-op（registry/manifest 均不写）。变化则走
   * install(按需) → probe → upsert（保留 name/isDefault/ports/createdAt）→
   * 冒烟；失败恢复旧 registry entry 与旧 manifest（git 源尽力 checkout 回旧 commit）。
   */
  async syncGame(gameId: string, options: GameSyncOptions = {}): Promise<GameSyncResult> {
    assertGameId(gameId)
    const emit = emitOf(gameId, options)
    const registryPath = options.registryPath
    const gamesDir = gamesDirOf(options)
    const manifestFile = manifestPathFor(gameId, { gamesDir })

    const entry = getGame(gameId, { registryPath })
    if (!entry) {
      throw new GameSyncError('not_registered', `游戏未注册：${gameId}（registry: ${registryPath ?? '(默认路径)'}）`)
    }
    if (busyIds.has(gameId)) {
      throw new GameSyncError('conflict', `游戏 ${gameId} 正在导入/同步中（isImporting=true），请稍后再试`)
    }
    busyIds.add(gameId)

    const notes: string[] = []
    const prevManifestRaw = readManifestRaw(manifestFile)
    let entryWritten = false
    let manifestWritten = false
    let coldClone = false // sync 中因 checkout 缺失而全量 clone（失败时需清掉）

    try {
      if (entry.source.type === 'git') {
        const checkoutDir = path.join(gamesDir, gameId, 'checkout')
        const prevCommit = entry.resolved.commit
        if (!isDirectory(checkoutDir)) {
          coldClone = true
          emit('clone', `checkout 缺失，全量重新 clone → ${checkoutDir}`)
          fs.mkdirSync(path.dirname(checkoutDir), { recursive: true })
          rmRf(checkoutDir)
          await run('git', ['clone', '--filter=blob:none', entry.source.url, checkoutDir], {
            cwd: path.dirname(checkoutDir),
            timeoutMs: GIT_CLONE_TIMEOUT_MS,
            label: `git clone --filter=blob:none（${gameId}，冷同步）`,
          })
        } else {
          emit('fetch', `git fetch origin（ref=${entry.source.ref}）`)
          await run('git', ['fetch', 'origin', '--prune'], {
            cwd: checkoutDir,
            timeoutMs: GIT_FETCH_TIMEOUT_MS,
            label: `git fetch（${gameId}）`,
          })
        }
        emit('checkout', `git checkout ${entry.source.ref}`)
        await run('git', ['checkout', entry.source.ref], {
          cwd: checkoutDir,
          timeoutMs: GIT_SHORT_TIMEOUT_MS,
          label: `git checkout ${entry.source.ref}（${gameId}）`,
        })
        emit('fingerprint', '解析 HEAD commit 与 lockfile 指纹并比较')
        const head = await run('git', ['rev-parse', 'HEAD'], {
          cwd: checkoutDir,
          timeoutMs: GIT_SHORT_TIMEOUT_MS,
          label: `git rev-parse HEAD（${gameId}）`,
        })
        const commit = head.stdout.trim()
        const hashBefore = lockfileHashOf(checkoutDir).hash
        const unchanged =
          commit === entry.resolved.commit &&
          hashBefore === entry.resolved.lockfileHash &&
          isDirectory(path.join(checkoutDir, 'node_modules'))
        if (unchanged) {
          emit('noop', '指纹未变化 → no-op（registry/manifest 均未写）')
          return {
            gameId,
            action: 'noop',
            commit,
            lockfileHash: hashBefore,
            fingerprintSource: 'git',
            installRan: false,
            notes: [...notes, '指纹未变化：no-op'],
          }
        }
        const installRan = await maybeInstall(gameId, checkoutDir, entry.resolved.lockfileHash, prevManifestRaw, notes, emit)
        const lockfileHash = lockfileHashOf(checkoutDir).hash
        emit('probe', `probeManifest(${checkoutDir}) → ${manifestFile}`)
        probeAndWriteManifest(gameId, checkoutDir, manifestFile)
        manifestWritten = true
        emit('register', `upsertGame(${gameId}）——保留 name/isDefault/ports/createdAt`)
        upsertGame(
          gameId,
          {
            name: entry.name,
            isDefault: entry.isDefault,
            source: entry.source,
            resolved: { commit, syncedAt: new Date().toISOString(), lockfileHash },
            ports: entry.ports,
            createdAt: entry.createdAt,
          },
          { registryPath },
        )
        entryWritten = true
        sidecarManager.invalidate(gameId, { registryPath, gamesDir })
        emit('smoke', 'listRegistries 冒烟…')
        const smoke = await smokeRegistries(gameId, options)
        emit('smoke', `冒烟通过: systems=${smoke.systems}`)
        const result: GameSyncResult = {
          gameId,
          action: 'updated',
          commit,
          lockfileHash,
          fingerprintSource: 'git',
          ports: entry.ports,
          installRan,
          smoke,
          notes,
        }
        emit('done', `更新完成：${gameId}`)
        return result
      }

      // ---- local 源：重探测 + 指纹比较 ----
      const resolvedPath = resolveLocalGamePath(entry.source)
      emit('validate', `校验 local 源目录：${resolvedPath}`)
      assertLocalSourceDir(resolvedPath) // 缺失 → 422，registry 不动
      emit('fingerprint', '重取源目录指纹并比较')
      const fp = await localSourceFingerprint(resolvedPath)
      const lockfile = lockfileHashOf(resolvedPath)
      const unchanged = fp.commit === entry.resolved.commit && lockfile.hash === entry.resolved.lockfileHash
      if (unchanged) {
        emit('noop', '指纹未变化 → no-op（registry/manifest 均未写）')
        return {
          gameId,
          action: 'noop',
          commit: fp.commit,
          lockfileHash: lockfile.hash,
          fingerprintSource: fp.source,
          installRan: false,
          notes: [...notes, '指纹未变化：no-op'],
        }
      }
      emit('probe', `probeManifest(${resolvedPath}) → ${manifestFile}`)
      probeAndWriteManifest(gameId, resolvedPath, manifestFile)
      manifestWritten = true
      emit('register', `upsertGame(${gameId}）——保留 name/isDefault/ports/createdAt`)
      upsertGame(
        gameId,
        {
          name: entry.name,
          isDefault: entry.isDefault,
          source: entry.source,
          resolved: { commit: fp.commit, syncedAt: new Date().toISOString(), lockfileHash: lockfile.hash },
          ports: entry.ports,
          createdAt: entry.createdAt,
        },
        { registryPath },
      )
      entryWritten = true
      sidecarManager.invalidate(gameId, { registryPath, gamesDir })
      emit('smoke', 'listRegistries 冒烟…')
      const smoke = await smokeRegistries(gameId, options)
      emit('smoke', `冒烟通过: systems=${smoke.systems}`)
      const result: GameSyncResult = {
        gameId,
        action: 'updated',
        commit: fp.commit,
        lockfileHash: lockfile.hash,
        fingerprintSource: fp.source,
        ports: entry.ports,
        installRan: false,
        smoke,
        notes,
      }
      emit('done', `更新完成：${gameId}`)
      return result
    } catch (err) {
      emit('rollback', `同步失败，恢复原状: ${(err as Error).message}`)
      // registry：恢复旧 entry（含旧端口与旧指纹）
      try {
        if (entryWritten) upsertGame(gameId, entry, { registryPath })
      } catch {
        // 尽力而为
      }
      // manifest：恢复旧内容（没有旧文件则删除，下次 forGame 会重探测）
      try {
        if (manifestWritten) {
          if (prevManifestRaw !== null) atomicWriteFile(manifestFile, prevManifestRaw)
          else fs.rmSync(manifestFile, { force: true })
        }
      } catch {
        // 尽力而为
      }
      // git 源：尽力 checkout 回旧 commit（保持 checkout 与 registry 一致）
      if (entry.source.type === 'git' && entry.resolved.commit !== '') {
        try {
          await run('git', ['checkout', '--force', entry.resolved.commit], {
            cwd: path.join(gamesDir, gameId, 'checkout'),
            timeoutMs: GIT_SHORT_TIMEOUT_MS,
            label: `git checkout --force ${entry.resolved.commit.slice(0, 12)}（${gameId}，回滚）`,
          })
        } catch {
          // 尽力而为：checkout 保留在新 ref，下次 sync 重试
        }
      }
      if (coldClone) {
        try {
          rmRf(path.join(gamesDir, gameId, 'checkout'))
        } catch {
          // 尽力而为
        }
      }
      try {
        sidecarManager.invalidate(gameId, { registryPath, gamesDir })
      } catch {
        // 尽力而为
      }
      throw err
    } finally {
      busyIds.delete(gameId)
    }
  }

  // -------------------------------------------------------------------------
  // 移除
  // -------------------------------------------------------------------------

  /**
   * 移除游戏：registry 删项 + 删 <gamesDir>/<id>/（git 源含整个 checkout；
   * local 源仅 manifest——**外部源目录绝不动**）+ sidecar/gameContext 缓存失效。
   * workspaces/backups 在别的目录树，天然不动。
   */
  removeGame(gameId: string, options: GameSyncOptions = {}): { gameId: string; action: 'removed'; notes: string[] } {
    assertGameId(gameId)
    const registryPath = options.registryPath
    const gamesDir = gamesDirOf(options)
    const entry = getGame(gameId, { registryPath })
    if (!entry) {
      throw new GameSyncError('not_registered', `游戏未注册：${gameId}（registry: ${registryPath ?? '(默认路径)'}）`)
    }
    const notes: string[] = [
      'workspaces/backups 不在 server/games/<id>/ 下，未做任何改动',
      entry.source.type === 'local' ? 'local 源的外部源目录未做任何改动' : 'git 源 checkout 已随 <gamesDir>/<id>/ 删除',
    ]
    if (busyIds.has(gameId)) {
      throw new GameSyncError('conflict', `游戏 ${gameId} 正在导入/同步中（isImporting=true），请稍后再试`)
    }
    removeGame(gameId, { registryPath })
    // 只删平台自留地 gamesDir/<id>；id 已过 [\w-]{1,64} 校验，无路径逃逸
    rmRf(path.join(gamesDir, gameId))
    sidecarManager.invalidate(gameId, { registryPath, gamesDir })
    options.onProgress?.({ gameId, stage: 'done', message: `移除完成：${gameId}` })
    return { gameId, action: 'removed', notes }
  }
}

/** 平台侧 sync 服务单例（T2.7 REST / CLI 共用同一逻辑）。 */
export const gameSyncService = new GameSyncService()
