/**
 * SchemaForm 的纯逻辑层（§3.5）：节点形态判定、oneOf 判别、默认值骨架、
 * JSON pointer 工具。与组件解耦以便单测；全部函数无副作用（返回新结构）。
 */
import type {
  Discriminator,
  DiscriminatorOption,
  EnumOption,
  JsonSchemaNode,
  SchemaInfo,
} from './types'

/** 递归渲染深度兜底（防病态 schema 打爆组件栈）；超限按 unknown 只读渲染。 */
export const MAX_RENDER_DEPTH = 24

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** structuredClone 优先（保留 undefined 等形态），不可用时 JSON 兜底。 */
export function cloneJson<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value)
    } catch {
      /* 数据含不可克隆值时走 JSON 兜底 */
    }
  }
  return JSON.parse(JSON.stringify(value ?? null)) as T
}

/** JSON pointer 片段转义（RFC 6901：~ → ~0，/ → ~1）。 */
function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1')
}

function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~')
}

/** 拼接子指针；父指针为空串（根）时产出 "/key"。 */
export function pointerJoin(parent: string, key: string | number): string {
  return `${parent}/${escapePointerToken(String(key))}`
}

/** 取指针末段作为节点缺省标题（如 "/systems/0/config" → "config"）。 */
export function pointerLeaf(pointer: string): string {
  const last = pointer.split('/').pop() ?? ''
  return unescapePointerToken(last)
}

/** 精确命中某字段的错误文案（errors 键为 JSON pointer 风格路径）。 */
export function errorAt(
  errors: Record<string, string> | undefined,
  pointer: string,
): string | undefined {
  if (!errors) return undefined
  const message = errors[pointer]
  return typeof message === 'string' && message.length > 0 ? message : undefined
}

/** 子树内（含自身）是否存在错误：用于容器节点标红提示。 */
export function errorInSubtree(
  errors: Record<string, string> | undefined,
  pointer: string,
): boolean {
  if (!errors) return false
  if (errorAt(errors, pointer) !== undefined) return true
  const prefix = `${pointer}/`
  return Object.keys(errors).some((key) => key.startsWith(prefix))
}

/**
 * 节点形态判定（渲染映射表）：
 * - string→input、number/integer→InputNumber、boolean→switch
 * - enum（含 oneOf/anyOf 全标量 const 分支）→ select
 * - array→可增删列表；object→折叠分组；object 无 properties→record 键值行
 * - oneOf/anyOf + literal 判别 → kind 选择器 + 子表单
 * - $ref/definitions/allOf/无法判定 → unknown（只读 JSON 兜底，不崩）
 */
export function describeSchema(schema: JsonSchemaNode): SchemaInfo {
  if (!isPlainObject(schema)) return { kind: 'unknown' }
  if (typeof schema.$ref === 'string' || Array.isArray(schema.allOf)) return { kind: 'unknown' }

  if (schema.const !== undefined && !isPlainObject(schema.const) && !Array.isArray(schema.const)) {
    return { kind: 'const' }
  }

  const branches = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : null
  if (branches && branches.length > 0) {
    const scalarOptions = scalarConstOptions(branches)
    if (scalarOptions) return { kind: 'enum', enumOptions: scalarOptions }
    const discriminator = getDiscriminator(branches)
    if (discriminator) return { kind: 'oneOf', discriminator }
    return { kind: 'unknown' }
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const options = schema.enum.filter(isEnumScalar).map((value) => ({
      value,
      label: String(value),
    }))
    if (options.length > 0) return { kind: 'enum', enumOptions: options }
    return { kind: 'unknown' }
  }

  switch (normalizeType(schema.type)) {
    case 'string':
      return { kind: 'string' }
    case 'boolean':
      return { kind: 'boolean' }
    case 'number':
      return { kind: 'number' }
    case 'integer':
      return { kind: 'integer' }
    case 'array': {
      if (!isPlainObject(schema.items)) return { kind: 'unknown' }
      const itemInfo = describeSchema(schema.items)
      return { kind: 'array', items: schema.items, itemInfo }
    }
    case 'object': {
      // properties 键存在（即使为空，如剔除判别字段后的 oneOf 分支）→ object；
      // 无 properties → additionalProperties 键值行（record，如 maps 注册表）
      if (isPlainObject(schema.properties)) return { kind: 'object' }
      const additional = schema.additionalProperties
      if (isPlainObject(additional)) {
        return {
          kind: 'record',
          recordValue: additional,
          recordValueInfo: describeSchema(additional),
        }
      }
      // 值结构未知（z.record(string, unknown)）：键可增删，值按 unknown 只读渲染
      return { kind: 'record', recordValue: null, recordValueInfo: { kind: 'unknown' } }
    }
    default:
      return { kind: 'unknown' }
  }
}

function normalizeType(type: JsonSchemaNode['type']): string | null {
  if (typeof type === 'string') return type
  if (Array.isArray(type)) {
    // zod .nullable() 等产出 ["T","null"]：取首个非 null 类型渲染
    const first = type.find((entry) => entry !== 'null')
    return typeof first === 'string' ? first : null
  }
  return null
}

function isEnumScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/** oneOf/anyOf 全部分支都是标量 const → 视作枚举（label 用分支 title）。 */
function scalarConstOptions(branches: JsonSchemaNode[]): EnumOption[] | null {
  const options: EnumOption[] = []
  for (const branch of branches) {
    if (!isPlainObject(branch)) return null
    const value = branch.const
    if (!isEnumScalar(value)) return null
    options.push({ value, label: typeof branch.title === 'string' ? branch.title : String(value) })
  }
  return options
}

/**
 * 在 oneOf 分支集合中找 literal 判别字段（如 map 的 kind: pipeline/tiled）：
 * 该字段须在所有分支中出现且取值为互不重复的字符串字面量（const 或单值 enum）。
 */
export function getDiscriminator(branches: JsonSchemaNode[]): Discriminator | null {
  if (branches.length === 0) return null
  const literalMaps = branches.map((branch) => {
    const literals = new Map<string, string>()
    if (isPlainObject(branch) && isPlainObject(branch.properties)) {
      const properties = branch.properties as Record<string, JsonSchemaNode>
      for (const [key, propSchema] of Object.entries(properties)) {
        if (!isPlainObject(propSchema)) continue
        if (typeof propSchema.const === 'string') {
          literals.set(key, propSchema.const)
        } else if (
          Array.isArray(propSchema.enum) &&
          propSchema.enum.length === 1 &&
          typeof propSchema.enum[0] === 'string'
        ) {
          literals.set(key, propSchema.enum[0])
        }
      }
    }
    return literals
  })

  const first = literalMaps[0]
  if (!first) return null
  for (const [property] of first) {
    const options: DiscriminatorOption[] = []
    const seen = new Set<string>()
    let ok = true
    for (let index = 0; index < branches.length; index += 1) {
      const value = literalMaps[index]?.get(property)
      if (value === undefined || seen.has(value)) {
        ok = false
        break
      }
      seen.add(value)
      const branch = branches[index]
      if (!branch) {
        ok = false
        break
      }
      options.push({
        value,
        label: typeof branch.title === 'string' ? branch.title : value,
        branch,
      })
    }
    if (ok) return { property, options }
  }
  return null
}

/**
 * 构建节点初始值骨架（新增数组项 / oneOf 切换分支时用）：
 * 优先 schema.default；object 仅填 required 或带 default 的属性，保持草稿精简。
 */
export function buildDefault(schema: JsonSchemaNode): unknown {
  if (!isPlainObject(schema)) return null
  if (schema.default !== undefined) return cloneJson(schema.default)

  const info = describeSchema(schema)
  switch (info.kind) {
    case 'const':
      return schema.const
    case 'enum':
      return info.enumOptions?.[0]?.value ?? null
    case 'string':
      return ''
    case 'number':
    case 'integer':
      return typeof schema.minimum === 'number' ? schema.minimum : 0
    case 'boolean':
      return false
    case 'array': {
      // minItems ≥ 1（如 pipeline min(1)）时预置一项，减少一次必点操作
      const minItems = typeof schema.minItems === 'number' ? schema.minItems : 0
      if (minItems >= 1 && info.items) return [buildDefault(info.items)]
      return []
    }
    case 'object': {
      const out: Record<string, unknown> = {}
      const required = Array.isArray(schema.required) ? schema.required : []
      const properties = schema.properties
      if (isPlainObject(properties)) {
        for (const [key, propSchema] of Object.entries(properties)) {
          if (!isPlainObject(propSchema)) continue
          if (required.includes(key) || propSchema.default !== undefined) {
            out[key] = buildDefault(propSchema)
          }
        }
      }
      return out
    }
    case 'record':
      return {}
    case 'oneOf': {
      const firstBranch = info.discriminator?.options[0]?.branch
      return firstBranch ? buildDefault(firstBranch) : {}
    }
    default:
      return null
  }
}

/**
 * 按指针在副本上写值（不可变更新，供根组件 emit update:modelValue）。
 * 指针为空串视为整体替换；中途缺失的容器按后续 token 形态补建。
 */
export function setAtPath(root: unknown, pointer: string, value: unknown): unknown {
  if (pointer === '' || pointer === '/') return value
  const next = root === null || root === undefined ? {} : cloneJson(root)
  if (!isPlainObject(next) && !Array.isArray(next)) return value

  const tokens = pointer
    .split('/')
    .slice(1)
    .map((token) => unescapePointerToken(token))
  let cursor: unknown = next

  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index] as string
    const cursorIsArray = Array.isArray(cursor)
    let child: unknown
    if (cursorIsArray) {
      child = (cursor as unknown[])[Number(token)]
    } else if (isPlainObject(cursor)) {
      child = (cursor as Record<string, unknown>)[token]
    } else {
      return next
    }
    if (!isPlainObject(child) && !Array.isArray(child)) {
      child = /^\d+$/.test(tokens[index + 1] as string) ? [] : {}
      if (cursorIsArray) (cursor as unknown[])[Number(token)] = child
      else (cursor as Record<string, unknown>)[token] = child
    }
    cursor = child
  }

  const last = tokens[tokens.length - 1] as string
  if (Array.isArray(cursor)) (cursor as unknown[])[Number(last)] = value
  else if (isPlainObject(cursor)) (cursor as Record<string, unknown>)[last] = value
  return next
}
