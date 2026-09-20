/**
 * Monaco 编辑器接入（S2-B）。
 *
 * - 按需引入：editor.api（核心 + 全部编辑器特性）与 JSON 语言贡献，
 *   不引入全语言入口（monaco-editor 根导出含所有语言），控制产物体积；
 * - monaco 0.56 exports 映射 `./*` → `./esm/vs/*.js`，子路径写法为
 *   `monaco-editor/editor/editor.api` 等（不再是 `esm/vs/...` 前缀）；
 * - Vite `?worker` 语法接线 editor.worker / json.worker，按 label 分发
 *   （monaco 0.56 契约：MonacoEnvironment.getWorker(workerId, label)）；
 * - JSON 启用语法 / 诊断校验（游戏配置为严格 JSON，注释按错误处理）；
 * - 自定义 admin-light 主题：白底 + 墨青选区，贴合管理平台观感。
 */
import * as monaco from 'monaco-editor/editor/editor.api'
import { jsonDefaults } from 'monaco-editor/languages/features/json/register'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker?worker'

globalThis.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'json') return new jsonWorker()
    return new editorWorker()
  },
}

jsonDefaults.setDiagnosticsOptions({
  validate: true,
  allowComments: false,
  schemas: [],
  enableSchemaRequest: false,
})

monaco.editor.defineTheme('admin-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editorLineNumber.foreground': '#b3bac2',
    'editorLineNumber.activeForeground': '#0f766e',
    'editor.selectionBackground': '#cee7e4',
    'editor.lineHighlightBackground': '#f4f7f6',
    'editorGutter.background': '#ffffff',
  },
})

export default monaco
export { monaco }
