/**
 * Phase 0 spike：sidecar driver 验证脚本（T0.1 mechanics / T0.3 compare）。
 *
 * 两个 phase，对同一 driver（server/sidecar/driver.ts）用两种 spawn 候选机制各起一遍
 * （cwd 均 = 本体根目录 GAME_ROOT）：
 *
 * --phase=mechanics（T0.1）
 *   逐候选输出：可用性 / spawn→pong 延迟 / driver 进程 RSS / driver 进程内 zod 版本；
 *   冒烟 listRegistries 证明 bootstrap + 五类注册表在 driver 进程内可用。
 *
 * --phase=compare（T0.3）
 *   加载 /tmp/opencode/spike/baseline.json（T0.2 由现状机制 gameBridge 进程内 import 生成），
 *   经 RPC 从 driver 采集与基线同构的五键输出并规范化对比：
 *   - registries                  ：规范化（递归按 key 排序 JSON.stringify）后字符串全等
 *   - wholeValid / wholeInvalid   ：ok 与 message 逐字段全等
 *   - geometry                    ：每张图 serialized geometry 全等（pipeline 图经 driver
 *                                   buildMapGeometry；tiled 图报错文案由平台侧流程产生，
 *                                   复刻 mapService.ts:126-128，全等比对文案）
 *   - validateFile                ：wolfValid / brokenArchetype 的 valid 与 issues 全等；
 *                                   unroutedPath（路由未命中）不做输出对比——语义决策点，
 *                                   结论见脚本末尾报告（平台侧 pattern 未命中不发 RPC；
 *                                   driver 收到未登记 kind 回 bad_request，脚本实测记录）
 *   每候选另跑机制用例（只记录行为）：未知 method、畸形行、kill -9 driver 后再发请求、
 *   连续 100 次 ping 的 p50/p95 延迟。五键原始输出落盘 /tmp/opencode/spike/driver-<n>.json
 *   供与 baseline.json 独立 diff。
 *
 * 候选 1：node --import tsx <driver>，env 注入 TSX_TSCONFIG_PATH=<GAME_ROOT>/tsconfig.json
 * 候选 2：pnpm exec tsx --tsconfig <GAME_ROOT>/tsconfig.json <driver>
 *
 * 运行方式（脚本自身用 server 的 tsx；路径全部按本文件位置解析，与 cwd 无关）：
 *   cd server && pnpm exec tsx ../scripts/spike-sidecar.mts --phase=mechanics
 *   cd server && pnpm exec tsx ../scripts/spike-sidecar.mts --phase=compare
 *
 * 本脚本只读：不写 GAME_ROOT 任何文件（R4/R1）；子进程以 detached 独立进程组
 * 启动并在结束时整组 SIGTERM/SIGKILL 清理，不留孤儿。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import * as readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')
const GAME_ROOT = path.resolve(REPO_ROOT, '..', 'game_server_test')
const DRIVER_PATH = path.join(REPO_ROOT, 'server', 'sidecar', 'driver.ts')
const SPIKE_DIR = '/tmp/opencode/spike'
const BASELINE_PATH = path.join(SPIKE_DIR, 'baseline.json')
const BROKEN_GAME_JSON = path.join(SPIKE_DIR, 'broken-game', 'game.json')
const BROKEN_ARCHETYPE_PATH = path.join(SPIKE_DIR, 'broken-archetype.json')

const PONG_TIMEOUT_MS = 90_000 // tsx 冷启动需编译整个 framework import 图
const RPC_TIMEOUT_MS = 30_000
const GEOMETRY_TIMEOUT_MS = 60_000 // §0.2：buildMapGeometry 超时 60s
const ANOMALY_TIMEOUT_MS = 10_000
const KILL_GRACE_MS = 3_000

interface Frame {
  id: number | null
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

interface PingResult {
  pong?: boolean
  zodVersion?: string
  pid?: number
  rss?: number
  gameRoot?: string
}

interface RegistriesSummary {
  systems: number
  archetypes: number
  actions: number
  components: number
  mapGenerators: number
}

interface CandidateSpec {
  label: string
  cmd: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// 规范化比较：递归按 key 排序的 JSON.stringify replacer
// ---------------------------------------------------------------------------

function sortedKeysReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )
    return Object.fromEntries(entries)
  }
  return value
}

/** 规范化字符串（递归按 key 排序），用于全等判定。 */
function canon(value: unknown): string {
  return JSON.stringify(value, sortedKeysReplacer)
}

/** 两规范化串的首处差异描述（用于报告定位）。 */
function firstDiff(a: string, b: string): string {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  const ctx = 60
  const win = (s: string): string => s.slice(Math.max(0, i - ctx), i + ctx)
  return `首差异@${i} 基线=…${win(a)}… driver=…${win(b)}…（长度 ${a.length} vs ${b.length}）`
}

/** 最近邻百分位（升序数组；p50 即下中位）。 */
function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return NaN
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1))
  return sortedAsc[idx]
}

function readServerZodVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'server', 'node_modules', 'zod', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

function preflightProblems(): string[] {
  const problems: string[] = []
  if (!fs.existsSync(path.join(GAME_ROOT, 'framework', 'index.ts'))) {
    problems.push(`GAME_ROOT 缺 framework/index.ts：${GAME_ROOT}`)
  }
  if (!fs.existsSync(path.join(GAME_ROOT, 'tsconfig.json'))) {
    problems.push(`GAME_ROOT 缺 tsconfig.json：${GAME_ROOT}`)
  }
  if (!fs.existsSync(DRIVER_PATH)) problems.push(`driver 文件不存在：${DRIVER_PATH}`)
  return problems
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

// ---------------------------------------------------------------------------
// DriverClient：单候选 spawn + NDJSON RPC 客户端（mechanics / compare 共用）
// ---------------------------------------------------------------------------

interface Pending {
  resolve: (f: Frame) => void
  timer: NodeJS.Timeout
}

class DriverClient {
  readonly spec: CandidateSpec
  /** spawn 的直接子进程（候选 1 即 driver；候选 2 为 pnpm→tsx→driver 链的根）。 */
  readonly child!: ChildProcess
  private pending = new Map<number, Pending>()
  /** stdout 上非协议帧（id 非 number 或非 JSON）的原始行；供畸形行用例与违规统计。 */
  private anomalies: string[] = []
  private anomalyWaiter: { resolve: (line: string) => void; timer: NodeJS.Timeout } | null = null
  private nextIdVal = 0
  private destroyed = false

  readonly violations: string[] = []
  readonly stderrLines: string[] = []
  exitReason: string | null = null
  spawnFailed = false
  driverPid: number | undefined
  zodVersion: string | undefined
  rssMB: number | undefined
  pongMs: number | undefined
  gameRoot: string | undefined

  private constructor(spec: CandidateSpec) {
    this.spec = spec
  }

  /** spawn → 首个 ping；失败 throw（错误信息含 stderr 末行）。 */
  static async start(spec: CandidateSpec): Promise<DriverClient> {
    const client = new DriverClient(spec)
    await client.spawnAndHandshake()
    return client
  }

  private async spawnAndHandshake(): Promise<void> {
    const t0 = Date.now()
    this.child = spawn(this.spec.cmd, this.spec.args, {
      cwd: GAME_ROOT,
      env: this.spec.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })

    this.child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) this.stderrLines.push(line)
      }
      if (this.stderrLines.length > 60) this.stderrLines.splice(0, this.stderrLines.length - 60)
    })

    this.child.on('error', (err) => {
      this.spawnFailed = true
      this.failAll(`spawn 失败: ${msg(err)}`)
    })
    this.child.on('exit', (code, signal) => {
      this.exitReason = `driver 进程提前退出 (code=${code}, signal=${signal})`
      this.failAll(this.exitReason)
    })

    const rl = readline.createInterface({ input: this.child.stdout!, crlfDelay: Infinity })
    rl.on('line', (line) => {
      let frame: Frame
      try {
        frame = JSON.parse(line) as Frame
      } catch {
        this.onAnomalousLine(line)
        return
      }
      if (typeof frame?.id !== 'number') {
        this.onAnomalousLine(line)
        return
      }
      const p = this.pending.get(frame.id)
      if (!p) {
        this.violations.push(`stdout 无法归属的帧 id=${frame.id}: ${line.slice(0, 200)}`)
        return
      }
      this.pending.delete(frame.id)
      clearTimeout(p.timer)
      p.resolve(frame)
    })

    // —— 首个 ping：spawn→pong 延迟 + zod 版本 + RSS + pid ——
    const pong = await this.request('ping', {}, PONG_TIMEOUT_MS)
    if (!pong.ok) {
      let reason = `ping 错误帧: ${pong.error?.code} ${pong.error?.message ?? ''}`
      if (this.exitReason && this.stderrLines.length) {
        reason += `；stderr 末行: ${this.stderrLines[this.stderrLines.length - 1]}`
      }
      throw new Error(reason)
    }
    const pingResult = (pong.result ?? {}) as PingResult
    if (pingResult.pong !== true) {
      throw new Error(`ping 响应形状异常: ${JSON.stringify(pingResult).slice(0, 200)}`)
    }
    this.pongMs = Date.now() - t0
    this.zodVersion = pingResult.zodVersion
    this.driverPid = pingResult.pid
    this.gameRoot = pingResult.gameRoot
    if (typeof pingResult.rss === 'number') {
      this.rssMB = Math.round((pingResult.rss / 1024 / 1024) * 10) / 10
    }
  }

  private onAnomalousLine(line: string): void {
    if (this.anomalyWaiter) {
      const w = this.anomalyWaiter
      this.anomalyWaiter = null
      clearTimeout(w.timer)
      w.resolve(line)
      return
    }
    this.anomalies.push(line)
    this.violations.push(`stdout 非协议帧: ${line.slice(0, 200)}`)
  }

  /** 等待下一行"非协议帧"stdout 输出（畸形行用例；不记为违规）。 */
  nextAnomaly(timeoutMs = ANOMALY_TIMEOUT_MS): Promise<string> {
    const buffered = this.anomalies.pop()
    if (buffered !== undefined) return Promise.resolve(buffered)
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.anomalyWaiter = null
        reject(new Error(`等待异常 stdout 行超时 (${timeoutMs}ms)`))
      }, timeoutMs)
      this.anomalyWaiter = { resolve, timer }
    })
  }

  nextId(): number {
    return ++this.nextIdVal
  }

  /** 发请求（id 自增）；进程已死时 reject（stdin EPIPE / 错误帧）。 */
  request(method: string, params: object, timeoutMs: number): Promise<Frame> {
    const id = this.nextId()
    return new Promise<Frame>((resolve, reject) => {
      if (this.destroyed) {
        reject(new Error('client 已销毁'))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC 超时 (${timeoutMs}ms): ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, timer })
      this.child.stdin!.write(JSON.stringify({ id, method, params }) + '\n', (err) => {
        if (err) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(new Error(`stdin 写入失败: ${msg(err)}`))
        }
      })
    })
  }

  private failAll(why: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve({ id, ok: false, error: { code: 'unavailable', message: why } })
    }
    this.pending.clear()
  }

  /** SIGKILL 真正的 driver 进程（ping 自报 pid；候选 2 时 ≠ child.pid）。 */
  killDriverByPid(): void {
    if (typeof this.driverPid === 'number') process.kill(this.driverPid, 'SIGKILL')
  }

  /**
   * 整组清理：SIGTERM 进程组 → 宽限 → SIGKILL；再等 driver pid 消失（候选 2 的
   * driver 是孙进程，不在本进程组 kill 的直接确认范围内）。
   */
  async destroy(): Promise<void> {
    this.destroyed = true
    const child = this.child
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGTERM') // detached → 组长，整组终止（pnpm→tsx→driver 链）
      } catch {
        child.kill('SIGTERM')
      }
      if (!(await waitForExit(child, KILL_GRACE_MS))) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
        await waitForExit(child, KILL_GRACE_MS)
      }
    }
    // driver pid 残留检查（候选 2 时 ≠ child.pid）
    if (typeof this.driverPid === 'number' && this.driverPid !== child?.pid) {
      for (let i = 0; i < 10; i++) {
        try {
          process.kill(this.driverPid, 0)
        } catch {
          break
        }
        await new Promise((r) => setTimeout(r, 200))
      }
    }
    this.failAll('client 已销毁')
  }
}

// ---------------------------------------------------------------------------
// compare 模式：平台侧 mapService.buildGeometry 同款流程（tiledPath 内联等
// 文件 I/O 属平台侧职责，最终 config 才送 driver；复刻 mapService.ts:124-178）
// ---------------------------------------------------------------------------

interface PipelineStep {
  generator: string
  params?: Record<string, unknown>
}

interface MapConfigLike {
  key: string
  seed: number
  pipeline: PipelineStep[]
}

interface RegistryFile {
  maps: Record<string, Record<string, unknown>>
}

/** 读本体 registry.json（official 源；报错文案同 mapService.ts:186-197）。 */
async function readOfficialRegistry(): Promise<RegistryFile> {
  const file = path.join(GAME_ROOT, 'game', 'maps', 'registry.json')
  if (!fs.existsSync(file)) throw new Error(`registry.json 不存在（official）`)
  const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as RegistryFile
  if (!parsed || typeof parsed !== 'object' || !parsed.maps || typeof parsed.maps !== 'object') {
    throw new Error(`registry.json 结构非法（official）：缺少 maps 对象`)
  }
  return parsed
}

/** 单图 config 组装（含 tiledPath 内联，逐行对应 mapService.ts:126-162；tiled → throw）。 */
async function buildOfficialConfig(key: string, entry: Record<string, unknown>): Promise<MapConfigLike> {
  if (entry.kind === 'tiled') {
    // mapService.ts:126-128（REST 400）
    throw new Error('tiled 类型地图不支持 pipeline 几何生成')
  }
  const registryDir = path.join(GAME_ROOT, 'game', 'maps')
  const pipeline: PipelineStep[] = []
  const steps = Array.isArray(entry.pipeline) ? (entry.pipeline as PipelineStep[]) : []
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]
    const params = (step.params ?? {}) as Record<string, unknown>
    if (params.tiledPath === undefined) {
      pipeline.push(step)
      continue
    }
    if (params.tiled !== undefined) {
      // mapService.ts:140-142（REST 422）
      throw new Error(`地图 "${key}" 管道步骤 ${index}：tiled 与 tiledPath 只能声明其一`)
    }
    if (typeof params.tiledPath !== 'string') {
      // mapService.ts:143-145（REST 422）
      throw new Error(`地图 "${key}" 管道步骤 ${index}：tiledPath 必须为字符串`)
    }
    // 防穿越：模板必须位于 maps/ 目录（registryDir）内
    const tiledAbs = path.resolve(registryDir, params.tiledPath)
    if (!tiledAbs.startsWith(registryDir + path.sep)) {
      // mapService.ts:147-150（REST 400）
      throw new Error(`地图 "${key}" 管道步骤 ${index}：tiledPath 越界`)
    }
    let tiledJson: unknown
    try {
      tiledJson = JSON.parse(await fsp.readFile(tiledAbs, 'utf8'))
    } catch (err) {
      // mapService.ts:151-159（REST 422）
      throw new Error(
        `地图 "${key}" 管道步骤 ${index}：tiledPath "${params.tiledPath}" 加载失败（${msg(err)}）`,
      )
    }
    const { tiledPath: _omit, ...rest } = params
    pipeline.push({ generator: step.generator, params: { ...rest, tiled: tiledJson } })
  }
  return {
    key,
    seed: typeof entry.seed === 'number' ? entry.seed : 0,
    pipeline,
  }
}

// ---------------------------------------------------------------------------
// compare：五键采集 + 对比
// ---------------------------------------------------------------------------

interface GeometryEntry {
  ok: boolean
  geometry?: unknown
  error?: string
}

interface CompareRows {
  rows: CompareRow[]
  driverJson: Record<string, unknown>
  mech: MechanismRecord
  allPass: boolean
}

interface CompareRow {
  key: string
  verdict: 'EQUAL' | 'DIFF' | 'SKIP'
  detail: string
}

interface MechanismRecord {
  pongMs: number
  driverPid?: number
  zodVersion?: string
  zodOk: boolean
  rssMB?: number
  unknownMethod?: string
  malformedLine?: string
  unknownKind?: string
  kill9: string[]
  recovery?: string
  pings: { n: number; p50: number; p95: number; max: number; errors: number }
  violations: number
}

async function collectFiveKeys(client: DriverClient): Promise<Record<string, unknown>> {
  const collected: Record<string, unknown> = {}

  // 1) registries
  const reg = await client.request('listRegistries', {}, RPC_TIMEOUT_MS)
  if (!reg.ok) throw new Error(`listRegistries 失败: ${reg.error?.code} ${reg.error?.message ?? ''}`)
  collected.registries = reg.result

  // 2) wholeValid / 3) wholeInvalid
  const wholeValid = await client.request(
    'validateWhole',
    { gameJsonPath: path.join(GAME_ROOT, 'game', 'game.json') },
    RPC_TIMEOUT_MS,
  )
  if (!wholeValid.ok) throw new Error(`validateWhole(合法) 失败: ${wholeValid.error?.code} ${wholeValid.error?.message ?? ''}`)
  collected.wholeValid = wholeValid.result

  const wholeInvalid = await client.request('validateWhole', { gameJsonPath: BROKEN_GAME_JSON }, RPC_TIMEOUT_MS)
  if (!wholeInvalid.ok) throw new Error(`validateWhole(破坏) 失败: ${wholeInvalid.error?.code} ${wholeInvalid.error?.message ?? ''}`)
  collected.wholeInvalid = wholeInvalid.result

  // 4) geometry：平台侧 config 组装（tiled 报错为平台侧语义），pipeline 图送 driver
  const raw = await readOfficialRegistry()
  const maps: Record<string, GeometryEntry> = {}
  for (const key of Object.keys(raw.maps)) {
    try {
      const config = await buildOfficialConfig(key, raw.maps[key])
      const resp = await client.request('buildMapGeometry', { config }, GEOMETRY_TIMEOUT_MS)
      if (resp.ok) {
        maps[key] = { ok: true, geometry: resp.result }
      } else {
        maps[key] = { ok: false, error: resp.error?.message ?? '(无 message)' }
      }
    } catch (err) {
      // 平台侧语义错误（tiled / registry / tiledPath 内联），不经 driver
      maps[key] = { ok: false, error: msg(err) }
    }
  }
  collected.geometry = { source: 'official', registryPath: path.join(GAME_ROOT, 'game', 'maps', 'registry.json'), maps }

  // 5) validateFile：用例①②（kind 由平台路由表判定，此处已知为 Archetype）
  const wolfParsed = JSON.parse(await fsp.readFile(path.join(GAME_ROOT, 'game', 'entities', 'wolf.json'), 'utf8'))
  const wolfResp = await client.request('validateFile', { kind: 'Archetype', data: wolfParsed }, RPC_TIMEOUT_MS)
  if (!wolfResp.ok) throw new Error(`validateFile(wolf) 失败: ${wolfResp.error?.code} ${wolfResp.error?.message ?? ''}`)
  const brokenParsed = JSON.parse(await fsp.readFile(BROKEN_ARCHETYPE_PATH, 'utf8'))
  const brokenResp = await client.request('validateFile', { kind: 'Archetype', data: brokenParsed }, RPC_TIMEOUT_MS)
  if (!brokenResp.ok) throw new Error(`validateFile(broken) 失败: ${brokenResp.error?.code} ${brokenResp.error?.message ?? ''}`)
  collected.validateFile = {
    wolfValid: { relPath: 'entities/wolf.json', schemaKind: 'Archetype', ...wolfResp.result },
    brokenArchetype: { relPath: 'entities/broken-archetype.json', schemaKind: 'Archetype', ...brokenResp.result },
    // unroutedPath：平台侧路由未命中 → 平台不发 RPC（语义决策点），无 driver 输出可比
  }

  return collected
}

/** 附加机制用例：未知 method / 畸形行 / 100×ping（kill -9 与恢复由调用方单独编排）。 */
async function runMechanismProbes(client: DriverClient, record: MechanismRecord): Promise<void> {
  // 未知 method
  const um = await client.request('__no_such_method__', {}, ANOMALY_TIMEOUT_MS)
  record.unknownMethod = um.ok
    ? `意外成功: ${JSON.stringify(um.result).slice(0, 120)}`
    : `错误帧 code=${um.error?.code} message="${um.error?.message}"`

  // 畸形行（非 JSON 行写入 stdin；driver 应回 id=null 的 bad_request 帧）
  await new Promise<void>((resolve, reject) => {
    client.child.stdin!.write('{broken json line\n', (err) => (err ? reject(msg(err)) : resolve()))
  })
  try {
    const line = await client.nextAnomaly()
    let parsed: Frame | null = null
    try {
      parsed = JSON.parse(line) as Frame
    } catch {
      /* 保持 null */
    }
    record.malformedLine = parsed
      ? `响应帧 id=${parsed.id} ok=${parsed.ok} code=${parsed.error?.code} message="${parsed.error?.message}"`
      : `非 JSON 输出（协议违规）: ${line.slice(0, 120)}`
  } catch (err) {
    record.malformedLine = `未观察到响应: ${msg(err)}`
  }

  // validateFile 未登记 kind（语义决策点的 driver 侧半边：平台不发 RPC；
  // 若真发，driver 应回 bad_request——此处实测记录该守卫行为）
  const uk = await client.request('validateFile', { kind: '__unregistered_kind__', data: {} }, ANOMALY_TIMEOUT_MS)
  record.unknownKind = uk.ok
    ? `意外成功: ${JSON.stringify(uk.result).slice(0, 120)}`
    : `错误帧 code=${uk.error?.code} message="${uk.error?.message}"`

  // 连续 100 次 ping
  const lat: number[] = []
  let errors = 0
  for (let i = 0; i < 100; i++) {
    const t = Date.now()
    try {
      const r = await client.request('ping', {}, ANOMALY_TIMEOUT_MS)
      if (!r.ok) errors++
    } catch {
      errors++
    }
    lat.push(Date.now() - t)
  }
  lat.sort((a, b) => a - b)
  record.pings = {
    n: lat.length,
    p50: percentile(lat, 50),
    p95: percentile(lat, 95),
    max: lat[lat.length - 1],
    errors,
  }
}

/** kill -9 driver 后再发请求（记录观察到的行为），随后重启同机制 driver 验证可恢复。 */
async function runKill9Probe(spec: CandidateSpec, record: MechanismRecord): Promise<void> {
  const client = await DriverClient.start(spec)
  try {
    const pid = client.driverPid!
    record.kill9.push(`kill -9 前 driver pid=${pid}（child.pid=${client.child.pid}）`)
    client.killDriverByPid()
    record.kill9.push(`已发 SIGKILL → driver pid=${pid}`)
    await waitForExit(client.child, KILL_GRACE_MS)
    record.kill9.push(`child exit: ${client.exitReason ?? '(未退出?)'}`)
    const t0 = Date.now()
    try {
      const r = await client.request('ping', {}, ANOMALY_TIMEOUT_MS)
      record.kill9.push(
        `kill -9 后再发请求（+${Date.now() - t0}ms）→ ${
          r.ok ? `意外成功: ${JSON.stringify(r.result).slice(0, 120)}` : `错误帧 code=${r.error?.code} message="${r.error?.message}"`
        }`,
      )
    } catch (err) {
      record.kill9.push(`kill -9 后再发请求（+${Date.now() - t0}ms）→ RPC reject: ${msg(err)}`)
    }
  } finally {
    await client.destroy()
  }

  // 恢复：同机制重新 spawn（对应 T1.3 client「exit → 下次 RPC 自动重启一次」的可行性）
  const revived = await DriverClient.start(spec)
  try {
    record.recovery = `重新 spawn 后 ping 恢复 ✔ 新 driver pid=${revived.driverPid}（旧=${record.driverPid}）pong=${revived.pongMs}ms`
  } catch (err) {
    record.recovery = `重新 spawn 后 ping 失败 ✘: ${msg(err)}`
  } finally {
    await revived.destroy()
  }
}

async function compareCandidate(spec: CandidateSpec, baseline: Record<string, unknown>): Promise<CompareRows> {
  const client = await DriverClient.start(spec)
  const record: MechanismRecord = {
    pongMs: client.pongMs!,
    driverPid: client.driverPid,
    zodVersion: client.zodVersion,
    zodOk: client.zodVersion === '4.4.3',
    rssMB: client.rssMB,
    kill9: [],
    pings: { n: 0, p50: NaN, p95: NaN, max: NaN, errors: 0 },
    violations: 0,
  }
  const rows: CompareRow[] = []
  let driverJson: Record<string, unknown> = {}
  try {
    driverJson = await collectFiveKeys(client)
    record.violations = client.violations.length

    const push = (key: string, a: unknown, b: unknown, transform?: (v: unknown) => unknown): void => {
      const ta = transform ? transform(a) : a
      const tb = transform ? transform(b) : b
      const ca = canon(ta)
      const cb = canon(tb)
      rows.push(ca === cb ? { key, verdict: 'EQUAL', detail: `全等 ✔（${ca.length} 字符）` } : { key, verdict: 'DIFF', detail: `DIFF ✘ ${firstDiff(ca, cb)}` })
    }
    const field = (obj: unknown, name: string): unknown => (obj as Record<string, unknown> | null)?.[name] ?? null

    // registries：全等
    push('registries', baseline.registries, driverJson.registries)

    // wholeValid / wholeInvalid：ok 与 message 全等
    for (const k of ['wholeValid', 'wholeInvalid'] as const) {
      const b = baseline[k]
      const d = driverJson[k]
      rows.push(
        field(b, 'ok') === field(d, 'ok')
          ? { key: `${k}.ok`, verdict: 'EQUAL', detail: `全等 ✔（${JSON.stringify(field(d, 'ok'))}）` }
          : { key: `${k}.ok`, verdict: 'DIFF', detail: `DIFF ✘ 基线=${JSON.stringify(field(b, 'ok'))} driver=${JSON.stringify(field(d, 'ok'))}` },
      )
      push(`${k}.message`, field(b, 'message'), field(d, 'message'))
    }

    // geometry：逐图对比（pipeline 图 geometry；tiled 图报错文案）
    const baseMaps = (baseline.geometry as Record<string, unknown> | null)?.maps as Record<string, GeometryEntry> | undefined
    const drvMaps = (driverJson.geometry as Record<string, unknown> | null)?.maps as Record<string, GeometryEntry> | undefined
    const keys = new Set([...Object.keys(baseMaps ?? {}), ...Object.keys(drvMaps ?? {})])
    for (const key of [...keys].sort()) {
      push(`geometry.${key}`, baseMaps?.[key] ?? null, drvMaps?.[key] ?? null)
    }

    // validateFile：valid 与 issues 全等（unroutedPath 为语义决策点，跳过）
    for (const k of ['wolfValid', 'brokenArchetype'] as const) {
      const b = (baseline.validateFile as Record<string, unknown> | null)?.[k]
      const d = (driverJson.validateFile as Record<string, unknown> | null)?.[k]
      rows.push(
        field(b, 'valid') === field(d, 'valid')
          ? { key: `validateFile.${k}.valid`, verdict: 'EQUAL', detail: `全等 ✔（${JSON.stringify(field(d, 'valid'))}）` }
          : { key: `validateFile.${k}.valid`, verdict: 'DIFF', detail: `DIFF ✘ 基线=${JSON.stringify(field(b, 'valid'))} driver=${JSON.stringify(field(d, 'valid'))}` },
      )
      const bi = field(b, 'issues')
      const di = field(d, 'issues')
      const ci = canon(bi)
      const cdi = canon(di)
      rows.push(
        ci === cdi
          ? { key: `validateFile.${k}.issues`, verdict: 'EQUAL', detail: `全等 ✔（${Array.isArray(di) ? di.length : '?'} issues）` }
          : { key: `validateFile.${k}.issues`, verdict: 'DIFF', detail: `DIFF ✘ ${firstDiff(ci, cdi)}` },
      )
    }
    rows.push({
      key: 'validateFile.unroutedPath',
      verdict: 'SKIP',
      detail: '语义决策点：平台路由未命中不发 RPC，无 driver 输出可比（driver 侧未知 kind 回 bad_request，见机制记录）',
    })

    // 机制用例（在五键采集之后，避免影响采集）
    await runMechanismProbes(client, record)
  } finally {
    await client.destroy()
  }

  // kill -9 + 恢复（需要重新 spawn，独立于上面已销毁的 client）
  await runKill9Probe(spec, record)

  const allPass = rows.every((r) => r.verdict !== 'DIFF') && record.zodOk && record.violations === 0
  return { rows, driverJson, mech: record, allPass }
}

// ---------------------------------------------------------------------------
// mechanics 模式（T0.1 原有行为，改走 DriverClient）
// ---------------------------------------------------------------------------

interface CandidateReport {
  label: string
  available: boolean
  reason?: string
  pongMs?: number
  driverPid?: number
  rssMB?: number
  zodVersion?: string
  registries?: RegistriesSummary
  registriesError?: string
  protocolViolations: string[]
  stderrTail: string[]
  cleanedUp: boolean
}

async function runCandidate(spec: CandidateSpec): Promise<CandidateReport> {
  const report: CandidateReport = { label: spec.label, available: false, protocolViolations: [], stderrTail: [], cleanedUp: false }
  let client: DriverClient | undefined
  try {
    client = await DriverClient.start(spec)
    report.pongMs = client.pongMs
    report.zodVersion = client.zodVersion
    report.driverPid = client.driverPid
    report.rssMB = client.rssMB

    const reg = await client.request('listRegistries', {}, RPC_TIMEOUT_MS)
    if (reg.ok) {
      const r = (reg.result ?? {}) as Record<string, unknown>
      const count = (v: unknown): number =>
        Array.isArray(v) ? v.length : typeof v === 'object' && v !== null ? Object.keys(v).length : 0
      report.registries = {
        systems: count(r.systems),
        archetypes: count(r.archetypes),
        actions: count(r.actions),
        components: count(r.components),
        mapGenerators: count(r.mapGenerators),
      }
    } else {
      report.registriesError = `${reg.error?.code} ${reg.error?.message ?? ''}`
    }

    report.available = true
  } catch (err) {
    report.reason = msg(err)
  } finally {
    if (client) {
      await client.destroy()
      report.protocolViolations = client.violations.slice(0, 5)
      report.stderrTail = client.stderrLines.slice(-5)
      // destroy 已等待 driver pid 消失
    }
    report.cleanedUp = true
  }
  return report
}

function printReport(reports: CandidateReport[], serverZod: string): void {
  for (const r of reports) {
    console.log(`--- ${r.label} ---`)
    console.log(`  可用性            : ${r.available ? 'OK ✔' : `FAIL ✘（${r.reason ?? '未知原因'}）`}`)
    if (r.available) {
      console.log(`  spawn→pong        : ${r.pongMs} ms`)
      console.log(`  driver RSS        : ${r.rssMB ?? '?'} MB（ping 自报，driver pid=${r.driverPid ?? '?'}）`)
      console.log(`  zod 版本（driver 内）: ${r.zodVersion ?? '?'}${r.zodVersion === '4.4.3' ? '  ← 本体的，依赖单实例化成立' : `  （预期 4.4.3；server 侧为 ${serverZod}）`}`)
      if (r.registries) {
        const g = r.registries
        console.log(`  冒烟 listRegistries: systems=${g.systems} archetypes=${g.archetypes} actions=${g.actions} components=${g.components} mapGenerators=${g.mapGenerators}`)
      }
      if (r.registriesError) console.log(`  冒烟 listRegistries: 失败（${r.registriesError}）`)
    }
    if (r.protocolViolations.length) {
      console.log('  协议违规（stdout 非 帧 行）:')
      for (const v of r.protocolViolations) console.log(`    - ${v}`)
    }
    if (r.stderrTail.length) {
      console.log('  stderr 摘要（末尾）:')
      for (const line of r.stderrTail) console.log(`    | ${line.slice(0, 240)}`)
    }
    if (!r.cleanedUp) console.log('  ⚠ 子进程清理未确认，请人工检查残留（pgrep -f sidecar/driver.ts）')
  }
}

// ---------------------------------------------------------------------------
// compare 输出
// ---------------------------------------------------------------------------

function printCompare(label: string, result: CompareRows): void {
  const m = result.mech
  console.log(`\n==== 对比: ${label} ====`)
  console.log('  —— 五键规范化对比 ——')
  for (const r of result.rows) {
    const tag = r.verdict === 'EQUAL' ? '✔' : r.verdict === 'DIFF' ? '✘' : '⊘'
    console.log(`  [${r.key}] ${r.verdict} ${tag}  ${r.detail}`)
  }
  console.log('  —— 机制记录 ——')
  console.log(`  spawn→pong : ${m.pongMs} ms；driver pid=${m.driverPid}；RSS=${m.rssMB ?? '?'} MB`)
  console.log(`  zod 版本   : ${m.zodVersion} ${m.zodOk ? '✔（=4.4.3，依赖单实例化成立）' : '✘（预期 4.4.3）'}`)
  console.log(`  未知 method: ${m.unknownMethod}`)
  console.log(`  畸形行     : ${m.malformedLine}`)
  console.log(`  未登记 kind: ${m.unknownKind}`)
  for (const line of m.kill9) console.log(`  kill -9    : ${line}`)
  console.log(`  恢复       : ${m.recovery}`)
  console.log(
    `  100×ping   : p50=${m.pings.p50} ms, p95=${m.pings.p95} ms, max=${m.pings.max} ms, errors=${m.pings.errors}`,
  )
  console.log(`  协议违规   : ${m.violations} 处`)
  console.log(`  结论       : ${result.allPass ? 'PASS ✔（五键 diff 为空且 zod=4.4.3 且无协议违规）' : 'FAIL ✘'}`)
}

async function loadBaseline(): Promise<Record<string, unknown>> {
  if (!fs.existsSync(BASELINE_PATH)) {
    throw new Error(
      `基线不存在：${BASELINE_PATH}——先重新生成：cd server && pnpm exec tsx ../scripts/spike-baseline.mts`,
    )
  }
  const parsed = JSON.parse(await fsp.readFile(BASELINE_PATH, 'utf8')) as Record<string, unknown>
  for (const k of ['registries', 'wholeValid', 'wholeInvalid', 'geometry', 'validateFile']) {
    if (!(k in parsed)) throw new Error(`基线缺键 "${k}"——请重新生成基线（spike-baseline.mts）`)
  }
  return parsed
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function runMechanicsPhase(): Promise<number> {
  console.log('==== sidecar spike --phase=mechanics ====')
  console.log(`repo      : ${REPO_ROOT}`)
  console.log(`GAME_ROOT : ${GAME_ROOT}`)
  console.log(`driver    : ${DRIVER_PATH}`)
  console.log(`zod 对比  : server=${readServerZodVersion()}（driver 预期取本体的 4.4.3）`)

  const problems = preflightProblems()
  if (problems.length) {
    for (const p of problems) console.error(`前置检查失败: ${p}`)
    return 2
  }

  const gameTsconfig = path.join(GAME_ROOT, 'tsconfig.json')
  const candidates: CandidateSpec[] = [
    {
      label: '候选 1: node --import tsx + TSX_TSCONFIG_PATH',
      cmd: process.execPath,
      args: ['--import', 'tsx', DRIVER_PATH],
      env: { ...process.env, TSX_TSCONFIG_PATH: gameTsconfig },
    },
    {
      label: `候选 2: pnpm exec tsx --tsconfig（${gameTsconfig}）`,
      cmd: 'pnpm',
      args: ['exec', 'tsx', '--tsconfig', gameTsconfig, DRIVER_PATH],
    },
  ]

  const reports: CandidateReport[] = []
  for (const spec of candidates) {
    process.stdout.write(`\n启动 ${spec.label} ...\n`)
    const report = await runCandidate(spec)
    reports.push(report)
    console.log(`  ${report.available ? '✔ 可用' : '✘ 不可用'}（pong ${report.pongMs ?? '-'} ms, zod ${report.zodVersion ?? '-'}）`)
  }

  console.log('\n==== 逐候选明细 ====')
  printReport(reports, readServerZodVersion())

  const usable = reports.filter((r) => r.available)
  console.log('\n==== 结论 ====')
  console.log(`可用候选: ${usable.length ? usable.map((r) => r.label).join('；') : '无 —— 两个候选机制均不可用，按计划升级讨论'}`)
  return usable.length ? 0 : 1
}

async function runComparePhase(): Promise<number> {
  console.log('==== sidecar spike --phase=compare ====')
  console.log(`repo      : ${REPO_ROOT}`)
  console.log(`GAME_ROOT : ${GAME_ROOT}`)
  console.log(`driver    : ${DRIVER_PATH}`)
  console.log(`baseline  : ${BASELINE_PATH}`)
  console.log(`zod 对比  : server=${readServerZodVersion()}（driver 预期取本体的 4.4.3）`)

  const problems = preflightProblems()
  if (!fs.existsSync(path.join(GAME_ROOT, 'game', 'entities', 'wolf.json'))) {
    problems.push(`本体缺 entities/wolf.json：${path.join(GAME_ROOT, 'game', 'entities', 'wolf.json')}`)
  }
  if (!fs.existsSync(BROKEN_GAME_JSON)) {
    problems.push(`破坏版 game.json 不存在：${BROKEN_GAME_JSON}（重跑 spike-baseline.mts 生成）`)
  }
  if (!fs.existsSync(BROKEN_ARCHETYPE_PATH)) {
    problems.push(`破坏版 archetype 不存在：${BROKEN_ARCHETYPE_PATH}（重跑 spike-baseline.mts 生成）`)
  }
  if (problems.length) {
    for (const p of problems) console.error(`前置检查失败: ${p}`)
    return 2
  }

  const baseline = await loadBaseline()

  const gameTsconfig = path.join(GAME_ROOT, 'tsconfig.json')
  const candidates: CandidateSpec[] = [
    {
      label: '候选 1: node --import tsx + TSX_TSCONFIG_PATH',
      cmd: process.execPath,
      args: ['--import', 'tsx', DRIVER_PATH],
      env: { ...process.env, TSX_TSCONFIG_PATH: gameTsconfig },
    },
    {
      label: `候选 2: pnpm exec tsx --tsconfig（${gameTsconfig}）`,
      cmd: 'pnpm',
      args: ['exec', 'tsx', '--tsconfig', gameTsconfig, DRIVER_PATH],
    },
  ]

  await fsp.mkdir(SPIKE_DIR, { recursive: true })
  const results: { label: string; result: CompareRows }[] = []
  for (let i = 0; i < candidates.length; i++) {
    const spec = candidates[i]
    process.stdout.write(`\n对比 ${spec.label} ...\n`)
    let result: CompareRows
    try {
      result = await compareCandidate(spec, baseline)
    } catch (err) {
      console.error(`候选对比失败: ${msg(err)}`)
      return 1
    }
    results.push({ label: spec.label, result })
    const artifact = path.join(SPIKE_DIR, `driver-${i + 1}.json`)
    await fsp.writeFile(
      artifact,
      JSON.stringify({ candidate: spec.label, ...result.driverJson }, null, 2) + '\n',
      'utf8',
    )
    console.log(`  五键输出 → ${artifact}`)
  }

  console.log('\n==== 逐候选对比明细 ====')
  for (const { label, result } of results) printCompare(label, result)

  console.log('\n==== 结论 ====')
  const passing = results.filter((r) => r.result.allPass)
  console.log(
    `五键 diff 为空的候选: ${
      passing.length ? passing.map((r) => r.label).join('；') : '无 —— driver 输出与基线存在差异，需修 driver 后重跑'
    }`,
  )
  // 定型建议：候选 1（node --import tsx）为 Phase 1 定型候选
  const cand1 = results[0]
  if (cand1?.result.allPass) {
    console.log('定型建议: 候选 1（node --import tsx + TSX_TSCONFIG_PATH）—— diff 为空、延迟更低、无 pnpm 中间层')
    return 0
  }
  const cand2 = results[1]
  if (cand2?.result.allPass) {
    console.log('定型建议: 候选 2（pnpm exec tsx --tsconfig）—— 候选 1 未通过，退而求其次')
    return 0
  }
  return 1
}

async function main(): Promise<number> {
  const phaseArg = process.argv.find((a) => a.startsWith('--phase='))
  const phase = phaseArg?.slice('--phase='.length) ?? 'mechanics'
  if (phase === 'mechanics') return runMechanicsPhase()
  if (phase === 'compare') return runComparePhase()
  console.error(`未知 phase "${phase}"（支持 --phase=mechanics | --phase=compare）`)
  return 2
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('spike 脚本异常:', err)
    process.exit(1)
  })
