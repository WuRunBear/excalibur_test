# PRD — 游戏服务端可视化管理平台

> 载体项目：**excalibur_test（改造底座）**——作为起点代码库，按本 PRD 的架构**整体重构**为可视化管理平台；其既有架构与规范（project_rules、目录边界、桥接约定等）是**改造对象而非约束**，按需重组、复用或废弃。
> 目标项目：`game_server_test`（配置驱动的 2D 游戏服务端框架），平级目录，不修改其任何代码。
> 文档版本：v2.3（2026-09-20）。本文档是**完整产品规格**；实施节奏见《执行计划-游戏服务端可视化管理平台.md》。

## 1. 背景与目标

`game_server_test` 的游戏内容全部由 `game/` 下纯 JSON 声明，调试配置目前只能靠改文件 + 命令行工具 + 重启，缺少直观手段。本平台在 excalibur_test 基础上重构出一个 Web 可视化管理端，核心工作流：

**编辑（工作区镜像）→ 校验 → 预览（隔离预览实例看运行效果）→ 落盘（diff 审查后写回本体）→ 正式实例重启生效**

功能全景：

- **配置管理编辑**：可视化浏览/编辑 `game/*.json`，保存前 zod 校验，改错即报。
- **效果预览**：落盘前用预览实例（镜像配置、错开端口、临时存档）查看修改的真实运行效果。
- **地图可视化**：选地图 key 生成/预览/导出地图，查看地形、区域、通行性、演化规则点位。
- **运行监控**：正式/预览双实例进程状态、启停控制、日志实时查看。
- **存档管理**：浏览/删除/恢复/备份 `data/saves/` 存档。

**成功标准**：一次配置修改从编辑到确认效果再到落盘，全程不离开浏览器；本体在落盘确认前零污染；不改 `game_server_test` 一行代码。

## 2. 改造原则与可复用材料

**总原则：先迁后改，架构保留。** 把当前前端项目**原样复制**到 `web/`（工程链、路由、布局、状态、组件模式全量保留），保证迁移后可运行，再在其上**增量改造**。基本架构不推倒重写；删除仅限与平台无关的代码（demo/占位），现成能力一律复用。excalibur_test 既有材料处置如下：

| excalibur_test 现有材料 | 处置 |
|---|---|
| 工程链（Vite/tsconfig/prettier/Vitest/检查脚本） | **原样保留**：随整体迁入 web/，仅修脚本路径 |
| 路由 / MainLayout / Pinia 结构 | **保留**：在现有结构上新增管理页面 |
| Colyseus 客户端（`src/game/net/`：connection/schema/types/config） | **保留实现，迁移复用**：加连接地址参数化（按实例端口），不改核心逻辑 |
| `schema:sync` 脚本（从 `../game_server_test` 拉取 client-schema） | **保留**：协议同步机制不变 |
| mapCodec（消费 `/maps/runtime` 几何） | **保留实现，迁移复用**：地图叠加视图与俯视小地图的几何重组基础 |
| Excalibur 0.32 + tiled 插件、actorManager/mapTileMap | **保留实现，迁移复用**：观察视图渲染引擎（地图/实体绘制） |
| bridge 桥接模式（type.ts + bridge.ts） | **保留**：管理域与游戏域交互沿用此模式 |
| `/game` 游戏客户端页面与 GameUI | **保留为 PlayView**：适配连接地址可选（正式/预览实例），功能实现不重写 |
| `/index` 管理路由占位 | **替换**：改为管理平台主界面 |
| pixelium 组件库 | 游戏相关页面沿用；管理平台新增页面用 Element Plus |
| demo 残留（counter store、占位组件等） | **删除**：唯一允许删除的部分 |

## 3. 系统边界与接入方式（包裹模型）

平台 = **管理前端（Vue3 web） + 管理后端（Node server 包）**，同仓（excalibur_test 改造为 pnpm workspace）。管理后端"包裹"游戏本体，四条通道：

```
┌────────────────┐  REST/WS  ┌──────────────────────┐
│ 管理前端 (web)  │◄─────────►│ 管理后端 (server)      │
│ Vue3 + Monaco  │           │ Node/Express :3100    │
│ + EPlus + 观察视图│          └──┬────┬────┬────┬───┘
└────────────────┘ 通道① 进程控制：spawn 管理「正式/预览」两个游戏进程
         │          通道② 文件系统：工作区镜像、落盘写回、data/saves/、logs/
         │ 通道④     通道③ 代码引用：import game_server_test framework 公共 API
         │ Colyseus 通道④ 网络观察：HTTP /maps/*、Colyseus WS 订阅运行时状态
         ▼                │
  game_server_test ◄──────┘（只读包裹，不修改）
  （:3000 正式 / :3200 预览）
```

**边界铁律**：
- 管理代码不进入 `game_server_test`；对本体目录只做「读」与「落盘写回」。
- 通道③ 只调用 `framework/api.ts` 等公共门面，import 全部收敛到 `server/src/gameBridge/`。
- 配置生效**不搞热重载**：正式实例统一"落盘 → 重启"生效。
- server 与 web 经 REST/WS 通信，不共享运行时。

## 4. 核心工作流：工作区镜像模型

### 4.1 工作区（Workspace）

工作区 = `game/` 目录的**完整镜像副本**，所有修改只发生在工作区，本体在确认落盘前不被触碰。

- **存储**：`server/workspaces/<workspaceId>/game/`（目录结构与本体 `game/` 完全一致）。
- **生命周期**：新建（本体全量复制 + 基准指纹）→ 编辑（读写均指工作区）→ 校验（随时，不影响本体）→ 预览（起预览实例看效果，可反复）→ 落盘（diff 审查 → 按勾选写回本体）→ 放弃/删除（本体无痕）。
- **多工作区**：可并存多个，同一时刻至多一个**活动工作区**绑定编辑器与预览实例。

### 4.2 预览实例

落盘前查看配置修改的真实运行效果。管理后端用**工作区配置**启动一个隔离的游戏进程：

| 环境变量 | 取值 | 说明 |
|---|---|---|
| `GAME_CONFIG_PATH` | `<workspace>/game/game.json` | 框架按该路径解析关联配置（entities/maps 等随目录生效） |
| `SAVE_DIR` | `<workspace>/.preview-saves/` | 预览存档隔离，不污染正式存档 |
| `PORT` | `3200` | 与正式实例 3000 错开 |

- 预览实例与正式实例**可同时运行**，仪表盘分开展示状态与日志。
- 管理前端以客户端能力（Colyseus 连接 + Excalibur 渲染）连接任意运行中实例（按端口），像游玩一样观察镜像的真实运行效果。
- 效果不满意 → 回编辑器继续改 → 重启预览实例再验证；满意后走落盘。

### 4.3 校验链（编辑期 / 落盘期共用）

1. **文件级**：按文件类型选 zod schema（GameDefinitionSchema、ArchetypeSchema、MapRegistrySchema 等）对工作区单文件校验，错误定位到 JSON 路径。
2. **整体级**：复用 `pnpm tools validate` 逻辑（含每图管道链与实体规则数校验）对工作区跑整体校验。
3. 校验不通过的文件**禁止落盘**（硬性前置条件）。

### 4.4 落盘（Apply）

- 工作区 vs 本体**逐文件 diff**（内容级），前端 Monaco DiffViewer 展示、按文件勾选。
- 写回前对被覆盖文件自动备份到 `server/backups/<时间戳>/`；写回后可选立即重启正式实例。
- 备份支持一键回滚。

## 5. 技术选型

| 层 | 技术 | 说明 |
|---|---|---|
| 前端框架 | Vue3 + Vite + TypeScript | excalibur_test 底座 |
| 管理 UI | Element Plus + SCSS 主题定制 | 表格/树/表单/对话框；主题向项目风格靠拢 |
| 观察渲染 | Excalibur 0.32 + tiled 插件 | 地图/实体绘制（复用现成渲染能力） |
| 状态管理 | Pinia | 管理域 stores |
| 编辑器 | Monaco Editor | JSON 编辑、DiffViewer（落盘审查）、校验错误标红 |
| 图表 | ECharts | 监控仪表盘 |
| 管理后端 | Node >= 22 + Express + ws（tsx 运行） | `server/` 包，ESM + TypeScript |
| 客户端协议 | @colyseus/sdk + schema:sync | 复用，连接地址按实例端口参数化 |
| 通信 | REST + WS | REST 为主；日志流/实例状态/小地图数据用 WS 推送 |

## 6. 总体架构与目录结构（重构后）

```
excalibur_test/                  ← 重构为管理平台 monorepo（根 = workspace 壳）
├── server/                      ← 管理后端包
│   ├── src/
│   │   ├── index.ts             ← 入口：Express(:3100) + WS 挂载
│   │   ├── config.ts            ← GAME_ROOT、端口、目录配置
│   │   ├── routes/
│   │   │   ├── process.ts       ← ①实例：正式/预览 启动/停止/重启/状态
│   │   │   ├── workspace.ts     ← ③工作区：新建/切换/列表/删除
│   │   │   ├── configs.ts       ← ②配置：列目录/读/写（仅工作区）/校验
│   │   │   ├── apply.ts         ← ②落盘：diff/执行/备份/回滚
│   │   │   ├── maps.ts          ← ③地图：列表/生成/预览/导出
│   │   │   ├── saves.ts         ← ②存档：列表/详情/删除/恢复/备份
│   │   │   └── registries.ts    ← ③注册表：list-registries
│   │   ├── services/
│   │   │   ├── instanceManager.ts ← 双实例进程管理（spawn/env/崩溃检测）
│   │   │   ├── workspaceService.ts← 工作区 CRUD + 指纹
│   │   │   ├── configService.ts   ← 工作区文件读写 + 校验编排
│   │   │   ├── applyService.ts    ← diff 计算/写回/备份/回滚
│   │   │   ├── mapService.ts      ← 调 framework buildMapGeometry/export
│   │   │   ├── saveService.ts     ← data/saves 扫描/CRUD
│   │   │   ├── logStream.ts       ← 双实例日志 tail + WS 推送
│   │   │   └── liveState.ts       ← ④WS 客户端：观察实例运行时状态
│   │   └── gameBridge/          ← ③framework 引用适配层（唯一 import 游戏代码处）
│   ├── workspaces/              ← 工作区镜像（运行时生成）
│   ├── backups/                 ← 落盘备份（运行时生成）
│   ├── package.json
│   └── tsconfig.json            ← paths: @game/framework/* → ../../game_server_test/framework/*
├── web/                         ← 管理前端包（原根目录前端整体迁入）
│   ├── src/
│   │   ├── views/
│   │   │   ├── DashboardView.vue    ← 双实例仪表盘
│   │   │   ├── WorkspaceView.vue    ← 工作区管理（含落盘审查）
│   │   │   ├── ConfigView.vue       ← 配置编辑（绑定活动工作区）
│   │   │   ├── MapView.vue          ← 地图工具（工作区/本体双源）
│   │   │   ├── SaveView.vue         ← 存档管理
│   │   │   ├── RegistryView.vue     ← 注册表浏览
│   │   │   └── PlayView.vue         ← 游戏观察/游玩页（原 GameView 演化，连接地址可选正式/预览实例）
│   │   ├── components/          ← JsonEditor、DiffViewer、LogConsole、MapOverlay 等
│   │   ├── modules/
│   │   │   ├── net/             ← 由原 game/net 重构：实例连接（端口参数化）、schema、types
│   │   │   ├── maprender/       ← 由原 mapCodec/actorManager/mapTileMap 重构：几何重组与渲染
│   │   │   └── game/            ← 原 Excalibur 引擎逻辑，按观察视图需求裁剪
│   │   ├── stores/              ← instance/workspace/config/map/save
│   │   └── styles/element-theme.scss ← Element Plus 主题定制
│   ├── index.html
│   ├── vite.config.ts
│   └── package.json
├── scripts/                     ← 公共脚本（schema:sync 等保留）
├── pnpm-workspace.yaml          ← packages: ['server', 'web']
└── package.json                 ← workspace 壳（公共脚本：一键起两端等）
```

### 6.1 server 包技术架构

**分层与依赖方向（严格单向）**：

```
HTTP/WS 入口层        业务服务层                     桥接层
routes/ ──调用──► services/ ──需要本体能力时──► gameBridge/ ──import──► game_server_test framework
```

| 层 | 职责 | 关键约束 |
|---|---|---|
| `index.ts` | 组装：读 config → Express(:3100) → 挂 routes → 同端口挂 wsHub | 薄，无逻辑 |
| `config.ts` | `GAME_ROOT`、端口、工作区/备份/日志路径派生 | 环境变量可覆盖 |
| `routes/` | 参数解析 → 调 service → 统一响应结构 `{code, message, detail}` | 不含业务逻辑 |
| `services/` | 全部业务逻辑：进程状态机、工作区生命周期、校验编排、落盘/备份、diff、存档扫描、日志采集 | **禁止直接 import framework**，一律经 gameBridge |
| `gameBridge/` | 本体能力适配：zod schema 重导出（文件级校验）、buildMapGeometry/exportGeometryArtifacts（地图生成/导出）、listRegistered*（注册表）、tools validate 逻辑复用（整体校验） | 唯一 import 本体处；所有函数无状态只读 |
| `wsHub` | 频道化 WS 推送：`instance:log:{role}`（日志流）、`instance:state`（实例状态变更）、`live:{role}`（后期观察数据） | 前端按频道订阅 |

**InstanceManager 状态机**（每实例一份）：`stopped → starting → running → (crashed | stopped)`。spawn 用 `pnpm.cmd` + env 注入（正式/预览差异仅在 env）；停止用 `taskkill /T /F` 树杀；退出码非 0 且非人为停止判定为 crashed；每次状态变更广播 `instance:state`。

**ApplyService 串行化**：落盘是唯一写本体路径，内部互斥锁防止并发落盘/回滚交错；固定流程 `diff → 勾选校验 → 备份 → 写回 → 回执`。

**基础能力选型**：diff 用 `diff` 包（后端算 unified diff + 结构化变更清单）；日志采集为自实现 tail（fs watch + 增量读，避免额外依赖）；进程管理用 `node:child_process` 原生 API。

**数据流（完整调试闭环）**：新建工作区 → 编辑器改工作区 JSON（即时 zod 校验）→ 「预览」起预览实例 → 日志/监控/观察视图看运行效果 → 不满意回改 → 满意后「落盘」→ diff 勾选 → 写回本体（自动备份）→ 可选重启正式实例 → 效果进入正式存档。

## 7. 功能模块详述

### 7.1 仪表盘（双实例运行监控）—— 通道①②④
- 正式 / 预览两张状态卡：运行中/已停止/崩溃（退出码）、启动时间、运行时长、PID、内存占用。
- 各自独立的启动/停止/重启；崩溃检测与告警；按实例的自动重启开关。
- 日志控制台：tail `logs/game.log` + 进程 stdout，WS 实时追加，按实例分页，暂停/清屏/级别过滤。
- 配置上下文卡：正式实例配置指纹 vs 活动工作区指纹对比，不一致提示"工作区有未落盘改动"。

### 7.2 工作区管理 —— 通道②③
- 工作区列表：名称、创建时间、基准指纹、改动文件数；新建/切换/删除/重命名。
- 落盘审查页：Monaco DiffViewer 逐文件 diff + 按文件勾选 + 校验状态标（未过校验禁选）→ 确认落盘 → 备份回执。
- 备份列表与一键回滚。

### 7.3 配置管理编辑 —— 通道②③
- 左侧树：活动工作区 `game/` 目录（entities/rules/items/maps/behaviors/quests/dialogues/ecosystems/game.json）。
- 右侧 Monaco：JSON 高亮、格式化、保存只写工作区（写本体的唯一入口是落盘流程）。
- 保存链：即时 zod 校验（按文件类型）→ 错误定位回显 → 通过则写入工作区。
- "整体校验"按钮：对工作区跑 tools validate 逻辑，结果面板展示。
- 顶栏常驻：工作区改动数、预览实例状态、"落盘"快捷入口。

### 7.4 地图工具 —— 通道③
- 地图列表：读 registry.json（工作区/本体双源切换），展示 key 与管道积木链。
- 生成预览：对所选数据源调 framework `buildMapGeometry` + `exportGeometryArtifacts` 产 PNG；支持自定义色表。
- 叠加视图：基于 geometry snapshot（复用 mapCodec 重组逻辑）渲染 walkable 底色、region 边界着色、演化规则点位。
- 地图元信息：尺寸、区域面积（region-stats meta）、version 指纹；工作区与本体同图并排对比。
- 导出 JSON + PNG 下载。

### 7.5 注册表浏览 —— 通道③
- 调 `listRegisteredSystems/Archetypes/Actions/Components/MapGenerators` 展示五类注册项，支持搜索过滤。

### 7.6 存档管理 —— 通道②
- 列表：扫描 `data/saves/`（saveId/tick/savedAt/地图数）；预览实例临时存档单独页签。
- 详情：WorldRecord 摘要（地图列表、按 kind 实体计数）。
- 操作：删除（二次确认）、下载备份、恢复（替换活跃存档 → 提示重启正式实例）。

### 7.7 游戏观察视图 —— 通道④
- PlayView：以客户端形态连接所选实例（正式/预览下拉切换），Excalibur 渲染地图与实体实时状态（位置/朝向/血条），按地图切换。
- 支持发送输入（移动）以便主动验证 AI/战斗/交互效果。
- 运行指标：tick 速率、实体总数趋势（ECharts 时序）。

## 8. 关键技术决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 项目形态 | excalibur_test 整体重构为管理平台 monorepo：根 = workspace 壳，`server/`（管理后端）与 `web/`（管理前端，原根目录前端迁入）双包平级 | 文件夹层面前后端清晰分离，单仓联调简单；复用其 Vue3/Excalibur/Colyseus 基础与工程链 |
| UI 组件库 | 管理平台用 Element Plus + SCSS 主题定制 | 管理后台信息密度需要成熟组件；主题变量向项目风格靠拢 |
| framework 引用方式 | server 以 tsx 运行 + tsconfig paths 指向本体 framework 源码（完整复制别名表） | 本体内部用路径别名互引；tsx 直译源码免 build |
| framework 引用隔离 | 所有 import 收敛到 `server/src/gameBridge/` | 唯一耦合点，本体升级只改一处 |
| 配置生效 | 无热重载；工作区 → 预览实例 → 落盘 → 正式实例重启 | 本体启动时读配置；预览实例解决"落盘前看效果" |
| 预览实例隔离 | 端口 3200 + `GAME_CONFIG_PATH` 指向工作区 + `SAVE_DIR` 临时目录 | 框架原生支持，零本体改动 |
| 实例连接 | net 模块连接地址参数化（正式/预览可切换） | 一套客户端能力观察任意实例 |
| 校验实现 | 文件级同进程 zod schema；整体级复用 tools validate 逻辑 | 同进程拿结构化错误；管道链校验复用现成实现 |
| 落盘安全 | 校验通过才允许落盘 + 自动备份 + 回滚 | 本体可恢复，误操作兜底 |
| 游戏根目录定位 | server 环境变量 `GAME_ROOT` 默认 `../game_server_test` | 与 schema:sync 脚本约定一致 |

## 9. 数据模型（核心）

```
Workspace {
  id, name, createdAt, baseFingerprint   // 基准 = 复制自本体时的清单指纹
  gameDir                                // server/workspaces/<id>/game/
  previewSaveDir                         // server/workspaces/<id>/.preview-saves/
}
Instance {
  role: "official" | "preview"           // 正式 / 预览
  status: "stopped" | "running" | "crashed"
  pid, startedAt, port, configPath, saveDir
}
ApplyPlan {
  files: [{ path, status: added|modified|deleted, diffSummary, valid }],  // valid=false 禁选
  backupId
}
SaveEntry { saveId, tick, savedAt, mapCount, kindStats }
```

## 10. 非目标

- 不修改 `game_server_test` 任何代码；不做框架热重载。
- 不做配置表单化编辑器（第一版 Monaco 源码编辑 + 校验；表单化后续可选，不在本规格内）。
- 不做多用户/权限系统（本地单用户工具）。
- 不接管 Tiled 编辑器职责（地图编辑仍用 Tiled）。

## 11. 风险与注意

- **路径别名解析**：server 的 tsconfig 须完整复制本体别名表；tsx 解析失败的第一回退是检查 `@tsconfig/node22` 与 paths 组合，第二回退改"本体 build 后 file: 依赖引 dist"。
- **双实例并存**：端口错开（正式 3000 / 预览 3200 / 管理后端 3100）；预览实例 `SAVE_DIR` 必须隔离；gameBridge 调用保持无状态。
- **Windows 子进程**：spawn 处理 `pnpm.cmd`、树杀死（taskkill /T）、退出码归因。
- **GAME_CONFIG_PATH 语义**：需实测确认框架按该路径解析关联目录；若有按 cwd 解析的部分，spawn `cwd=<workspace>/game` 兜底，仍不行用 junction 链接。
- **重构回归**：excalibur_test 既有代码重构/迁移可能引入回归，S1 完成后跑 `pnpm check:all`（适配新结构）与 PlayView 冒烟验证。
- **存档兼容**：本体旧存档直接废弃（无兼容代码），平台恢复存档只做文件级替换，不做版本迁移。
- **大 JSON diff 性能**：diff 与校验放 server 执行，前端只渲染结果。
