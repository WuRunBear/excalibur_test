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
export { GameDefinitionSchema } from 'framework'
