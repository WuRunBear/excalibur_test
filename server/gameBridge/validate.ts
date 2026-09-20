/**
 * 整体配置校验（S2-A，Spike-2 结论的进程内复用实现）。
 *
 * Spike-2 结论：本体 tools/validate.ts 的 validate() 在校验失败路径直接
 * process.exit(1)（见 <GAME_ROOT>/tools/validate.ts 的 catch 分支，"process.exit(1)"），
 * 属 CLI 副作用，不能在本进程内复用——否则一次校验失败会杀死整个管理后端。
 *
 * 正确做法（本文件）：直接 import 门面导出的无副作用核心函数——
 * - bootstrapFramework()：幂等单例（framework/bootstrap.ts 首次调用后缓存），
 *   必须先于 loadGameDefinition 调用；
 * - loadGameDefinition({ gameJsonPath })：纯加载 + zod/完整性校验，不写全局注册表，
 *   可重复调用；失败 throw，message 含原因。
 *
 * gameJsonPath 用绝对路径即可：loadGameDefinition 内部 baseDir =
 * resolve(cwd, dirname(gameJsonPath))，绝对路径下 dirname 已绝对化，与 cwd 无关
 * （探针实测：镜像副本在任意 cwd 下校验通过，缺失文件 throw 含路径的 message）。
 */
import { bootstrapFramework, loadGameDefinition } from 'framework'
import fs from 'node:fs'

export interface ValidateWholeResult {
  ok: boolean
  message: string
}

/**
 * 对指定 game.json（绝对路径）做整体校验：bootstrap → loadGameDefinition → 汇总。
 * 永不 throw、永不退出进程；结果以返回值表达。
 *
 * 注意：本体 loadGameDefinition 对不存在的 game.json 会静默回退
 * createDefaultGameDefinition()（loadGameDefinition.ts 的 existsSync 分支），
 * 因此这里必须先做存在性预检，否则镜像缺失 game.json 会被误报"校验通过"。
 */
export function validateWholeConfig(absGameJsonPath: string): ValidateWholeResult {
  if (!fs.existsSync(absGameJsonPath)) {
    return { ok: false, message: `game.json 不存在：${absGameJsonPath}` }
  }
  try {
    bootstrapFramework()
    const def = loadGameDefinition({ gameJsonPath: absGameJsonPath })
    return {
      ok: true,
      message:
        `校验通过：实体原型 ${def.resolvedEntities.length} 个，行为树 ${def.resolvedBehaviors.length} 个，` +
        `规则 ${Object.keys(def.resolvedRules).length} 个，item ${def.resolvedItems.length} 个，` +
        `地图 ${def.resolvedMapConfigs.map((c) => c.key).join(', ')}`,
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
