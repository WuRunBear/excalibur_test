# excalibur_test

一个基于 Vue 3 + Vite + TypeScript + Excalibur.js 的游戏开发模板。

项目同时包含：
- 游戏本体：路由 `/game`，基于 Excalibur 的 Canvas 渲染 + Vue UI 叠层
- 简单后台：路由 `/index`，用于放置管理/调试页面

## 技术栈

- Vue 3 + Vite
- TypeScript（`vue-tsc --build`）
- Excalibur 0.32（含 `@excaliburjs/plugin-tiled`）
- Pinia
- Vue Router 5
- Tailwind CSS v4
- UI 组件库：`@pixelium/web-vue`
- 测试：Vitest + `@vue/test-utils`

## 环境要求

- Node：`^20.19.0 || >=22.12.0`
- 包管理器：pnpm

## 快速开始

安装依赖：

```sh
pnpm install
```

启动开发环境：

```sh
pnpm dev
```

本地预览生产构建：

```sh
pnpm build-only
pnpm preview
```

## 常用命令

- 开发：`pnpm dev`
- 构建（包含类型检查）：`pnpm build`
- 仅构建：`pnpm build-only`
- 类型检查：`pnpm type-check`
- 格式化：`pnpm format`
- 格式检查：`pnpm lint`
- 测试：`pnpm test`
- 测试（监听）：`pnpm test:watch`
- 测试覆盖率：`pnpm test:coverage`
- 一键检查：`pnpm check`（lint + type-check + test）
- 全量检查：`pnpm check:all`（lint + type-check + test + build-only）

## 目录结构

- `src/views/`
  - `GameView.vue`：游戏入口页（Canvas + UI）
  - `IndexView.vue`：后台首页
- `src/components/GameUI/`：游戏 UI 组件（ActionBar、MiniMap、提示面板等）
- `src/game/`：游戏引擎域（场景、角色、资源加载、配置）
- `src/router/index.ts`：路由定义（`/` 默认重定向到 `/game`）
- `public/game/`：游戏静态资源（运行时通过 `/game/...` 路径访问）

## 资源放置与访问

`public/` 下的资源会原样复制到构建产物中，建议按约定放在 `public/game/`：
- 地图：`public/game/map/`
- 音频：`public/game/music/`

在代码中访问时使用以 `/game/...` 开头的路径。
