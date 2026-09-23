import { describe, expect, it } from 'vitest'

import {
  GIT_IMPORT_STAGES,
  LOCAL_IMPORT_STAGES,
  SIDECAR_STATE_TEXT,
  formatSourceLine,
  inferFailedStageIndex,
  shortCommit,
  sidecarStateOf,
  sidecarStateTone,
  sourceTypeText,
} from '@/utils/games'

describe('sidecar 状态语义', () => {
  it('unavailable 优先于 alive；两者皆无 → idle', () => {
    expect(sidecarStateOf({ alive: true, unavailable: 'spawn 失败' })).toBe('unavailable')
    expect(sidecarStateOf({ alive: true, unavailable: null })).toBe('alive')
    expect(sidecarStateOf({ alive: false, unavailable: null })).toBe('idle')
  })

  it('状态 → 徽标色调：alive=running / unavailable=crashed / idle=默认灰', () => {
    expect(sidecarStateTone('alive')).toBe('running')
    expect(sidecarStateTone('unavailable')).toBe('crashed')
    expect(sidecarStateTone('idle')).toBe('')
  })

  it('状态文案表齐全', () => {
    expect(SIDECAR_STATE_TEXT).toEqual({
      alive: '已就绪',
      unavailable: '不可用',
      idle: '未拉起',
    })
  })
})

describe('来源与 commit 文案', () => {
  it('local 源显示路径，git 源显示 url@ref', () => {
    expect(formatSourceLine({ type: 'local', path: '../game_server_test' })).toBe(
      '../game_server_test',
    )
    expect(formatSourceLine({ type: 'git', url: 'https://example.com/r.git', ref: 'main' })).toBe(
      'https://example.com/r.git@main',
    )
  })

  it('来源中文名', () => {
    expect(sourceTypeText({ type: 'local', path: 'x' })).toBe('本地路径')
    expect(sourceTypeText({ type: 'git', url: 'u', ref: 'r' })).toBe('Git 仓库')
  })

  it('shortCommit：7 位截断，空值占位', () => {
    expect(shortCommit('abc1234abcd')).toBe('abc1234')
    expect(shortCommit('abc1234')).toBe('abc1234')
    expect(shortCommit('  ')).toBe('—')
    expect(shortCommit('')).toBe('—')
  })
})

describe('导入/同步阶段模型', () => {
  it('git 源四阶段（clone → install → probe → smoke）', () => {
    expect(GIT_IMPORT_STAGES.map((stage) => stage.key)).toEqual([
      'clone',
      'install',
      'probe',
      'smoke',
    ])
  })

  it('local 源三阶段（validate → probe → smoke）', () => {
    expect(LOCAL_IMPORT_STAGES.map((stage) => stage.key)).toEqual(['validate', 'probe', 'smoke'])
  })

  it('按错误文案推断失败阶段（git 源）', () => {
    expect(inferFailedStageIndex(GIT_IMPORT_STAGES, 'git clone 失败：仓库不可达')).toBe(0)
    expect(inferFailedStageIndex(GIT_IMPORT_STAGES, 'pnpm install 退出码 1')).toBe(1)
    expect(inferFailedStageIndex(GIT_IMPORT_STAGES, 'manifest 探测失败：缺 framework')).toBe(2)
    expect(inferFailedStageIndex(GIT_IMPORT_STAGES, '冒烟失败：listRegistries 超时')).toBe(3)
  })

  it('按错误文案推断失败阶段（local 源）', () => {
    expect(inferFailedStageIndex(LOCAL_IMPORT_STAGES, 'local 源校验失败：目录不存在')).toBe(0)
    expect(inferFailedStageIndex(LOCAL_IMPORT_STAGES, 'manifest 探测失败')).toBe(1)
    expect(inferFailedStageIndex(LOCAL_IMPORT_STAGES, '冒烟失败')).toBe(2)
    // git 专属文案落在 local 阶段序列时回退到首阶段（校验源目录）
    expect(inferFailedStageIndex(LOCAL_IMPORT_STAGES, 'git fetch 失败')).toBe(0)
  })

  it('推断不出 → -1（调用方按首阶段失败并附说明）', () => {
    expect(inferFailedStageIndex(GIT_IMPORT_STAGES, '完全未知的服务端错误')).toBe(-1)
  })
})
