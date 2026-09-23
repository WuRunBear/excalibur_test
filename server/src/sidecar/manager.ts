/**
 * SidecarManager —— per-game SidecarClient 的持有者与指纹失效层（T2.3）。
 *
 * 职责（docs/multi-game-plan.md §4 T2.3）：
 * - Map<gameId, SidecarClient>：forGame(id) 返回该游戏的 client（无则建，
 *   spawn 参数带该游戏的 gameRoot —— 由 gameContext.forGame 合成）；
 * - **指纹失效**：指纹变化 → 杀旧 driver（client.stop()）→ 下次 RPC lazy 重启；
 * - 显式 invalidate(gameId)：杀 client + 清 gameContext 缓存（兜底入口）。
 *
 * 指纹构成（对齐规格"checkout 指纹（resolved.commit + lockfileHash）"并满足
 * 双触发源实测）：
 * - git 源：`<resolved.commit>:<resolved.lockfileHash>` —— 由 T2.5 sync 流程
 *   写入 registry，sync 后指纹变化 → 下次 forGame 重建 client；
 * - local 源：registry resolved 指纹 + **live 指纹** 双分量：
 *   - live 指纹优先取 gameRoot 的 `git rev-parse HEAD`（开发者在 ../game_server_test
 *     提交后无需动 registry 即可触发 driver 重建，规格"local 源指纹用
 *     <gameRoot>/.git/HEAD 解析的 commit 替代"）；
 *   - 非 git 目录回退目录 mtime hash（sha256(mtimeMs) 前 16 位），并在
 *     describe() 的 fingerprintSource 上标注 'registry-resolved+dir-mtime'。
 *   双分量的原因：单看 live HEAD 时"改 registry commit 字段触发重建"不可测/
 *   不可达（local 源的 resolved.commit 本就由 T2.5 从 live HEAD 回填）；单看
 *   registry 时 live HEAD 变化无法感知。两者任一变化都应重建，取并集。
 *
 * 生命周期归 client.ts（lazy start / 防crash loop / exit 钩子），本层只做
 * "按 gameId 选对 client + 何时换新"。
 *
 * 已知限制：forGame 每次调用都会为 local 源 spawnSync 一次 `git rev-parse HEAD`
 * （~10ms 量级）；T2.4 servicesFor 高频化后可按需加 TTL 缓存，本期不做。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { forGame, invalidateGameContext, type ForGameOptions } from '../gameContext.js'
import { getGame, resolveLocalGamePath } from '../games/registry.js'
import { SidecarClient, type SidecarSnapshot } from './client.js'

export type SidecarManagerOptions = ForGameOptions

/** 指纹来源标注（"非 git 目录回退目录 mtime hash 并在返回对象上标注"）。 */
export type SidecarFingerprintSource =
  | 'registry-resolved'
  | 'registry-resolved+git-head'
  | 'registry-resolved+dir-mtime'

export interface SidecarFingerprint {
  fingerprint: string
  source: SidecarFingerprintSource
}

/** 单游戏 sidecar 状态（观测/T2.7 REST /api/games/:gameId 用）。 */
export interface SidecarGameStatus {
  gameId: string
  fingerprint: string
  fingerprintSource: SidecarFingerprintSource
  client: SidecarSnapshot
}

interface ManagedEntry {
  client: SidecarClient
  fingerprint: string
  fingerprintSource: SidecarFingerprintSource
}

export class SidecarManager {
  private readonly entries = new Map<string, ManagedEntry>()

  /**
   * 取该游戏的 client（无则建；指纹变化则杀旧建新）。gameRoot 取自
   * gameContext.forGame 的合成结果（git 源锚 checkout、local 源锚外部目录）。
   */
  forGame(gameId: string, options?: SidecarManagerOptions): SidecarClient {
    const current = this.computeFingerprint(gameId, options)
    const existing = this.entries.get(gameId)
    if (existing && existing.fingerprint === current.fingerprint) return existing.client
    if (existing) {
      // 指纹失效：杀旧 driver（stop 内 SIGTERM），下次 RPC 由新 client lazy 重启
      existing.client.stop()
      this.entries.delete(gameId)
    }
    const ctx = forGame(gameId, options)
    const client = new SidecarClient({ gameRoot: ctx.gameRoot })
    this.entries.set(gameId, {
      client,
      fingerprint: current.fingerprint,
      fingerprintSource: current.source,
    })
    return client
  }

  /**
   * 显式失效：杀该游戏 driver、清 manager 记录与 gameContext 缓存；
   * 下次 forGame 按 lazy 语义全新拉起。未注册/未持有过的 gameId 幂等 no-op
   * （gameContext 缓存清理仍执行）。
   */
  invalidate(gameId: string, options?: SidecarManagerOptions): void {
    const existing = this.entries.get(gameId)
    if (existing) {
      existing.client.stop()
      this.entries.delete(gameId)
    }
    invalidateGameContext(gameId, options)
  }

  /** 单游戏状态快照（不触发 driver spawn；游戏未注册抛出）。 */
  describe(gameId: string, options?: SidecarManagerOptions): SidecarGameStatus {
    const fp = this.computeFingerprint(gameId, options)
    const existing = this.entries.get(gameId)
    return {
      gameId,
      fingerprint: fp.fingerprint,
      fingerprintSource: fp.source,
      client: existing
        ? existing.client.snapshot()
        : { alive: false, pid: null, spawnFailures: 0, unavailable: null, pendingRequests: 0 },
    }
  }

  /** 全部持有中的游戏状态（遍历顺序即注册顺序）。 */
  list(): SidecarGameStatus[] {
    return [...this.entries.keys()].map((gameId) => {
      const entry = this.entries.get(gameId)!
      return {
        gameId,
        fingerprint: entry.fingerprint,
        fingerprintSource: entry.fingerprintSource,
        client: entry.client.snapshot(),
      }
    })
  }

  /** 停掉全部 driver（脚本退出/测试收尾用；不影响 client 的 lazy 重启语义）。 */
  stopAll(): void {
    for (const [gameId, entry] of this.entries) {
      entry.client.stop()
      this.entries.delete(gameId)
    }
  }

  // -----------------------------------------------------------------------

  private computeFingerprint(gameId: string, options?: SidecarManagerOptions): SidecarFingerprint {
    const entry = getGame(gameId, { registryPath: options?.registryPath })
    if (!entry) {
      throw new Error(`SidecarManager: 游戏未注册：${gameId}`)
    }
    // 分量 1：registry resolved 指纹（git 源的唯一分量；T2.5 sync 写入）
    const resolvedPart = `${entry.resolved.commit}:${entry.resolved.lockfileHash}`
    if (entry.source.type === 'git') {
      return { fingerprint: resolvedPart, source: 'registry-resolved' }
    }
    // 分量 2（local 源）：live 指纹 —— git HEAD 优先，非 git 回退目录 mtime hash
    const gameRoot = resolveLocalGamePath(entry.source)
    const head = gitHeadCommit(gameRoot)
    if (head !== null) {
      return { fingerprint: `${resolvedPart}|${head}`, source: 'registry-resolved+git-head' }
    }
    return { fingerprint: `${resolvedPart}|${dirMtimeHash(gameRoot)}`, source: 'registry-resolved+dir-mtime' }
  }
}

/** gameRoot 的 git HEAD commit；非 git 目录 / git 不可用 → null（调用方回退 mtime）。 */
function gitHeadCommit(gameRoot: string): string | null {
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: gameRoot, encoding: 'utf8', timeout: 5_000 })
    const out = (r.stdout ?? '').trim()
    if (r.status === 0 && /^[0-9a-f]{7,40}$/.test(out)) return out
  } catch {
    // git 缺失/超时等 → 回退
  }
  return null
}

/** 目录 mtime hash（非 git 目录的 live 指纹回退；sha256(mtimeMs) 前 16 位）。 */
function dirMtimeHash(gameRoot: string): string {
  let mtimeMs = 0
  try {
    mtimeMs = fs.statSync(gameRoot).mtimeMs
  } catch {
    // 目录不可 stat → 0（指纹稳定为固定值；spawn 自会失败并走 unavailable 语义）
  }
  return `mtime:${createHash('sha256').update(String(mtimeMs)).digest('hex').slice(0, 16)}`
}

/** 平台侧 per-game sidecar 管理器单例（T2.4 servicesFor 从此引用）。 */
export const sidecarManager = new SidecarManager()
