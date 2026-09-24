/**
 * configForm 共享类型（§3.5 表单渲染器）。
 *
 * SchemaForm 消费 sidecar `getSchema(kind)` 产出的 JSON Schema
 * （z.toJSONSchema，reused:"inline"，约定内联无 $ref/definitions）。
 * 类型刻意宽松：未知字段透传保留，渲染层按 describeSchema 判定节点形态，
 * 不认识的节点回落只读 JSON 提示（不崩）。
 */
export interface JsonSchemaNode {
  type?: string | string[]
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  items?: JsonSchemaNode
  enum?: Array<string | number | boolean | null>
  const?: string | number | boolean | null
  oneOf?: JsonSchemaNode[]
  anyOf?: JsonSchemaNode[]
  allOf?: JsonSchemaNode[]
  $ref?: string
  definitions?: Record<string, JsonSchemaNode>
  title?: string
  description?: string
  default?: unknown
  format?: string
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  examples?: unknown[]
  additionalProperties?: JsonSchemaNode | boolean
  [key: string]: unknown
}

/** 枚举下拉选项（value 限定标量）。 */
export interface EnumOption {
  label: string
  value: string | number | boolean
}

/** oneOf 判别联合：单个分支选项。 */
export interface DiscriminatorOption {
  /** 判别字段取值（kind 的字面量）。 */
  value: string
  /** 下拉展示名（分支 title 优先，缺省用字面量）。 */
  label: string
  /** 该取值对应的分支 schema。 */
  branch: JsonSchemaNode
}

export interface Discriminator {
  /** 判别字段名（如 map 条目的 "kind"）。 */
  property: string
  options: DiscriminatorOption[]
}

export type SchemaKind =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'const'
  | 'array'
  | 'object'
  | 'record'
  | 'oneOf'
  | 'unknown'

/** describeSchema 的判定结果（渲染映射依据）。 */
export interface SchemaInfo {
  kind: SchemaKind
  enumOptions?: EnumOption[]
  discriminator?: Discriminator
  /** array 的 items 节点与判定结果。 */
  items?: JsonSchemaNode
  itemInfo?: SchemaInfo
  /** record 的 additionalProperties 值节点（null = 值结构未知）。 */
  recordValue?: JsonSchemaNode | null
  recordValueInfo?: SchemaInfo
}
