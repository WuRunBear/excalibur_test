/**
 * Monaco 编辑器接入（S2-B）。
 *
 * - 按需引入：editor.api（编辑器核心，不含语言贡献与编辑器动作）+ JSON 语言贡献 +
 *   format 动作贡献（editor.action.formatDocument），不引入全量 editor.main，控制产物体积；
 * - monaco 0.56 exports 映射 `./*` → `./esm/vs/*.js`，子路径写法为
 *   `monaco-editor/editor/editor.api` 等（不再是 `esm/vs/...` 前缀）；
 * - Vite `?worker` 语法接线 editor.worker / json.worker，按 label 分发
 *   （monaco 0.56 契约：MonacoEnvironment.getWorker(workerId, label)）；
 * - JSON 启用语法 / 诊断校验（游戏配置为严格 JSON，注释按错误处理）；
 * - 自定义 admin-light 主题：白底 + 墨青选区，贴合管理平台观感。
 */
import * as monaco from 'monaco-editor/editor/editor.api'
// 「格式化」动作链：editor.action.formatDocument 由 contrib/format 注册，
// 仅随 editor.main 打包——editor.api（核心）不含任何编辑器动作，必须显式引入
// 本贡献模块，否则 ed.getAction('editor.action.formatDocument') 恒为 undefined
//（表现为点击格式化后内容不变、无报错）。
import 'monaco-editor/editor/contrib/format/browser/formatActions'
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
