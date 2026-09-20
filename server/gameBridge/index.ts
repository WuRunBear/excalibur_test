export {
  listRegisteredSystems,
  listRegisteredArchetypes,
  listRegisteredActions,
  listRegisteredComponents,
  listRegisteredMapGenerators,
  validateGameDefinition,
} from 'framework/api'
// GameDefinitionSchema 不在 framework/api.ts 中导出（api.ts 仅内部 import），
// 由本体门面 framework/index.ts 再导出，故此处单独从 'framework' 引入。
export {
  GameDefinitionSchema,
  CombatRuleSchema,
  NeedsRuleSchema,
  CraftingRuleSchema,
  DayNightRuleSchema,
  ServerRuleSchema,
  bootstrapFramework,
  loadGameDefinition,
} from 'framework'
// ArchetypeSchema / MapRegistrySchema 未走门面再导出（S2-A 侦察确认
// framework/index.ts 仅导出 GameDefinition/ItemKind/Rule 系 schema），
// 只能经别名子路径引入（S1-C tsconfig paths 已配 framework/*）。
export { ArchetypeSchema } from 'framework/config/schema/ArchetypeSchema'
export { MapRegistrySchema } from 'framework/config/schema/MapRegistrySchema'

// 整体校验（Spike-2 结论见 ./validate.ts 头注释）
export { validateWholeConfig, type ValidateWholeResult } from './validate.js'

// ---------------------------------------------------------------------------
// S5-A：地图几何（纯函数，不启动游戏）
// ---------------------------------------------------------------------------
export {
  getRegistries,
  buildMapGeometry,
  serializeGeometry,
  exportGeometryArtifacts,
} from 'framework'
export type {
  SerializedMapGeometry,
  MapGeometry,
  GeometryExportOptions,
  TilePalette,
  FrameworkRegistries,
  SystemSpec,
  ArchetypeSpec,
  ActionEntry,
} from 'framework'
// MapGenerationConfig / GeneratorEntry 未走门面再导出，经别名子路径引入；
// mapGeneratorRegistry.all() 的条目类型即 GeneratorEntry { id, generator }。
export type { MapGenerationConfig } from 'map/generate/types'
export type { GeneratorEntry } from 'map/generate/generatorRegistry'
