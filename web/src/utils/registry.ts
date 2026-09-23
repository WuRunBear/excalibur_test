/**
 * 注册表条目归一化（S6-B）。
 *
 * GET games/:gameId/registries 的五类条目形状各异（systems/archetypes 为对象数组、
 * actions 含 name、components 只取键、mapGenerators 为 {id} 数组），
 * 这里统一归一化为 { id, name, description }，宽容未知字段与未知形状。
 */

export interface RegistryEntry {
  id: string
  /** 与 id 不同时才展示，避免重复 */
  name: string | null
  description: string | null
}

function firstStringOf(node: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = node[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function toEntry(item: unknown, fallbackId?: string): RegistryEntry {
  if (typeof item === 'string') {
    return { id: item, name: null, description: null }
  }
  if (typeof item !== 'object' || item === null) {
    const id = fallbackId ?? String(item)
    return { id, name: null, description: null }
  }
  const record = item as Record<string, unknown>
  const id = firstStringOf(record, ['id', 'key', 'name', 'type']) ?? fallbackId ?? '(未命名)'
  const name = firstStringOf(record, ['name', 'title', 'label'])
  const description = firstStringOf(record, ['description', 'desc', 'summary', 'comment', 'doc'])
  return { id, name: name !== null && name !== id ? name : null, description }
}

/** 数组 → 条目数组；对象 → 键作为 id 的条目数组；其余 → 空数组。 */
export function normalizeRegistryEntries(value: unknown): RegistryEntry[] {
  if (Array.isArray(value)) {
    return value.map((item, index) => toEntry(item, String(index)))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value as Record<string, unknown>).map(([key, item]) => toEntry(item, key))
  }
  return []
}

/** 条目是否命中搜索词（id / name / description，大小写不敏感）。 */
export function entryMatches(entry: RegistryEntry, query: string): boolean {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return true
  return (
    entry.id.toLowerCase().includes(keyword) ||
    (entry.name !== null && entry.name.toLowerCase().includes(keyword)) ||
    (entry.description !== null && entry.description.toLowerCase().includes(keyword))
  )
}
