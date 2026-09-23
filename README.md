# excalibur_test — 游戏服务端可视化管理平台

对 2D 游戏服务端 [game_server_test](../game_server_test)（Colyseus）的**只读包裹**式可视化管理平台：配置编辑 → 校验 → 预览 → 落盘 → 运行观察的完整闭环，游戏仓库零代码改动。支持注册/导入多个游戏（local 路径或 git 仓库双源）、切换管理目标，各游戏工作区/备份/端口命名空间隔离；默认游戏为本体 `game_server_test`（gameId `gst`）。

## 能力闭环

```
新建工作区（镜像游戏仓 game/ + 基准指纹）
      │
      ▼
配置编辑（Monaco + schema 校验 + 错误定位）
      │
      ▼
预览实例 :3200（注入工作区配置，观察真实运行效果）
      │
      ▼
落盘（diff 审查 → 整体校验终门 → 自动备份 → 写回游戏仓）
      │                        │
      ▼                        ▼
正式实例 :3001 重启生效    备份一键回滚
      │
      ▼
运行观察（双实例日志流 / PlayView 实时渲染 / ECharts 趋势）
```

以上闭环按游戏命名空间隔离，对每个已注册游戏独立成立（多游戏管理见「功能总览」与「多游戏运维提示」）。

## 功能总览（九大域）

| 功能域 | 说明 |
|---|---|
| 实例管理 | 正式/预览双实例网页启停重启，状态机监控，崩溃归因，实时日志流（file/stdout/stderr） |
| 工作区 | 镜像游戏仓 `game/` 目录，基准指纹追踪变更，schema 路由校验（GameDefinition/Archetype/MapRegistry/各规则） |
| 配置编辑 | 目录树 + Monaco 编辑器，保存链校验失败定位回显，整体校验 |
| 落盘 | 工作区 → 游戏仓 diff 审查、按文件勾选、整体校验终门、自动备份、一键回滚，操作互斥 |
| 地图工具 | buildMapGeometry 预览、工作区/游戏仓双源对比、PNG/JSON 导出、entity-rules 点位 |
| 存档管理 | WorldRecord 摘要浏览/详情/删除/下载/恢复，预览存档隔离 |
| 注册表 | 游戏五类注册项速查（systems/archetypes/actions/components/mapGenerators） |
| 游戏观察 | PlayView 切换正式/预览实例，实时渲染 + 移动输入，ECharts tick 速率/实体数趋势 |
| 多游戏管理 | 游戏注册表 + manifest 接入契约；local/git 双源导入（blobless clone + 依赖安装 + 冒烟验证）、侧栏切换管理目标（epoch 失效重取）、per-game 工作区/备份/端口池命名空间隔离；游戏管理页（详情/同步/移除/高级字段编辑） |

## 架构速览

pnpm monorepo，双包平级：

```
excalibur_test/          ← 本仓库（管理平台）
├── server/              管理后端：Express 5 + ws + tsx（Node ≥22.12，端口 3100）
│   ├── sidecar/         唯一引用游戏代码的桥：driver 子进程 + stdio NDJSON RPC（每游戏一个）
│   └── games/           游戏注册表 registry.json + 各游戏 manifest/checkout（运行时状态，gitignore）
└── web/                 管理前端：Vue 3 + Vite + Element Plus（管理页）+ pixelium（游戏观察页）+ Monaco + ECharts

game_server_test/        ← 默认游戏本体（gst，零代码改动，../game_server_test；local 源注册）
└── framework/           driver 子进程经 tsx 直读其源码；web 经 Colyseus SDK/HTTP 观察
```

分层铁律：`server routes → services → sidecar client → driver 子进程 → 游戏仓 framework`。游戏实例由 server 跨平台 spawn（win32 `pnpm.cmd` + taskkill 树杀 / posix detached 进程组杀）；sidecar driver 为计算附属物，随管理后端退出统一回收。

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
├── scripts/                # 跨包脚本（Colyseus schema 同步；sync-game 多游戏导入/迁移脚本）
├── server/
│   ├── src/index.ts        # 组装：REST 路由（/api/games/:gameId/* + 旧路由 forward）+ WS hub + 事件接线
│   ├── src/games/          # games registry 读写层 + 端口池 + manifest schema/探测（接入契约）
│   ├── src/gameContext.ts  # per-game 上下文工厂 forGame(gameId)（registry entry + manifest 合成）
│   ├── src/routes/         # REST 路由（games + instances/workspaces/configs/apply/maps/saves/...，scoped 与 legacy 双挂载）
│   ├── src/services/       # 领域服务 per-game 实例化（servicesFor(gameId) 聚合）
│   ├── src/sidecar/        # SidecarClient/SidecarManager（per-game driver 生命周期与指纹失效）
│   ├── sidecar/driver.ts   # driver：tsx 直读游戏仓 framework（schema 校验/整体校验/地图几何 RPC）
│   ├── src/ws/hub.ts       # WebSocket hub（/ws?channel= 白名单频道，per-game 频道公式）
│   ├── games/              # registry.json + <gameId>/{game.json, checkout/}（运行时状态，gitignore）
│   ├── workspaces/         # 配置工作区（per-game 命名空间 + 基准指纹 + .active-workspace.json v2）
│   └── backups/            # 落盘前自动备份（per-game 命名空间，files/ + manifest.json）
└── web/
    ├── src/views/          # 管理页（Dashboard/Games/Workspace/Config/Maps/Saves/Registries）
    ├── src/views/PlayView.vue  # 游戏观察页（pixelium，遵循 DESIGN.md）
    ├── src/components/admin/   # GameSwitcher（侧栏切换器）/ ImportGameDialog / GameAdvancedForm
    ├── src/stores/games.ts # currentGameId + epoch（切换即全局失效重取）
    ├── src/api/admin.ts    # 管理后端 REST/WS 客户端（/api/games/:gameId/* 寻址收口，同源模式）
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
| `node scripts/sync-game.mjs import\|sync\|remove …` | 多游戏 CLI：导入/更新/移除游戏（与 UI/REST 同一服务层，见「多游戏运维提示」） |
| `pnpm exec tsx scripts/migrate-namespaces.mjs` | 存量目录迁移至 per-game 命名空间（仅部署窗口执行，见「多游戏运维提示」） |

端口速查：3100 管理后端 ｜ 3001 默认游戏正式实例（gst，解析自本体 `.env`；新游戏由端口池 official 3000–3199 分配）｜ 3200 默认游戏预览实例（新游戏由 preview 3200–3399 分配）｜ 5173 本地 dev ｜ 5174 preview 产物部署。

## 文档索引

| 文档 | 定位 |
|---|---|
| [docs/PRD-游戏服务端可视化管理平台.md](docs/PRD-游戏服务端可视化管理平台.md) | 产品需求源（v2.3），需求/设计依据归档 |
| [docs/architecture.md](docs/architecture.md) | 系统架构与运维：四通道模型、sidecar 驱动、多游戏架构（registry/manifest/导入流/命名空间/寻址）、落盘流水线、部署拓扑、REST/WS 全表、已知限制 |
| [docs/multi-game-plan.md](docs/multi-game-plan.md) | 多游戏架构实施计划（Phase 0–4；含已拍板决策表 §6） |
| [DESIGN.md](DESIGN.md) | 像素风设计系统契约（游戏观察页遵循；管理页使用 Element Plus） |

## 多游戏运维提示

**游戏导入 / 更新 / 移除 CLI**（`scripts/sync-game.mjs`，与游戏管理 UI、REST 完全同一服务层）：

```sh
# 导入 git 源（blobless clone → pnpm install --ignore-scripts → 探测 manifest → 冒烟，失败整体回滚）
node scripts/sync-game.mjs import --type git --url <url> --ref <ref> [--id <id>] [--name <name>]
# 导入 local 源（不 clone、跳过 install；相对路径以平台仓库根锚定）
node scripts/sync-game.mjs import --type local --path ../game_server_test --id gst-local
# 幂等更新（git 源 fetch / local 源重探测；指纹没变即 noop）
node scripts/sync-game.mjs sync --id <id>
# 移除（registry 删项 + 清 server/games/<id>/；workspaces/backups 保留；默认/最后一个游戏拒绝）
node scripts/sync-game.mjs remove --id <id>
```

以上操作 UI（游戏管理页）与 REST（`/api/games*`）均可完成，无需改 env 或代码。

**目录迁移脚本**（`scripts/migrate-namespaces.mjs`，把存量 `workspaces/<uuid>`、`backups/<stamp>`、v1 活动工作区文件迁入 per-game 命名空间）：

```sh
pnpm exec tsx scripts/migrate-namespaces.mjs --dry-run   # 先演练：只检查/扫描/打印计划，不写任何文件
pnpm exec tsx scripts/migrate-namespaces.mjs             # 正式迁移
```

⚠️ **执行时机硬约束**：

- **仅在部署窗口、管理后端（admin）已停止时运行**——脚本启动会探测管理端口（默认 3100），admin 未停则拒绝执行；`--skip-admin-check` 仅供对只读副本演练，不得用于线上；
- 迁移前先通过管理页停止 official/preview 实例（【需用户确认】）；
- 脚本自带快照（默认 `/tmp/opencode/mig-<ts>/`，唯一回滚来源，绝不自动清理）与迁移前后指纹比对，全部一致才打印 MIGRATION OK；
- 新版服务只认 v2 活动工作区文件，读到旧格式会 fail-fast 并提示跑本脚本——**先迁移、再启动新代码**；快照/legacy 保留 ≥1 个发布周期，删除是人工动作。

**端口池**：新游戏 official 段 3000–3199、preview 段 3200–3399 first-fit 自动分配（分配即持久化）；默认游戏 gst 沿用现状端口，不参与池分配。

## 边界声明（游戏仓库零改动红线）

已注册游戏仓库全程零代码改动（默认本体 `game_server_test` 以 local 源注册；git 源游戏使用平台自有 clone `server/games/<id>/checkout/`，local 源游戏的外部源目录只读）。平台对游戏仓库的唯一写路径：

1. **落盘写回**：仅 `game/` 配置目录，且必须通过整体校验终门并自动备份（可回滚）；
2. **运行时产物**：游戏进程自身的 `logs/` 日志与 `data/saves/` 存档（预览实例存档隔离到工作区 `.preview-saves/`）。

任何其他对游戏仓库目录的读写均违反此边界。
