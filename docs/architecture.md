# 架构与运维 — 游戏服务端可视化管理平台

> 需求依据：[PRD-游戏服务端可视化管理平台.md](PRD-游戏服务端可视化管理平台.md) v2.3。
> 本文以当前代码实况为准，描述系统架构、关键流水线、部署拓扑与运维备忘。

## 1. 系统架构：四通道模型

平台是本体 `game_server_test`（Colyseus 游戏服务端）的只读包裹，与本体之间存在且仅存在四条通道：

| 通道 | 载体 | 说明 |
|---|---|---|
| 进程控制 | `instanceManager` | spawn/树杀双实例，env 注入（PORT、GAME_CONFIG_PATH、SAVE_DIR） |
| 文件系统 | 工作区 / 落盘 / 存档服务 | 读：镜像 `game/` 到工作区；写：仅落盘写回（校验 + 备份）与运行时产物（logs/、saves/） |
| 代码引用 | `gameBridge` | tsconfig paths 跨仓 import 本体 framework，tsx 运行时直读源码，免 build |
| 网络观察 | `liveState` + 日志流 + PlayView | @colyseus/sdk schema-less 观察者采样、日志文件 tail + 进程 stdio、Colyseus 客户端实时渲染 |

```
web/ (5173 dev | 5174 preview)
  │  REST /api/* + WS /ws?channel=（同源代理或直连）
  ▼
server/ (3100, Express 5 + ws + tsx)
  │ routes → services → gameBridge ──代码引用──► game_server_test/framework
  │ instanceManager ──spawn/env 注入──► official(:3000) / preview(:3200) 游戏进程
  │ liveState ──@colyseus/sdk 观察者──► 游戏房间（1s 采样）
  └─ logStream ──tail logs/game.log + 进程 stdio
```

## 2. 分层与 gameBridge

分层铁律：`server/src/routes → server/src/services → server/gameBridge → 本体 framework`。

- **routes**：REST 路由，统一响应 `{code, message, detail?}`，400/404/409/422 分类明确。
- **services**：领域服务（实例管理、工作区、配置、落盘、地图、存档、liveState、日志流）。
- **gameBridge**（`server/gameBridge/`，物理位置在 src/ 之外）：**唯一引用本体的桥**。
  - 经 `framework` 门面再导出 schema 与核心函数：`GameDefinitionSchema`（自门面）、`ArchetypeSchema` / `MapRegistrySchema`（经别名子路径 `framework/config/schema/*`）、`bootstrapFramework` / `loadGameDefinition` / `buildMapGeometry` 等。
  - Spike-1 结论：tsx 跨仓裸别名解析可行（tsconfig 复刻本体 paths 十余项），免 build/dist 回退；tsconfig 需 include 本体 `bitecs-legacy.d.ts`。
  - Spike-2 结论：本体 `tools/validate.ts` 的 `validate()` 失败路径有 `process.exit(1)` CLI 副作用，不可同进程复用 → 改为直接 import 幂等的 `bootstrapFramework()` + `loadGameDefinition()`；后者对缺失 game.json 会静默回退默认定义，整体校验已加存在性预检防御。
  - zod 双实例问题：本体 schema 与 server 的 zod 是不同 pnpm 实例（类类型不兼容），路由表用结构化接口 `SafeParseLike` 适配。

## 3. 实例管理

双实例（role = `official` | `preview`）各一个独立状态机：

```
stopped → starting → running → (crashed | stopped)
```

- **starting**：spawn 已发起，等子进程成功拉起；**crashed**：非管理端发起的退出（外部杀死/自身崩溃/spawn 失败），记录 `lastExitCode` / `lastSignal`；重复 start/stop 冲突 → 409。
- **跨平台 spawn**：
  - win32：`spawn('pnpm.cmd', ['dev'], { shell: true })`，停止用 `taskkill /PID <pid> /T /F` 树杀（⚠️ 未真机验证）；
  - posix：`spawn('pnpm', ['dev'], { detached: true })` 进程组组长，`kill(-pid)` 杀整组，宽限超时升级 SIGKILL。
- **env 注入**：
  - official：展示端口由本体 `.env` 的 `PORT`/`OFFICIAL_PORT` 解析；spawn 注入 `PORT` 覆盖（dotenv 不覆盖已注入变量）。
  - preview：`PORT=3200` 恒注入；存在活动工作区时注入 `GAME_CONFIG_PATH=<工作区>/game/game.json` 与 `SAVE_DIR=<工作区>/.preview-saves/`；无工作区回退本体配置（此时预览会写本体存档，UI 已明示）。
- Spike-3 结论：绝对 `GAME_CONFIG_PATH` 下资源 glob 相对 game.json 目录解析，`SAVE_DIR` 隔离成立；唯一 cwd 依赖为 winston 日志目录（见 §7 已知限制）。

## 4. 工作区 → 校验 → 落盘流水线

### 4.1 工作区

- 新建 = 本体 `game/` 全量复制到 `server/workspaces/<id>/`，基准指纹 = 文件清单 + 内容哈希（sha256 前 16 位）。
- 活动工作区持久化在 `server/workspaces/.active-workspace.json`（tsx watch 重启不丢）；删除为硬删除；路径读写有穿越防护（resolve 必须落在工作区 `game/` 内）。
- schema 路由校验：`game.json`→GameDefinitionSchema、`entities/*.json`→ArchetypeSchema、`maps/registry.json`→MapRegistrySchema、behaviors/dialogues/quests/rules/items 各归其位；zod safeParse → 结构化错误（jsonPath + 消息 + 启发式行号）。
- `GET /api/config-context`：本体 vs 活动工作区清单级指纹对比（inSync），是落盘 diff 的基础。

### 4.2 落盘执行（固定串行 + 互斥锁）

```
plan（diff 审查）→ 勾选文件 → execute：
  ① TOCTOU 复核（重算 changes，变化 → 409）
  ② 文件级校验（所选文件全过，invalid → 422）
  ③ 整体校验终门（跨文件约束，422 message 即原因）
  ④ 备份（server/backups/<时间戳-随机>/：files/ + manifest.json）
  ⑤ 写回/删除本体 → 刷新工作区基准指纹（changes 归零）
```

- **整体校验终门**兜底跨文件完整性约束——例如直接删除 cave/swamp/ruins 图会触发本体启动崩溃（ecosystems biome 必须落在某图 regions，entity-rules 亦引用图键），此类操作在落盘前被 422 拦截。
- **回滚为完整逆操作**：overwritten/deleted 从备份写回本体，**added 从本体删除**（含空父目录清理）；与落盘共用互斥锁（并发 409）。
- **备份链**：每次落盘在 `server/backups/<backupId>/` 留全量可回滚快照（backupId = 时间戳-随机，防注入）；备份无保留策略，需人工清理。

## 5. 同源模式与部署拓扑

### 5.1 同源模式（当前形态）

`VITE_ADMIN_SERVER_URL` 留空 = 同源模式：前端 REST 走相对路径 `/api`，WS 由页面协议推导（https → wss）。vite dev/preview 均带 `/api`、`/ws` 代理（目标 `VITE_ADMIN_PROXY_TARGET`，默认 `http://localhost:3100`），域名/反代部署天然无跨域。仅前后端不同源直连时才需配置该变量（后端 CORS 白名单须含页面来源）。

### 5.2 三层拓扑

```
浏览器 ──https──► 宝塔 nginx（全量反代）
                      │
                      ▼
              web preview :5174（vite preview 产物，43 文件/11MB）
                      │  /api、/ws 代理
                      ▼
              admin :3100（tsx）──spawn──► official :3000 / preview :3200
```

- **产物部署（当前）**：5174 = `pnpm --filter web run build-only` 后的 `vite preview`，每次请求直读 `dist/`，**构建完即生效，无需重启**；产物无 node_modules 引用，与敏感目录拦截无关。
- **dev 模式**：`pnpm dev` 本地直连（localhost，不经域名）。dev 依赖 `/@fs` 模块 URL，与 nginx 拦截规则冲突（见下）。
- PlayView 观察游戏实例走 Colyseus WebSocket（默认 `ws://localhost:3000`，本地 `.env.local` 为 `ws://localhost:3211`；`VITE_PREVIEW_SERVER_URL=ws://localhost:3200`）。

### 5.3 ⚠️ nginx 敏感目录拦截的坑（已还原）

宝塔站点"敏感目录拦截"正则未锚定，曾拦截 `/node_modules/**` 与 `/.pnpm/`——vite dev 的 `/@fs` 模块 URL 必含后者 → 依赖模块 404 → 页面黑屏。当时已从 `node_excalibur_test.conf` 移除这两项。**现状：该站点配置已还原为原始（含 node_modules|.pnpm 拦截）**，因此：

- 产物部署（5174）不受影响，为推荐形态；
- 若需在域名上恢复 dev 模式，改用 vhost 目录的 `node_excalibur_test.conf.bak-20260922-fixed` 备份（移除两项拦截）；注意在宝塔面板重新保存该站点会复发。

## 6. REST + WS 端点全表

REST 统一前缀 `/api`，响应 `{code, message, detail?}`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/instances` | 双实例状态快照 |
| GET | `/api/instances/:role` | 单实例快照 |
| POST | `/api/instances/:role/start` · `/stop` · `/restart` | 启动 / 停止（树杀）/ 重启 |
| GET | `/api/instances/:role/logs?lines=200` | 日志环形缓冲回填 |
| GET | `/api/workspaces` | 工作区列表 + 活动项 |
| POST | `/api/workspaces` | 新建（镜像本体 game/）并自动激活 |
| POST | `/api/workspaces/:id/activate` | 切换活动工作区 |
| PATCH | `/api/workspaces/:id` | 重命名 |
| DELETE | `/api/workspaces/:id` | 删除（硬删除） |
| GET | `/api/workspaces/:id/changes` | 相对基准指纹的变更清单 |
| GET | `/api/configs/tree` | 工作区配置目录树 |
| GET | `/api/configs/file?path=` | 读文件原文 + schemaKind |
| PUT | `/api/configs/file` | 校验后写盘（422 + jsonPath 定位；可新建文件） |
| POST | `/api/configs/validate` | 单文件 schema 校验 |
| POST | `/api/configs/validate-all` | 整体校验（跨文件约束） |
| GET | `/api/config-context` | 本体 vs 活动工作区指纹对比（inSync + changes） |
| POST | `/api/apply/plan` | 落盘计划（逐文件 diff + 校验标志） |
| POST | `/api/apply/execute` | 执行落盘（body: `{paths}`；终门 → 备份 → 写回） |
| GET | `/api/backups` | 备份列表（createdAt 倒序） |
| POST | `/api/backups/:backupId/rollback` | 回滚（完整逆操作） |
| GET | `/api/maps?source=` | 地图列表（workspace/official 双源） |
| POST | `/api/maps/:key/geometry` | buildMapGeometry 几何快照（body: `{source}`） |
| GET | `/api/maps/:key/export?source=&format=&palette=` | PNG/JSON 导出下载 |
| GET | `/api/maps/entity-rules?source=` | 演化规则原样 JSON |
| GET | `/api/saves?scope=` | 存档列表（WorldRecord 摘要；official/preview 双域） |
| GET | `/api/saves/:file/detail?scope=` | 存档详情（maps/topKinds） |
| DELETE | `/api/saves/:file?scope=` | 删除存档 |
| GET | `/api/saves/:file/download?scope=` | 下载备份 |
| POST | `/api/saves/:file/restore?scope=` | 恢复为活跃存档（official 域提示重启实例） |
| GET | `/api/registries` | 五类注册项速查 |
| GET | `/api/live/samples?role=&limit=` | 运行指标回填（最近 ≤300 条，旧→新） |

WS：`GET /ws?channel=<name>`，30s 心跳，白名单频道：

| 频道 | 内容 |
|---|---|
| `instance:state` | 实例状态快照（含 configPath/saveDir，crash 后保留） |
| `instance:log:official` / `instance:log:preview` | 日志行（source: file/stdout/stderr + 级别启发式） |
| `live:official` / `live:preview` | 1s 采样 `{ts, tick, tickRate, entityCount}`（entityCount 为观察者可见实体数，兴趣裁剪） |

## 7. 已知限制与运维备忘

### 7.1 运行时限制

| 限制 | 说明 |
|---|---|
| file 日志双频道 | 双实例 cwd 均为本体根，winston 写 `<GAME_ROOT>/logs/game.log` 无法按行归属实例 → `source:'file'` 行向双频道广播兜底；仅进程 stdout/stderr 可精确归属 |
| 观察者玩家实体 | liveState 的 @colyseus/sdk 观察者 join 会在游戏内创建玩家实体（Colyseus 语义）；纯观察需本体支持 spectator 模式，超出边界 |
| 观察者字段耦合 | RoomStateView 字段名耦合本体 schema：本体 schema 改名会静默 `entityCount=0`（tick 仍正常） |
| tsx watch 重启丢观察会话 | 开发态 server 重启后 liveState 会话重建，生产 `pnpm start` 不受影响 |
| win32 未真机验证 | pnpm.cmd/taskkill 分支已实现，仅 posix 真机验证过 |
| PlayView 远程游玩 | 需给游戏端口建独立域名站点；当前 `VITE_GAME_SERVER_URL=ws://localhost:3211` 仅服务器本机有效，远程浏览器连不上游戏实例 |
| 控制台周期性告警 | `@colyseus_schema "refId" not found`（admin 观察者 join/leave 与客户端 patch 竞态），不影响功能 |

### 7.2 功能限制

| 限制 | 说明 |
|---|---|
| 校验错误可读性 | 整体校验终门对坏实体报错为本体 zod v4 issues 原始 JSON 串；部分 JSON 语法错误消息无行号（Node 短消息） |
| plan diff 噪音 | 含 JSON 重排噪音（未做语义 diff） |
| PUT 可新建文件 | 配置写接口未禁止新建；工作区删除为硬删除 |
| 备份无保留策略 | `server/backups/` 只增不清，需人工清理 |
| 地图工具 | tiled 类型图 geometry → 400（本体有 tiled-source 管道，放开 kind 检查即可）；geometry 无缓存（百 ms 级生成，可按 version 做 LRU） |
| 前端构建 | `/assets` 长缓存（nginx expires）待办，当前哈希文件名可安全开启；chunk 未拆分（`editor.api` 2.6MB 等 4 个 >500kB） |

### 7.3 运维备忘

- **全量检查基线**：`pnpm check:all` 全绿（106 测试 + server tsc 零错误）是改码后的回归底线。
- **部署工作流**：域名站（5174）更新 = `pnpm --filter web run build-only`，即生效。
- **本体健康自检**：`cd ../game_server_test && git status` 应恒为空（仅运行时产物），这是"零改动红线"的 ground truth。
- **管理后端退出不连带杀实例**：游戏实例生命周期独立，由 REST stop 管理；管理后端重启后实例状态以 `GET /api/instances` 重新对齐。
