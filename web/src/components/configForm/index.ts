/**
 * configForm 公共出口（§3.5 表单渲染器）。
 * ConfigView 表单模式（P2）经此引入，内部实现细节不外泄。
 */
export { default as SchemaForm } from './SchemaForm.vue'
export { default as DescriptionHelp } from './DescriptionHelp.vue'
export { default as RefSelect } from './RefSelect.vue'
export { default as SystemsPanel } from './SystemsPanel.vue'
export * from './schemaUtils'
export * from './refSources'
export type {
  Discriminator,
  DiscriminatorOption,
  EnumOption,
  JsonSchemaNode,
  SchemaInfo,
  SchemaKind,
} from './types'
