/**
 * 管理平台时间 / 时长格式化（S1-D2）。
 */

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** epoch ms → HH:mm:ss（本地时区）。 */
export function formatClock(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** epoch ms → YYYY-MM-DD HH:mm:ss（本地时区）。 */
export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatClock(ts)}`
}

/**
 * 时长（ms）→ 中文可读文本：42 秒 / 3 分 42 秒 / 2 小时 05 分 / 1 天 4 小时。
 * 非法输入（负数 / NaN）返回占位符「—」。
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (totalSeconds < 3600) return `${minutes} 分 ${seconds} 秒`
  const hours = Math.floor(totalSeconds / 3600)
  const restMinutes = Math.floor((totalSeconds % 3600) / 60)
  if (totalSeconds < 86400) return `${hours} 小时 ${pad(restMinutes)} 分`
  const days = Math.floor(totalSeconds / 86400)
  const restHours = Math.floor((totalSeconds % 86400) / 3600)
  return `${days} 天 ${restHours} 小时`
}
