import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  fetchApplyPlan: vi.fn(),
  executeApply: vi.fn(),
  fetchBackups: vi.fn(),
  rollbackBackup: vi.fn(),
  fetchConfigFile: vi.fn(),
  wsRefresh: vi.fn(),
  ctxLoad: vi.fn(),
  messageSuccess: vi.fn(),
  messageError: vi.fn(),
}))

vi.mock('@/api/admin', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/admin')>()
  return {
    ...original,
    AdminApiError: class AdminApiError extends Error {
      readonly code: number
      readonly detail: unknown
      readonly status: number
      constructor(message: string, code = 1, detail?: unknown, status = 0) {
        super(message)
        this.name = 'AdminApiError'
        this.code = code
        this.detail = detail
        this.status = status
      }
    },
    extractApplyInvalidFiles: (detail: unknown) => {
      if (typeof detail !== 'object' || detail === null) return null
      const invalid = (detail as { invalid?: unknown }).invalid
      return Array.isArray(invalid) ? (invalid as never[]) : null
    },
    extractDetailMessage: (detail: unknown) => {
      if (typeof detail !== 'object' || detail === null) return null
      const message = (detail as { message?: unknown }).message
      return typeof message === 'string' ? message : null
    },
    fetchApplyPlan: mocks.fetchApplyPlan,
    executeApply: mocks.executeApply,
    fetchBackups: mocks.fetchBackups,
    rollbackBackup: mocks.rollbackBackup,
    fetchConfigFile: mocks.fetchConfigFile,
  }
})

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: () => ({ refresh: mocks.wsRefresh }),
}))

vi.mock('@/stores/configContext', () => ({
  useConfigContextStore: () => ({ load: mocks.ctxLoad }),
}))

vi.mock('element-plus', () => ({
  ElMessage: { success: mocks.messageSuccess, error: mocks.messageError },
}))

import { AdminApiError } from '@/api/admin'
import type { ApplyPlanFile } from '@/api/admin'
import { useApplyStore } from '@/stores/apply'

function planFile(path: string, overrides: Partial<ApplyPlanFile> = {}): ApplyPlanFile {
  return {
    path,
    status: 'modified',
    additions: 3,
    deletions: 1,
    diff: `--- a/${path}\n+++ b/${path}`,
    sourceContent: '{}',
    valid: true,
    schemaKind: null,
    validationErrors: [],
    ...overrides,
  }
}

async function loadTwoFilePlan(store: ReturnType<typeof useApplyStore>): Promise<void> {
  mocks.fetchApplyPlan.mockResolvedValue({
    files: [
      planFile('game/a.json'),
      planFile('game/b.json', {
        valid: false,
        validationErrors: [{ jsonPath: '$.a', message: '缺少字段 hp' }],
      }),
    ],
  })
  await store.loadPlan()
}

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.fetchApplyPlan.mockReset()
  mocks.executeApply.mockReset()
  mocks.fetchBackups.mockReset()
  mocks.rollbackBackup.mockReset()
  mocks.fetchConfigFile.mockReset()
  mocks.wsRefresh.mockReset()
  mocks.ctxLoad.mockReset()
  mocks.messageSuccess.mockReset()
  mocks.messageError.mockReset()
})

describe('useApplyStore', () => {
  it('loadPlan 拉取计划并重置勾选与标注', async () => {
    const store = useApplyStore()
    await loadTwoFilePlan(store)
    expect(store.plan).toHaveLength(2)
    expect(store.planLoaded).toBe(true)
    expect(store.validFiles).toHaveLength(1)
    expect(store.selected).toEqual([])
    expect(store.planError).toBeNull()
  })

  it('勾选管理：全选只含 valid，清空生效', async () => {
    const store = useApplyStore()
    // 两个 valid 文件：全选应只包含可落盘文件
    mocks.fetchApplyPlan.mockResolvedValue({
      files: [planFile('game/a.json'), planFile('game/b.json')],
    })
    await store.loadPlan()
    store.selectAllValid()
    expect([...store.selected].sort()).toEqual(['game/a.json', 'game/b.json'])
    expect(store.allSelected).toBe(true)
    store.toggleSelect('game/a.json')
    expect(store.allSelected).toBe(false)
    store.clearSelection()
    expect(store.hasSelection).toBe(false)

    // 含 invalid 文件的计划：全选必须跳过
    await loadTwoFilePlan(store)
    store.selectAllValid()
    expect(store.selected).toEqual(['game/a.json'])
  })

  it('execute 成功：回执 + 计划重置 + 联动刷新工作区/上下文/备份', async () => {
    const store = useApplyStore()
    await loadTwoFilePlan(store)
    mocks.executeApply.mockResolvedValue({
      backupId: 'bk-1',
      applied: [{ path: 'game/a.json', status: 'modified' }],
      durationMs: 3500,
    })
    mocks.fetchBackups.mockResolvedValue({ items: [] })
    store.selectAllValid()

    const outcome = await store.execute(['game/a.json'])
    expect(outcome.kind).toBe('success')
    expect(store.receipt?.backupId).toBe('bk-1')
    expect(store.receipt?.applied).toHaveLength(1)
    expect(store.planLoaded).toBe(false)
    expect(store.hasSelection).toBe(false)
    expect(mocks.wsRefresh).toHaveBeenCalledTimes(1)
    expect(mocks.ctxLoad).toHaveBeenCalledTimes(1)
    expect(mocks.fetchBackups).toHaveBeenCalledTimes(1)
  })

  it('execute 422 invalid：outcome 携带标注，计划保留', async () => {
    const store = useApplyStore()
    await loadTwoFilePlan(store)
    mocks.executeApply.mockRejectedValue(
      new AdminApiError(
        '存在未通过校验的文件',
        1,
        {
          invalid: [
            { path: 'game/a.json', validationErrors: [{ jsonPath: '$.a', message: '缺少 hp' }] },
          ],
        },
        422,
      ),
    )

    const outcome = await store.execute(['game/a.json'])
    expect(outcome.kind).toBe('invalid')
    if (outcome.kind === 'invalid') {
      expect(outcome.invalid[0]?.path).toBe('game/a.json')
    }
    expect(store.invalidMarks).toHaveLength(1)
    expect(store.planLoaded).toBe(true)
  })

  it('execute 422 整体校验未通过：使用 detail.message', async () => {
    const store = useApplyStore()
    await loadTwoFilePlan(store)
    mocks.executeApply.mockRejectedValue(
      new AdminApiError('整体校验未通过', 1, { message: '2 个文件未通过校验' }, 422),
    )
    const outcome = await store.execute(['game/a.json'])
    expect(outcome.kind).toBe('overall')
    if (outcome.kind === 'overall') expect(outcome.message).toBe('2 个文件未通过校验')
  })

  it('execute 409 → conflict', async () => {
    const store = useApplyStore()
    await loadTwoFilePlan(store)
    mocks.executeApply.mockRejectedValue(
      new AdminApiError('工作区已变化，请重新获取落盘计划', 1, undefined, 409),
    )
    const outcome = await store.execute(['game/a.json'])
    expect(outcome.kind).toBe('conflict')
  })

  it('rollback 成功：提示 + 联动刷新', async () => {
    const store = useApplyStore()
    mocks.rollbackBackup.mockResolvedValue({
      restored: [{ path: 'game/a.json', action: 'overwritten' }],
    })
    mocks.fetchBackups.mockResolvedValue({ items: [] })
    const ok = await store.rollback('bk-1')
    expect(ok).toBe(true)
    expect(mocks.messageSuccess).toHaveBeenCalledWith('已回滚 1 个文件')
    expect(mocks.wsRefresh).toHaveBeenCalledTimes(1)
    expect(mocks.ctxLoad).toHaveBeenCalledTimes(1)
    expect(mocks.fetchBackups).toHaveBeenCalledTimes(1)
  })

  it('rollback 409 busy：错误提示后端 message', async () => {
    const store = useApplyStore()
    mocks.rollbackBackup.mockRejectedValue(
      new AdminApiError('落盘/回滚进行中，请稍后', 1, undefined, 409),
    )
    const ok = await store.rollback('bk-2')
    expect(ok).toBe(false)
    expect(mocks.messageError).toHaveBeenCalledWith('落盘/回滚进行中，请稍后')
  })
})
