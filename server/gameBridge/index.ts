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

// ---------------------------------------------------------------------------
// S7-A：liveState 观察客户端（Colyseus）——schema-less 说明
// ---------------------------------------------------------------------------
// 不引入本体 src/network/colyseus/client-schema/schema.ts：该文件在管理后端
// 的 tsconfig/tsx 装饰器 emit 下模块加载即崩溃（@colyseus/schema annotations
// target.constructor undefined——本体按其自身 tsconfig 维护，跨仓复用 emit 不
// 兼容，S7-A 实测）。@colyseus/sdk 0.17 客户端可在无 schema 类的情况下按服务端
// 下发的 schema spec 动态解码状态（探针实测 tick/players/visibleEntities 数值
// 正确），liveState 用最小结构接口（RoomStateView）访问。
