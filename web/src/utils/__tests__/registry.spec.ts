import { describe, expect, it } from 'vitest'

import { entryMatches, normalizeRegistryEntries } from '@/utils/registry'

describe('normalizeRegistryEntries', () => {
  it('对象数组：取 id/key/name 类字段，name 与 id 相同时不重复展示', () => {
    const entries = normalizeRegistryEntries([
      { id: 'movement', description: '移动系统' },
      { key: 'combat', name: 'combat', factory: '被剥离的函数字段' },
      { name: 'only-name' },
      '纯字符串条目',
    ])
    expect(entries[0]).toEqual({ id: 'movement', name: null, description: '移动系统' })
    expect(entries[1]).toEqual({ id: 'combat', name: null, description: null })
    expect(entries[2]).toEqual({ id: 'only-name', name: null, description: null })
    expect(entries[3]).toEqual({ id: '纯字符串条目', name: null, description: null })
  })

  it('对象（键值表）：键作为 id（components 只取键的形态）', () => {
    const entries = normalizeRegistryEntries({
      Position: null,
      Health: null,
    })
    expect(entries).toEqual([
      { id: 'Position', name: null, description: null },
      { id: 'Health', name: null, description: null },
    ])
  })

  it('非法形态返回空数组', () => {
    expect(normalizeRegistryEntries(null)).toEqual([])
    expect(normalizeRegistryEntries(42)).toEqual([])
  })
})

describe('entryMatches', () => {
  const entry = { id: 'MovementSystem', name: '移动', description: '按 tick 移动实体' }

  it('命中 id / name / description（大小写不敏感）', () => {
    expect(entryMatches(entry, 'movement')).toBe(true)
    expect(entryMatches(entry, '移動')).toBe(false)
    expect(entryMatches(entry, '移动')).toBe(true)
    expect(entryMatches(entry, 'TICK')).toBe(true)
    expect(entryMatches(entry, 'combat')).toBe(false)
  })

  it('空关键词全命中', () => {
    expect(entryMatches(entry, '  ')).toBe(true)
  })
})
