import {
  listRegisteredSystems,
  listRegisteredArchetypes,
  GameDefinitionSchema,
} from './index.js'

console.log('[spike-1] framework/api 别名解析成功')
console.log(
  '[spike-1] GameDefinitionSchema 安全解析:',
  JSON.stringify(GameDefinitionSchema.safeParse({ id: 'x', name: 'x' }).success),
)
console.log(
  '[spike-1] listRegistered* 函数类型:',
  typeof listRegisteredSystems,
  typeof listRegisteredArchetypes,
)
