## 0. 目标与适用范围

- 目标：保证本项目在任何新增功能、修复缺陷或重构时，都能维持一致的目录结构、代码风格与模块边界，并通过自动化命令完成格式校验、类型检查、测试与构建验证。
- 范围：适用于 `src/` 全部代码（含 Vue 组件、TS 模块、样式、资源引用）、构建配置（Vite/TSConfig）与脚本（package.json）。
- 原则：最小改动、明确边界、可验证、可复现。

## 1. 技术栈与构建链路（以现状为准）

- 框架：Vue 3（SFC，`<script setup lang="ts">`）。
- 构建：Vite（`vite.config.ts`），ESM（`package.json#type=module`）。
- 语言：TypeScript（`vue-tsc --build`），多 TSConfig 引用（app/node）。
- 路由：Vue Router 5。
- 状态：Pinia（setup store 风格）。
- UI：`@pixelium/web-vue`（含图标包 `@pixelium/web-vue/icon-pa/es`）。
- 游戏：Excalibur 0.32 + `@excaliburjs/plugin-tiled`（地图、资源加载）。
- 样式：Tailwind CSS v4（通过 `@tailwindcss/vite`）。
- 格式化：Prettier（`.prettierrc.json`）。
- 测试：Vitest + @vue/test-utils（`vitest.config.ts`）。

## 2. 目录组织与模块分层

### 2.1 根目录

- `src/`：业务与游戏核心代码。
- `public/`：静态资源（地图 JSON、音频等，按 `/game/...` 运行时路径访问）。
- `vite.config.ts`：构建/别名/全局注入。
- `tsconfig*.json`：类型检查与路径映射。

### 2.2 src 分层（必须遵守）

- 本项目为“后台管理 + 游戏本体”同仓库共存的单体前端工程：
  - 后台管理：以路由 `/index` 为入口，页面主要位于 `src/views/`，布局位于 `src/layouts/`。
  - 游戏本体：以路由 `/game` 为入口，页面位于 `src/views/`（例如 `GameView.vue`），游戏 UI 组件位于 `src/components/GameUI/`，引擎逻辑位于 `src/game/`。
- `src/main.ts`：应用入口（只做 App 初始化、插件注册、全局样式引入）。
- `src/router/`：路由定义（懒加载 view/layout）。
- `src/stores/`：Pinia store（状态、派生状态、动作）。
- `src/views/`：页面级组件（路由直接加载的组件；既包含后台页面，也包含游戏页面）。
- `src/layouts/`：布局组件（承载导航/容器等）。
- `src/components/`：可复用 UI 组件（按业务域分子目录；游戏 UI 固定在 `GameUI/`）。
- `src/game/`：游戏引擎域（actors/scenes/resources/config 等）。
- `src/config/`：应用级配置与编译期注入（例如 `__APP_INFO__` 的封装访问）。

### 2.3 依赖方向（禁止反向依赖）

- `views/` 可以依赖 `components/`、`layouts/`、`stores/`、`game/`。
- `components/` 可以依赖 `stores/` 与同域子组件；避免直接依赖 `router/`（除非明确为路由组件）。
- `game/` 禁止依赖 `views/`、`layouts/`、`router/`、`stores/`、`@pixelium/web-vue` 等 UI 层；UI 与游戏通过“薄适配层”交互（事件/方法/数据映射）。
- `config/` 仅提供只读配置访问，禁止引入业务组件。

## 3. 路径别名与导入规则

- 必须优先使用别名导入，避免长相对路径：
  - `@/` → `src/`
  - `game/` → `src/game/`
  - `components/` → `src/components/`
  - `layouts/` → `src/layouts/`
  - `views/` → `src/views/`
- 同一文件中导入顺序（从上到下）：
  1. 三方库
  2. 项目内别名导入
  3. 相对路径导入（同目录、子目录）
  4. 样式/资源导入
- 禁止重复导入同一模块（例如同一个 `vue` 同时出现多行导入）。

## 4. 代码风格标准（强制）

### 4.1 Prettier 统一格式（以 `.prettierrc.json` 为准）

- `semi: false`
- `singleQuote: true`
- `printWidth: 100`
- 所有提交前必须通过格式检查；如需批量格式化使用 `pnpm format`。

### 4.2 TypeScript 约束

- 不得使用 `any` 绕过类型（除非用于三方库缺失类型且有最小范围封装）。
- 公共导出必须有明确类型（函数返回值、对象结构、事件 payload）。
- 优先使用联合类型与字面量类型表达状态（例如方向 `'上' | '下' | '左' | '右'`）。

### 4.3 Vue 组件约定

- 必须使用 `<script setup lang="ts">`（与现有代码一致）。
- 组件文件名使用 PascalCase（例如 `GameView.vue`），目录按业务域拆分。
- Props/Emits：
  - Props 使用 `kebab-case` 传递，脚本侧使用 `camelCase` 定义。
  - Emits 命名使用 `camelCase`，事件语义使用动词开头（`toggleXxx` / `openXxx` / `updateXxx`）。
- Slot：命名 slot 使用小写单词或短语（现有 `content`），避免过多层级。

### 4.4 Tailwind 使用规范

- 页面/布局组件允许更长的 class 列表；可复用组件若 class 复杂，优先拆分为子组件或提取为计算属性。
- 禁止在 class 中混入不确定的字符串拼接（除非用于明确的条件类名且可读）。

## 5. 命名规范（强制）

- Vue 组件：
  - 文件/组件名：PascalCase
  - 组件目录：PascalCase 或业务域名（现状 `GameUI/`）
- TS 模块：
  - 文件名：lowerCamelCase（现状多为小写单词，如 `resources.ts`、`player.ts`）
  - 类型：PascalCase（`Config`）
  - 常量：camelCase 或 SCREAMING_SNAKE_CASE（二选一，单文件内保持一致）
- 路由：
  - `name`：PascalCase
  - `path`：kebab-case（`/game`、`/index`）

## 6. 模块划分原则（强制）

- UI 层（views/layouts/components）只负责展示与交互，不直接处理引擎细节。
- 游戏域（src/game）只负责可复用的引擎逻辑（场景、角色、资源、配置），不渗透 UI 组件、后台管理页面与路由。
- 后台管理与游戏本体的边界：
  - 后台页面（例如 `src/views/IndexView.vue`）不得直接依赖 `src/game/` 的内部实现细节；如需展示数据，应通过游戏对外入口或独立的数据层完成。
  - 游戏 UI（`src/components/GameUI/`）可以依赖 `src/game/` 的对外入口与类型，但不得把 UI 组件下沉到 `src/game/`。
- 跨域交互只通过：
  - 明确的函数入口（例如 `initGame(canvas)`）
  - 明确的数据结构（类型定义集中在相应域内）
  - 明确的事件/回调（由调用方注入）

### 6.1 游戏 ↔ UI 桥接层（强制）

- 目标：让 UI 与游戏引擎解耦，UI 只面向“状态 + 指令 + 事件”，不直接触碰引擎对象（Engine/Scene/Actor）。
- 位置约定：
  - 协议类型：`src/game/type.ts`（`GameBridge`/`GameUIState`/`GameUIEvent`/`GameCommand`）
  - 纯实现：`src/game/bridge.ts`（`createGameBridge`，不依赖 Vue/Pinia）
  - 游戏对外入口：`src/game/index.ts`（`initGame` 返回 `GameController`，并提供 `destroyGame`）
- UI 侧接入规则：
  - `views/GameView.vue` 只负责初始化与销毁：初始化后把 `bridge` 作为 props 传给 UI 组件；卸载时必须销毁（避免路由切换/热更新资源泄漏）。
  - `components/GameUI/*` 只通过 `bridge.subscribe(...)` 接收事件、通过 `bridge.dispatch(...)` 下发指令；禁止 import `MyGame` 或依赖 `Engine`。
- 事件与指令规则：
  - 事件必须是带 `type` 的联合类型（例如 `state`/`message`），便于扩展与稳定演进。
  - 指令必须是带 `type` 的联合类型（例如 `togglePause`/`dealDamage`），UI 侧不直接修改游戏状态。
- 状态推送规则：
  - 游戏侧可以对 state 推送做节流（例如 100ms 一次），避免每帧触发 UI 大量渲染。
  - UI 侧订阅后应立即收到一次 state，用于首屏渲染与断线重连式初始化。

## 7. API 设计模式（前端/模块 API）

### 7.1 内部模块 API

- 每个“域”对外暴露一个最小入口：
  - `game/` 对外暴露：初始化、生命周期控制、必要的查询/命令接口。
- 对外导出必须稳定、可测试：
  - 不导出易变的内部单例状态（如需单例，提供函数封装访问并限制写入）。

### 7.2 网络 API（未来新增时必须遵守）

- 新增网络请求统一放入 `src/api/`（按业务域拆分文件）。
- 必须提供：
  - 请求/响应 DTO 类型
  - 统一的错误处理与错误码映射
  - 业务层只依赖 API 模块导出的函数，不直接使用 `fetch`/`axios`

## 8. 测试要求与覆盖率目标

- 测试框架：Vitest（单元/组件测试）。
- 测试文件命名：`*.spec.ts` 或 `*.test.ts`，建议放在 `__tests__/` 目录下（与现有 tsconfig 排除规则一致）。
- 覆盖率目标（阶段性）：
  - 阶段 1（当前）：新增/修改的关键逻辑必须补齐测试；生成覆盖率报告即可。
  - 阶段 2：整体行覆盖率 ≥ 60%（逐步抬升）。
  - 阶段 3：整体行覆盖率 ≥ 80%，并引入阈值强制校验。

## 9. 自动化检查（每次变更必须执行）

### 9.1 必跑命令（本地与 CI 一致）

- 格式检查：`pnpm lint`
- 类型检查：`pnpm type-check`
- 测试：`pnpm test`
- 构建：`pnpm build-only`
- 一键校验：`pnpm check:all`

### 9.2 通过标准

- `lint`/`type-check`/`test`/`build-only` 全部为 0 退出码。
- `test:coverage` 生成覆盖率报告（`coverage/`），并在阶段 2/3 开启阈值强制。
