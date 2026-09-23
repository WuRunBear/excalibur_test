/**
 * 游戏管理域的纯工具（T2.10）。
 *
 * sidecar 状态语义、来源单行文案、导入失败阶段推断——游戏切换器、游戏管理页
 * 与导入对话框共用。只做纯函数与映射，不发请求、不碰 Pinia。
 */
import type { GameSource } from '@/api/admin'

// ---------------------------------------------------------------------------
// sidecar 状态（列表项 describe 摘要；不触发 driver spawn）
// ---------------------------------------------------------------------------

/** sidecar 状态语义：不可用（连续 spawn 失败）> 已就绪（driver 在跑）> 未拉起（lazy）。 */
export type SidecarState = 'alive' | 'unavailable' | 'idle'

export const SIDECAR_STATE_TEXT: Record<SidecarState, string> = {
  alive: '已就绪',
  unavailable: '不可用',
  idle: '未拉起',
}

/** 状态 → 徽标色调（admin-status-badge-- 修饰类）；idle=灰 / alive=绿 / unavailable=红。 */
export function sidecarStateTone(state: SidecarState): '' | 'running' | 'crashed' {
  if (state === 'alive') return 'running'
  if (state === 'unavailable') return 'crashed'
  return ''
}

/** describe 摘要 → 状态语义（sidecar.unavailable 有值即判定不可用）。 */
export function sidecarStateOf(sidecar: {
  alive: boolean
  unavailable: string | null
}): SidecarState {
  if (sidecar.unavailable) return 'unavailable'
  if (sidecar.alive) return 'alive'
  return 'idle'
}

// ---------------------------------------------------------------------------
// 文案辅助
// ---------------------------------------------------------------------------

/** 来源单行文案：local=路径；git=url@ref（列表与详情复用）。 */
export function formatSourceLine(source: GameSource): string {
  return source.type === 'local' ? source.path : `${source.url}@${source.ref}`
}

/** 来源中文名。 */
export function sourceTypeText(source: GameSource): string {
  return source.type === 'local' ? '本地路径' : 'Git 仓库'
}

/** commit 短摘要（7 位）；空串 = 尚未同步，由调用方给占位文案。 */
export function shortCommit(commit: string): string {
  const trimmed = commit.trim()
  if (!trimmed) return '—'
  return trimmed.length <= 7 ? trimmed : trimmed.slice(0, 7)
}

// ---------------------------------------------------------------------------
// 导入/同步的阶段模型（服务端进度事件不外露，前端按错误推断失败阶段）
// ---------------------------------------------------------------------------

export interface SyncStageDef {
  /** 阶段键：与 gameSyncService 的执行顺序对应。 */
  key: 'clone' | 'install' | 'probe' | 'smoke' | 'validate'
  label: string
}

/** git 源导入的阶段序列（clone → install → probe → smoke；Q6：install 可跳过但阶段保留）。 */
export const GIT_IMPORT_STAGES: readonly SyncStageDef[] = [
  { key: 'clone', label: '克隆仓库' },
  { key: 'install', label: '安装依赖' },
  { key: 'probe', label: '生成接入清单' },
  { key: 'smoke', label: '冒烟验证' },
]

/** local 源：不 clone、跳过 install（Q6），校验源目录即第一阶段。 */
export const LOCAL_IMPORT_STAGES: readonly SyncStageDef[] = [
  { key: 'validate', label: '校验源目录' },
  { key: 'probe', label: '生成接入清单' },
  { key: 'smoke', label: '冒烟验证' },
]

/**
 * 由失败 message 推断失败阶段下标。服务端只在完成后一次性返回错误，
 * 这里按错误文案里的命令名/错误码关键词对号入座；推断不出返回 -1
 * （调用方按首阶段失败处理并附「未能精确判定」说明）。
 */
export function inferFailedStageIndex(stages: readonly SyncStageDef[], message: string): number {
  const find = (key: SyncStageDef['key']): number => stages.findIndex((s) => s.key === key)
  if (/local 源校验失败/.test(message)) {
    const index = find('validate') >= 0 ? find('validate') : find('clone')
    return index
  }
  if (/pnpm install/.test(message)) return find('install')
  if (/manifest 探测失败|probeManifest/.test(message)) return find('probe')
  if (/冒烟失败|listRegistries/.test(message)) return find('smoke')
  if (/git clone|git checkout|git fetch|rev-parse/.test(message)) {
    const index = find('clone') >= 0 ? find('clone') : find('validate')
    return index
  }
  return -1
}
