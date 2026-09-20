/**
 * 工作区改动状态展示工具（S3-B）。
 * 改动状态 tag 的文案与颜色映射，工作区页 / 配置上下文卡共用。
 */
import type { WorkspaceChangeStatus } from '@/api/admin'

/** 状态中文名（新增 / 修改 / 删除）。 */
export const WORKSPACE_CHANGE_TEXT: Record<WorkspaceChangeStatus, string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
}

/** 状态 → Element Plus tag 类型：added=绿 / modified=琥珀 / deleted=红。 */
export function workspaceChangeTagType(
  status: WorkspaceChangeStatus,
): 'success' | 'warning' | 'danger' {
  if (status === 'added') return 'success'
  if (status === 'modified') return 'warning'
  return 'danger'
}
