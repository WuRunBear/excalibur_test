import { describe, expect, it } from 'vitest'

import { formatClock, formatDateTime, formatDuration } from '@/utils/format'

describe('formatDuration', () => {
  it('按中文习惯分段', () => {
    expect(formatDuration(0)).toBe('0 秒')
    expect(formatDuration(42_000)).toBe('42 秒')
    expect(formatDuration(222_000)).toBe('3 分 42 秒')
    expect(formatDuration((3 * 3600 + 5 * 60) * 1000)).toBe('3 小时 05 分')
    expect(formatDuration(26 * 3600 * 1000)).toBe('1 天 2 小时')
  })

  it('非法输入返回占位符', () => {
    expect(formatDuration(-1)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
  })
})

describe('formatClock / formatDateTime', () => {
  it('按本地时区补零输出', () => {
    // 用本地时间构造，避免时区差异
    const d = new Date(2026, 8, 20, 9, 5, 3)
    expect(formatClock(d.getTime())).toBe('09:05:03')
    expect(formatDateTime(d.getTime())).toBe('2026-09-20 09:05:03')
  })
})
