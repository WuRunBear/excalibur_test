# excalibur_test — 游戏服务端可视化管理平台

对 2D 游戏服务端 [game_server_test](../game_server_test)（Colyseus）的**只读包裹**式可视化管理平台：配置编辑 → 校验 → 预览 → 落盘 → 运行观察的完整闭环，本体仓库零代码改动。

## 能力闭环

```
新建工作区（镜像本体 game/ + 基准指纹）
      │
      ▼
配置编辑（Monaco + schema 校验 + 错误定位）
      │
      ▼
预览实例 :3200（注入工作区配置，观察真实运行效果）
      │
      ▼
落盘（diff 审查 → 整体校验终门 → 自动备份 → 写回本体）
      │                        │
      ▼                        ▼
正式实例 :3000 重启生效    备份一键回滚
      │
      ▼
运行观察（双实例日志流 / PlayView 实时渲染 / ECharts 趋势）
```

## 功能总览（八大域）

| 功能域 | 说明 |
|---|---|
| 实例管理 | 正式/预览双实例网页启停重启，状态机监控，崩溃归因，实时日志流（file/stdout/stderr） |
| 工作区 | 镜像本体 `game/` 目录，基准指纹追踪变更，schema 路由校验（GameDefinition/Archetype/MapRegistry/各规则） |
| 配置编辑 | 目录树 + Monaco 编辑器，保存链校验失败定位回显，整体校验 |
| 落盘 | 工作区 → 本体 diff 审查、按文件勾选、整体校验终门、自动备份、一键回滚，操作互斥 |
| 地图工具 | buildMapGeometry 预览、工作区/本体双源对比、PNG/JSON 导出、entity-rules 点位 |
| 存档管理 | WorldRecord 摘要浏览/详情/删除/下载/恢复，预览存档隔离 |
| 注册表 | 本体五类注册项速查（systems/archetypes/actions/components/mapGenerators） |
| 游戏观察 | PlayView 切换正式/预览实例，实时渲染 + 移动输入，ECharts tick 速率/实体数趋势 |

## 架构速览

pnpm monorepo，双包平级：

```
excalibur_test/          ← 本仓库（管理平台）
├── server/              管理后端：Express 5 + ws + tsx（Node ≥22.12，端口 3100）
│   └── gameBridge/      唯一引用本体的桥：framework 门面 + zod schema + loadGameDefinition
└── web/                 管理前端：Vue 3 + Vite + Element Plus（管理页）+ pixelium（游戏观察页）+ Monaco + ECharts

game_server_test/        ← 本体仓库（零代码改动，../game_server_test）
└── framework/           server 经 tsconfig paths 跨仓引用；web 经 Colyseus SDK/HTTP 观察
```

分层铁律：`server routes → services → gameBridge → 本体 framework`。游戏实例由 server 跨平台 spawn（win32 `pnpm.cmd` + taskkill 树杀 / posix detached 进程组杀）。

## 快速开始

前置条件：

- Node ≥22.12（本机经 nvm，pnpm 经 corepack 启用）
- 本体仓库 `../game_server_test` 已 `pnpm install`（node_modules 就绪）

```sh
# 1. 安装依赖
pnpm install

# 2. 构建 web 产物
pnpm --filter web run build-only

# 3. 一键启动（管理后端 tsx 无 watch + web preview :5174）
pnpm start
```

访问地址：管理平台 `http://localhost:5174`；管理后端 `http://localhost:3100`（REST `/api`，WS `/ws`）。

开发模式（tsx watch + vite dev，HMR，前端 :5173）：

```sh
pnpm dev
```

## 目录结构

```
excalibur_test/
├── package.json            # workspace 壳（一键起两端 / schema 同步 / 全量检查）
├── DESIGN.md               # 游戏观察页像素风设计契约
├── scripts/                # 跨包公共脚本（Colyseus schema 同步与一致性检查）
├── server/
│   ├── src/index.ts        # 组装：REST 路由 + WS hub + 事件接线
│   ├── src/config.ts       # GAME_ROOT / 端口 / CORS 白名单
│   ├── src/routes/         # REST 路由（instances/workspaces/configs/apply/maps/saves/...）
│   ├── src/services/       # 领域服务（instanceManager/workspaceService/applyService/liveState/...）
│   ├── src/ws/hub.ts       # WebSocket hub（/ws?channel= 白名单频道）
│   ├── gameBridge/         # 本体引用桥（framework 门面再导出 + 整体校验）
│   ├── workspaces/         # 配置工作区（镜像 + 基准指纹 + .active-workspace.json）
│   └── backups/            # 落盘前自动备份（files/ + manifest.json）
└── web/
    ├── src/views/          # 管理页（Dashboard/Workspace/Config/Maps/Saves/Registries）
    ├── src/views/PlayView.vue  # 游戏观察页（pixelium，遵循 DESIGN.md）
    ├── src/api/admin.ts    # 管理后端 REST/WS 客户端（同源模式）
    ├── src/modules/net/    # Colyseus 客户端（正式/预览实例地址参数化）
    └── vite.config.ts      # /api、/ws 同源代理
```

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm start` | 一键启动：管理后端（tsx 无 watch）+ web preview 产物（:5174） |
| `pnpm start:server` / `pnpm start:web` | 单独启动后端 / web preview |
| `pnpm dev` | 开发模式：tsx watch + vite dev（HMR） |
| `pnpm --filter web run build-only` | 构建 web 产物（preview 每次请求直读 dist，构建完即生效，无需重启） |
| `pnpm check:all` | 全量检查（schema 一致性 + lint + 类型 + 测试 + 构建） |
| `pnpm schema:sync` / `pnpm schema:check` | 同步 / 校验 Colyseus 客户端 schema |

端口速查：3100 管理后端 ｜ 3000 正式实例（本体 `.env`/`OFFICIAL_PORT` 可变）｜ 3200 预览实例 ｜ 5173 本地 dev ｜ 5174 preview 产物部署。

## 文档索引

| 文档 | 定位 |
|---|---|
| [docs/PRD-游戏服务端可视化管理平台.md](docs/PRD-游戏服务端可视化管理平台.md) | 产品需求源（v2.3），需求/设计依据归档 |
| [docs/architecture.md](docs/architecture.md) | 系统架构与运维：四通道模型、实例管理、落盘流水线、部署拓扑、REST/WS 全表、已知限制 |
| [DESIGN.md](DESIGN.md) | 像素风设计系统契约（游戏观察页遵循；管理页使用 Element Plus） |

## 边界声明（本体零改动红线）

本体仓库 `game_server_test` 全程零代码改动。平台对本体的唯一写路径：

1. **落盘写回**：仅 `game/` 配置目录，且必须通过整体校验终门并自动备份（可回滚）；
2. **运行时产物**：游戏进程自身的 `logs/` 日志与 `data/saves/` 存档（预览实例存档隔离到工作区 `.preview-saves/`）。

任何其他对本体目录的读写均违反此边界。
