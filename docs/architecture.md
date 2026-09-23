# 架构与运维 — 游戏服务端可视化管理平台

> 需求依据：[PRD-游戏服务端可视化管理平台.md](PRD-游戏服务端可视化管理平台.md) v2.3；多游戏架构实施计划：[multi-game-plan.md](multi-game-plan.md)。
> 本文以当前代码实况为准，描述系统架构、关键流水线、部署拓扑与运维备忘。

## 1. 系统架构：四通道模型

平台是游戏服务端仓库（默认为本体 `game_server_test`，gameId `gst`；可注册更多游戏，见 §3）的只读包裹，与每个已注册游戏仓库之间均存在且仅存在四条通道：

| 通道 | 载体 | 说明 |
|---|---|---|
| 进程控制 | `instanceManager`（per-game） | spawn/树杀双实例，env 注入（变量名出自 manifest，端口出自 registry entry） |
| 文件系统 | 工作区 / 落盘 / 存档服务 | 读：镜像游戏仓 `game/` 到工作区；写：仅落盘写回（校验 + 备份）与运行时产物（logs/、saves/） |
| 代码引用 | sidecar driver 子进程 | 每游戏一个常驻 driver，tsx 直读游戏仓 framework 源码，stdio NDJSON RPC（§2 / §3.1） |
| 网络观察 | `liveState` + 日志流 + PlayView | @colyseus/sdk schema-less 观察者采样、日志文件 tail + 进程 stdio、Colyseus 客户端实时渲染 |

```
web/ (5173 dev | 5174 preview)
  │  REST /api/games/:gameId/*（过渡期旧 /api/* 别名内部 forward 到默认游戏）
  │  + WS /ws?channel=（同源代理或直连）
  ▼
server/ (3100, Express 5 + ws + tsx)
  │ routes → services → sidecar client ──stdio NDJSON──► driver 子进程（每游戏一个，tsx 直读游戏仓 framework）
  │ instanceManager ──spawn/env 注入──► official / preview 游戏进程（端口出自 registry entry）
  │ liveState ──@colyseus/sdk 观察者──► 游戏房间（1s 采样）
  └─ logStream ──tail logs/game.log + 进程 stdio
```

## 2. 分层与 sidecar

分层铁律：`server/src/routes → server/src/services → sidecar client → driver 子进程（游戏仓）→ 本体 framework`。

- **routes**：REST 路由，统一响应 `{code, message, detail?}`，400/404/409/422 分类明确；路由层经 `servicesFor(req.gameId)` 取 per-game 服务容器（§3.4）。
- **services**：领域服务（实例管理、工作区、配置、落盘、地图、存档、liveState、日志流），全部"构造器收 GameContext + 按 gameId 缓存实例"（§3.4）。
- **sidecar**（`server/src/sidecar/` + `server/sidecar/driver.ts`）：**唯一引用游戏代码的桥**，物理形态从"跨仓 tsconfig paths 进程内 import（原 gameBridge，已删除）"改为"子进程 RPC"：
  - driver：常驻子进程，cwd = 游戏仓根、`node --import tsx` + `TSX_TSCONFIG_PATH=<游戏仓>/tsconfig.json`，tsx 运行时直读游戏仓 TS 源码（免 build）；引入路径复刻原 gameBridge 实况（framework 门面 + `framework/config/schema/*` 子路径）。
  - schema kind 表（8 个 kind）与全部 zod 对象迁入 driver——**平台侧不再持有任何 zod 对象**；server 依赖已移除本体依赖（bitecs 等）与全部跨仓 tsconfig paths。
  - 原 Spike 结论在 driver 侧继续生效：本体 `tools/validate.ts` 的 `validate()` 失败路径带 `process.exit(1)` CLI 副作用，不可同进程复用 → driver 直接 import 幂等的 `bootstrapFramework()` + `loadGameDefinition()`；后者对缺失 game.json 会静默回退默认定义，整体校验保留存在性预检防御。
  - 原 zod 双实例问题就此消解：schema 校验全部在本体依赖树内完成，issues 以 `{path, message}[]` 形状过线（平台侧 `mapZodIssues` 零改动复用）。
- sidecar 错误码 → REST：`bad_request`→400、`game_config_error`→422、`driver_error`→500、`unavailable`→503、`timeout`→504。

## 3. 多游戏架构（Phase 2 定型）

多游戏能力四件套：**games registry**（注册表）+ **manifest**（游戏接入契约）+ **双源导入流** + **per-game 命名空间**；配套新版 API 寻址与游戏管理 UI。设计全文见 [multi-game-plan.md](multi-game-plan.md)（已拍板决策表在其 §6），本节为落地实况。

### 3.1 sidecar 驱动进程模型

**每个已注册游戏各一个 driver 进程**，由平台侧按需 spawn（Phase 0 spike 定型的候选 1 机制）：

```
spawn(process.execPath,
      ['--import', 'tsx', <repo>/server/sidecar/driver.ts],
      { cwd: <gameRoot>, env: { …, TSX_TSCONFIG_PATH: <gameRoot>/tsconfig.json } })
```

- tsx 借游戏仓 tsconfig 解析 framework 别名，游戏仓零改动、零 build；git 源游戏同理（cwd = 平台自有 checkout）。
- 协议：stdio NDJSON——请求 `{id, method, params}`，响应 `{id, ok:true, result}` / `{id, ok:false, error:{code, message}}`；driver 的 **stdout 只允许协议帧**（`fs.writeSync(1, …)` 直写 fd 1，并把 winston/console 的 stdout 输出重定向到 stderr），诊断一律走 stderr；请求**串行**处理（framework 全局单例语义）。
- 方法表 6 个：`ping`（含 zod 版本与 framework 自检）、`listRegistries`、`validateFile`、`validateWhole`、`buildMapGeometry`、`exportMapArtifacts`。
- 超时：默认 15s，`buildMapGeometry` / `exportMapArtifacts` 60s；超时只返回错误帧，**不杀 driver**。

**生命周期**（`SidecarClient`）：

- **lazy start**：该游戏首个 RPC 才 spawn；
- driver 退出 → 下一次 RPC 自动重启一次；**连续 2 次 spawn 失败 → sticky `unavailable`**（不再自动重试，防 crash loop；REST 503），显式 `restart()` 恢复；
- 管理后端退出时由 `process.on('exit')` 钩子统一 SIGTERM driver——driver 是计算附属物，不留孤儿（与游戏实例"独立存活"语义相反）。

**per-game 持有与指纹失效**（`SidecarManager`，`Map<gameId, SidecarClient>`）：

- 指纹 = registry `resolved.commit` + `resolved.lockfileHash`（git 源，由 sync 流程回填）；local 源再叠加 **live 指纹**（游戏仓 `git rev-parse HEAD`，非 git 目录回退目录 mtime hash）——registry 记录与工作区实况任一变化都触发重建；
- 指纹变化 → `stop()` 旧 driver（SIGTERM），下次 RPC lazy 重启；`invalidate(gameId)` 为显式兜底（连 gameContext 缓存一并清除）；
- 已知代价：local 源每次解析 spawnSync 一次 `git rev-parse`（~10ms 量级），高频化后可加 TTL 缓存。

### 3.2 games registry 与 manifest 契约

`server/games/` 布局（registry 与 manifest 均为运行时状态，gitignore，Q1）：

```
server/games/
├── registry.json          # 游戏注册表（全部 entry；原子写：临时文件 + rename）
└── <gameId>/
    ├── game.json          # manifest（游戏接入契约；探测生成，可 PATCH 精修）
    └── checkout/          # git 源：平台自有 blobless clone（local 源无此目录）
```

registry entry 字段（`games` map 的值）：

| 字段 | 语义 |
|---|---|
| `name` | 展示名（游戏管理 UI；PATCH 可改） |
| `isDefault` | "默认游戏"标志，与 id 解耦（Q5，默认 id = `'gst'`）；全表至多一个 true，是旧路由 forward 的目标 |
| `source` | `{type:'git', url, ref}` 或 `{type:'local', path}`（相对路径以平台仓库根锚定，如 `'../game_server_test'`） |
| `resolved` | `{commit, syncedAt, lockfileHash}` 同步指纹；空串 = 尚未同步 |
| `ports` | `{official, preview}` 实例端口（§3.4 端口池） |
| `createdAt` | entry 创建时间（ISO 8601） |

- `gameId` 规则：`/^[\w-]+$/` 且 ≤ 64 字符（进文件系统路径与 WS 频道名）。
- 读写：整文件 JSON + 原子替换（读者永不见半文件）；进程内缓存 mtime/size 失效，外部改动下次读取即生效。
- **启动播种**：registry.json 不存在时按 defaultGameContext 播种 `gst` entry（local 源 `../game_server_test`、isDefault、端口继承现状解析值）——保证无 registry 也能起；文件已存在则幂等 no-op。

manifest（`server/games/<id>/game.json`，zod strictObject，未知键报错）字段语义：

| 字段 | 语义 |
|---|---|
| `id` | 与 registry entry / REST `:gameId` / WS 频道段一致 |
| `configDir` / `configEntry` / `savesDir` / `logsDir` / `envFile` | 相对 checkout 游戏根的路径（'/' 分隔，默认 `game` / `game.json` / `data/saves` / `logs` / `.env`） |
| `start` | 游戏实例启动命令 `{command, args}`（默认 `pnpm dev`；win32 的 pnpm→pnpm.cmd 适配留在消费方） |
| `envInjection` | preview 实例注入的 env 变量**名** `{port, configPath, saveDir}`（值由 spawn 前动态解析） |
| `schemaRoutes` | 配置文件 → schema kind 路由表 `[{pattern, kind}]`；`kind:'*'` 表示取文件名去 `.json` |
| `capabilities` | sidecar 能力开关 `{wholeConfigValidation, mapGeometry, registries[]}` |
| `observer` | 观察端挂点 `{plugin, roomName, clientSchema?}`（roomName 即 Colyseus join 房间名；clientSchema 为 P3 插件化预留） |
| `trustScripts` | git 源导入 `pnpm install` 是否放行 scripts 的白名单开关（缺省 false，Q6） |

- **探测**（`probeManifest`）：硬锚点 `game/game.json` 与 `framework/index.ts`，缺一即失败（422 说明缺失项）；`package.json` 有 `dev` → start 默认 `pnpm dev`；`.env` 的 PORT 只提示不覆盖端口池；schemaRoutes 等默认值引用 defaultGameContext 的 8 条路由——**第二款游戏接入时必须手工核对修改（契约考试点）**。
- **合成**（`gameContext.forGame(gameId)`）：registry entry + manifest → per-game `GameContext`（路径/端口/启动命令/注入名/schemaRoutes/roomName 全部由此派生）；manifest 文件缺失时现场探测生成并原子写盘，此后 manifest 是单一事实源；缓存以 manifest/registry 文件 mtime+size 失效。

### 3.3 双源导入 / 更新 / 移除流

服务层 `gameSyncService`（REST 与 CLI `scripts/sync-game.mjs` 共用同一逻辑）。

**git 源导入**（阶段 `clone → install → probe → smoke`）：

1. `git clone --filter=blob:none <url> server/games/<id>/checkout` → `git checkout <ref>` → `git rev-parse HEAD` 写 `resolved.commit` → lockfileHash（pnpm-lock.yaml sha256）；
2. 首装或 lockfileHash 变化时自动 `pnpm install`：默认 `--ignore-scripts`（另加 `--ignore-workspace`），仅 manifest `trustScripts: true` 才放行 scripts；
3. `probeManifest` 生成 manifest 原子写盘；
4. `upsertGame` 注册（端口池 first-fit，分配即持久化）→ `sidecarManager.invalidate` → `listRegistries` 冒烟（首探放宽 60s）；
5. 任一步失败**整体回滚**：删 checkout 与 manifest，registry 不残留。

**local 源导入**（阶段 `validate → probe → smoke`）：不 clone、跳过 install（假定开发者自行管理依赖）；校验源目录存在且含 `framework/index.ts`（否则 422 并说明缺失项）；指纹取源目录 `git rev-parse HEAD`（非 git 目录回退目录 mtime hash 并标注 `dir-mtime`）。

**更新**（`POST /api/games/:gameId/sync`，幂等）：git 源 fetch + checkout + 指纹比较；local 源重探测 + 指纹比较；指纹没变 → noop（registry/manifest 均不写）。

**移除**（`DELETE /api/games/:gameId`）：registry 删项 + 清 `server/games/<id>/`（local 源的外部源目录绝不动）；`server/workspaces/<id>/`、`server/backups/<id>/` 默认保留。守卫（409）：默认游戏不可删（须先转移 isDefault）、最后一个游戏不可删。

并发语义：同 id 导入/同步进行中 → 并发请求 409（`isImporting`）；导入/同步子进程全异步 spawn（分钟级 clone 不阻塞事件循环），进度打 admin 日志。

### 3.4 per-game 命名空间与端口池

**服务容器**：`servicesFor(gameId)`（`server/src/services/index.ts`）聚合该游戏全套领域服务实例 `{workspace, config, map, save, apply, log, live, instances}`——路由层不再 import 全局单例。contextHolder 热更新：manifest/registry 变化重建 GameContext 后，既有服务实例（进程句柄/环形缓冲/观察会话）原样保留，仅上下文引用换新。`gst` 缺省走 compat 单例集合（与启动接线共享同一批实例，行为连续）。

存储命名空间（原全局目录全部收进 `<gameId>/` 一层）：

| 内容 | Phase 1（单游戏） | Phase 2（per-game） |
|---|---|---|
| 工作区 | `server/workspaces/<uuid>/` | `server/workspaces/<gameId>/<uuid>/` |
| 活动工作区 | `server/workspaces/.active-workspace.json`（v1 `{id}`） | `server/workspaces/<gameId>/.active-workspace.json`（v2 `{version:2, gameId, id}`，**只认 v2**，读到 v1 fail-fast 提示跑迁移脚本） |
| 落盘备份 | `server/backups/<backupId>/` | `server/backups/<gameId>/<backupId>/` |
| 游戏仓 | 唯一本体 `../game_server_test` | git 源 `server/games/<id>/checkout/`；local 源注册路径 |

**端口池**：official `3000–3199`、preview `3200–3399`，first-fit 空闲、分配即持久化；段占满报错。存量 `gst` 播种不进池分配，端口原样继承现状解析值（official = 本体 `.env` PORT 实际值 3001、preview = 3200），不迁移不漂移。实例 spawn 的端口、启动命令、注入变量名全部出自 per-game `GameContext`（registry `entry.ports` + manifest）。

**目录迁移**：存量 workspaces/backups 与 v1 active 文件由 `scripts/migrate-namespaces.mjs` 一次性迁入默认游戏命名空间（执行时机见 README 运维提示）。

### 3.5 API 寻址与 WS 频道

**挂载结构**（express 5：scoped 先挂、legacy 后挂，规避参数路由冲突）：

```
app.use('/api/games', gamesRouter)                              # 列表 / 导入
app.use('/api/games/:gameId', gameResolver, gameScopedRouter)   # 详情/sync/PATCH/DELETE + 全部领域子路由
app.use('/api/instances', legacyGameScope, processRouter)       # 旧挂载点全部保留（内部 forward）
…（workspaces / configs / config-context / apply / backups / maps / saves / registries / live 同）
```

- `gameResolver`：`:gameId` 已注册 → `req.gameId`；未注册 → 404；registry 损坏 fail-fast 500。
- **旧路由 forward 过渡**（Q3）：旧挂载点命中时 `legacyGameScope` 把 `req.gameId` 置为 isDefault 游戏，走同一批 Router 实例——内部 forward、不做 307（WS 升级请求无法 307，且 forward 对客户端无感）；registry 读取失败回退 `defaultGameContext.gameId`，保持"旧客户端不断"。**别名删除时点 = P3 完成后**（Q4）。
- games 管理 API：`GET /api/games`、`POST /api/games/import`、`GET /api/games/:gameId`、`POST /api/games/:gameId/sync`、`PATCH /api/games/:gameId`（registry 字段 + manifest 高级字段，改后 sidecar 一并失效重建）、`DELETE /api/games/:gameId`（全表见 §7）。
- 错误映射新增面：`GameSyncError`（bad_source / probe_failed / smoke_failed → 422、conflict → 409、not_registered → 404、command_failed → 500 带 stderrTail）；`GameContextError`（not_registered → 404、manifest_* → 422）；`RegistryError`（bad_game_id → 400）。

**WS 频道公式**（per-game 寻址）：`instance:state:{gameId}` / `instance:log:{gameId}:{role}` / `live:{gameId}:{role}`；白名单 = 粗正则 `^(instance:state|instance:log|live):[\w-]+(?::[\w-]+)?$` + 结构校验（段数与 role 必须与广播公式一致）——粗正则会放过旧频道名（如 `live:official`），结构校验兜住，**旧频道名一律拒绝**（web 与 server 同窗口发布）。内容详表见 §7。

### 3.6 前端结构：currentGameId + epoch 失效 + 游戏管理 UI

- **寻址收口**（`web/src/api/admin.ts`）：REST url builder 统一产出 `/api/games/{currentGameId}/…`，WS 频道构造统一走新公式；`currentGameId` 经 `main.ts` 注入的读取器读自 games store——切换即全局生效。
- **games store**（`web/src/stores/games.ts`）：`games` 列表 + `currentGameId`（初始 = isDefault 游戏，兜底 `'gst'`）+ **`epoch`**（currentGameId 每次实际变化自增）。各域 store（workspace/config/configContext/apply/instance/live/map/save）watch epoch 失效重取自己的数据；`MainLayout` 以 `viewKey`（非 Games 路由时 = currentGameId）重挂载当前视图，挂载逻辑按新 gameId 重取。**切换只改寻址上下文，绝不启停任何实例**（实例启停只在仪表盘）；当前游戏被移除时自动回退默认游戏。
- **游戏管理 UI**（`web/src/views/GamesView.vue` + 组件）：
  - 列表/详情：name、来源单行文案（local 路径 / `url@ref`）、resolved.commit（7 位）+ syncedAt、端口、`isImporting`、sidecar 状态徽标（已就绪 / 不可用 / 未拉起——`describe` 不触发 driver spawn）；
  - `ImportGameDialog`：源类型二选一（local 路径文本框 / git url + ref），阶段条 clone → install → probe → smoke（local 源为 validate → probe → smoke），服务端完成后一次性返回错误 → 前端按错误文案推断失败阶段就地回显；
  - `GameAdvancedForm`：manifest 高级字段（start / envInjection / schemaRoutes / roomName / trustScripts）编辑，保存走 PATCH 并触发 sidecar 重建；
  - `GameSwitcher`：侧栏全局切换器（状态点 + 名称），写入 games store 的 `currentGameId`。

## 4. 实例管理

双实例（role = `official` | `preview`）各一个独立状态机，**每个游戏独立一套**（`servicesFor(gameId).instances`）：

```
stopped → starting → running → (crashed | stopped)
```

- **starting**：spawn 已发起，等子进程成功拉起；**crashed**：非管理端发起的退出（外部杀死/自身崩溃/spawn 失败），记录 `lastExitCode` / `lastSignal`；重复 start/stop 冲突 → 409。
- **跨平台 spawn**：
  - win32：`spawn('pnpm.cmd', ['dev'], { shell: true })`，停止用 `taskkill /PID <pid> /T /F` 树杀（⚠️ 未真机验证）；
  - posix：`spawn('pnpm', ['dev'], { detached: true })` 进程组组长，`kill(-pid)` 杀整组，宽限超时升级 SIGKILL。
- 启动命令与参数出自 per-game `GameContext.start`（manifest）。
- **env 注入**（变量名出自 manifest `envInjection`，端口出自 registry `entry.ports`）：
  - official：不注入端口变量，展示端口 = registry `entry.ports.official`（gst 播种值由本体 `.env` 的 `PORT`/`OFFICIAL_PORT` 解析链固化）；
  - preview：`PORT=<ctx.ports.preview>` 恒注入（gst = 3200）；存在活动工作区时注入 `GAME_CONFIG_PATH=<工作区>/game/game.json` 与 `SAVE_DIR=<工作区>/.preview-saves/`；无工作区回退游戏仓配置（此时预览会写本体存档，UI 已明示）。
- Spike-3 结论：绝对 `GAME_CONFIG_PATH` 下资源 glob 相对 game.json 目录解析，`SAVE_DIR` 隔离成立；唯一 cwd 依赖为 winston 日志目录（见 §8 已知限制）。

## 5. 工作区 → 校验 → 落盘流水线

### 5.1 工作区

- 新建 = 游戏仓 `game/`（`GameContext.gameConfigsDir`）全量复制到 `server/workspaces/<gameId>/<id>/`，基准指纹 = 文件清单 + 内容哈希（sha256 前 16 位）。
- 活动工作区持久化在 `server/workspaces/<gameId>/.active-workspace.json`（v2 格式 `{version:2, gameId, id}`，tsx watch 重启不丢；服务只认 v2）；删除为硬删除；路径读写有穿越防护（resolve 必须落在工作区 `game/` 内）。
- schema 路由校验：路由表出自 per-game manifest `schemaRoutes`（`game.json`→GameDefinition、`entities/*.json`→Archetype、`maps/registry.json`→MapRegistry、behaviors/dialogues/quests/rules/items 各归其位）；zod safeParse → 结构化错误（jsonPath + 消息 + 启发式行号），校验本身在 driver 内完成（§2）。
- `GET /api/games/:gameId/config-context`：游戏仓 vs 活动工作区清单级指纹对比（inSync），是落盘 diff 的基础。

### 5.2 落盘执行（固定串行 + 互斥锁）

```
plan（diff 审查）→ 勾选文件 → execute：
  ① TOCTOU 复核（重算 changes，变化 → 409）
  ② 文件级校验（所选文件全过，invalid → 422）
  ③ 整体校验终门（跨文件约束，422 message 即原因）
  ④ 备份（server/backups/<gameId>/<时间戳-随机>/：files/ + manifest.json）
  ⑤ 写回/删除游戏仓 → 刷新工作区基准指纹（changes 归零）
```

- **整体校验终门**兜底跨文件完整性约束——例如直接删除 cave/swamp/ruins 图会触发本体启动崩溃（ecosystems biome 必须落在某图 regions，entity-rules 亦引用图键），此类操作在落盘前被 422 拦截。
- **回滚为完整逆操作**：overwritten/deleted 从备份写回游戏仓，**added 从游戏仓删除**（含空父目录清理）；与落盘共用互斥锁（并发 409）。
- **备份链**：每次落盘在 `server/backups/<gameId>/<backupId>/` 留全量可回滚快照（backupId = 时间戳-随机，防注入）；备份无保留策略，需人工清理。

## 6. 同源模式与部署拓扑

### 6.1 同源模式（当前形态）

`VITE_ADMIN_SERVER_URL` 留空 = 同源模式：前端 REST 走相对路径 `/api`，WS 由页面协议推导（https → wss）。vite dev/preview 均带 `/api`、`/ws` 代理（目标 `VITE_ADMIN_PROXY_TARGET`，默认 `http://localhost:3100`），域名/反代部署天然无跨域。仅前后端不同源直连时才需配置该变量（后端 CORS 白名单须含页面来源）。

### 6.2 三层拓扑

```
浏览器 ──https──► 宝塔 nginx（全量反代）
                      │
                      ▼
              web preview :5174（vite preview 产物）
                      │  /api、/ws 代理
                      ▼
              admin :3100（tsx）──spawn──► official（gst=3001）/ preview（gst=3200）；其余游戏由端口池分配
                      │
                      └──sidecar driver（每游戏一个子进程）──► 游戏仓 framework
```

- **产物部署（当前）**：5174 = `pnpm --filter web run build-only` 后的 `vite preview`，每次请求直读 `dist/`，**构建完即生效，无需重启**；产物无 node_modules 引用，与敏感目录拦截无关。
- **dev 模式**：`pnpm dev` 本地直连（localhost，不经域名）。dev 依赖 `/@fs` 模块 URL，与 nginx 拦截规则冲突（见下）。
- PlayView 观察游戏实例走 Colyseus WebSocket（默认 `ws://localhost:3000`，本地 `.env.local` 为 `ws://localhost:3211`；`VITE_PREVIEW_SERVER_URL=ws://localhost:3200`）。

### 6.3 ⚠️ nginx 敏感目录拦截的坑（已还原）

宝塔站点"敏感目录拦截"正则未锚定，曾拦截 `/node_modules/**` 与 `/.pnpm/`——vite dev 的 `/@fs` 模块 URL 必含后者 → 依赖模块 404 → 页面黑屏。当时已从 `node_excalibur_test.conf` 移除这两项。**现状：该站点配置已还原为原始（含 node_modules|.pnpm 拦截）**，因此：

- 产物部署（5174）不受影响，为推荐形态；
- 若需在域名上恢复 dev 模式，改用 vhost 目录的 `node_excalibur_test.conf.bak-20260922-fixed` 备份（移除两项拦截）；注意在宝塔面板重新保存该站点会复发。

## 7. REST + WS 端点全表

REST 统一前缀 `/api`，响应 `{code, message, detail?}`。全部领域路由挂载于 `/api/games/:gameId/*`；表内书写的旧形态路径在过渡期由服务端内部 forward 到默认游戏（§3.5），两种形态行为逐点一致。

### 游戏管理（直接挂 `/api/games*`，不经 forward）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/games` | 游戏列表（entry + isImporting + sidecar 摘要）+ defaultGameId |
| POST | `/api/games/import` | 导入游戏（git/local 双源；分钟级操作，请求挂起至完成） |
| GET | `/api/games/:gameId` | 游戏详情（registry entry + manifest + sidecar 状态） |
| POST | `/api/games/:gameId/sync` | 幂等更新（git fetch / local 重探测；指纹没变 noop） |
| PATCH | `/api/games/:gameId` | 改 name/isDefault/source 与 manifest 高级字段（触发 sidecar 重建） |
| DELETE | `/api/games/:gameId` | 移除游戏（workspaces/backups 保留；默认/最后一个游戏 409） |

### 领域路由（scoped 挂 `/api/games/:gameId` 下；旧路径 forward）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/instances` | 双实例状态快照（含 gameId） |
| GET | `/api/instances/:role` | 单实例快照 |
| POST | `/api/instances/:role/start` · `/stop` · `/restart` | 启动 / 停止（树杀）/ 重启 |
| GET | `/api/instances/:role/logs?lines=200` | 日志环形缓冲回填 |
| GET | `/api/workspaces` | 工作区列表 + 活动项 |
| POST | `/api/workspaces` | 新建（镜像游戏仓 game/）并自动激活 |
| POST | `/api/workspaces/:id/activate` | 切换活动工作区 |
| PATCH | `/api/workspaces/:id` | 重命名 |
| DELETE | `/api/workspaces/:id` | 删除（硬删除） |
| GET | `/api/workspaces/:id/changes` | 相对基准指纹的变更清单 |
| GET | `/api/configs/tree` | 工作区配置目录树 |
| GET | `/api/configs/file?path=` | 读文件原文 + schemaKind |
| PUT | `/api/configs/file` | 校验后写盘（422 + jsonPath 定位；可新建文件） |
| POST | `/api/configs/validate` | 单文件 schema 校验 |
| POST | `/api/configs/validate-all` | 整体校验（跨文件约束） |
| GET | `/api/config-context` | 游戏仓 vs 活动工作区指纹对比（inSync + changes） |
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

WS：`GET /ws?channel=<name>`，30s 心跳，per-game 频道公式（§3.5；旧频道名一律拒绝）：

| 频道 | 内容 |
|---|---|
| `instance:state:{gameId}` | 实例状态快照（含 configPath/saveDir，crash 后保留） |
| `instance:log:{gameId}:{role}` | 日志行（source: file/stdout/stderr + 级别启发式） |
| `live:{gameId}:{role}` | 1s 采样 `{ts, tick, tickRate, entityCount}`（entityCount 为观察者可见实体数，兴趣裁剪） |

## 8. 已知限制与运维备忘

### 8.1 运行时限制

| 限制 | 说明 |
|---|---|
| file 日志双频道 | 双实例 cwd 均为游戏仓根，winston 写 `<gameRoot>/logs/game.log` 无法按行归属实例 → `source:'file'` 行向双频道广播兜底；仅进程 stdout/stderr 可精确归属 |
| 观察者玩家实体 | liveState 的 @colyseus/sdk 观察者 join 会在游戏内创建玩家实体（Colyseus 语义）；纯观察需本体支持 spectator 模式，超出边界 |
| 观察者字段耦合 | RoomStateView 字段名耦合本体 schema：本体 schema 改名会静默 `entityCount=0`（tick 仍正常） |
| tsx watch 重启丢观察会话 | 开发态 server 重启后 liveState 会话重建，生产 `pnpm start` 不受影响 |
| win32 未真机验证 | 游戏实例 spawn 的 pnpm.cmd/taskkill 分支已实现，仅 posix 真机验证过 |
| sidecar 仅 linux | driver spawn 机制（`node --import tsx`）仅 posix 验证；win32 差异未覆盖（决策 Q7，已知限制） |
| PlayView 远程游玩 | 需给游戏端口建独立域名站点；当前 `VITE_GAME_SERVER_URL=ws://localhost:3211` 仅服务器本机有效，远程浏览器连不上游戏实例 |
| 控制台周期性告警 | `@colyseus_schema "refId" not found`（admin 观察者 join/leave 与客户端 patch 竞态），不影响功能 |

### 8.2 功能限制

| 限制 | 说明 |
|---|---|
| 校验错误可读性 | 整体校验终门对坏实体报错为本体 zod v4 issues 原始 JSON 串；部分 JSON 语法错误消息无行号（Node 短消息） |
| plan diff 噪音 | 含 JSON 重排噪音（未做语义 diff） |
| PUT 可新建文件 | 配置写接口未禁止新建；工作区删除为硬删除 |
| 备份无保留策略 | `server/backups/` 只增不清，需人工清理 |
| 地图工具 | tiled 类型图 geometry → 400（本体有 tiled-source 管道，放开 kind 检查即可）；geometry 无缓存（百 ms 级生成，可按 version 做 LRU） |
| 前端构建 | `/assets` 长缓存（nginx expires）待办，当前哈希文件名可安全开启；chunk 未拆分（`editor.api` 2.6MB 等 4 个 >500kB） |
| games API 导入同步阻塞返回 | `POST /api/games/import` / `sync` 请求挂起至完成（分钟级），进度仅打 admin 日志；前端按错误文案推断失败阶段 |

### 8.3 运维备忘

- **全量检查基线**：`pnpm check:all` 全绿（106 测试 + server tsc 零错误）是改码后的回归底线。
- **部署工作流**：域名站（5174）更新 = `pnpm --filter web run build-only`，即生效。
- **游戏仓健康自检**：`cd ../game_server_test && git status` 应恒为空（仅运行时产物），这是"零改动红线"的 ground truth。
- **管理后端退出不连带杀实例**：游戏实例生命周期独立，由 REST stop 管理；管理后端重启后实例状态以 `GET /api/instances` 重新对齐。sidecar driver 反之：随管理后端退出统一 SIGTERM（计算附属物）。
- **多游戏运维**：游戏导入/更新/移除 CLI 与目录迁移脚本的用法、执行时机见 README「多游戏运维提示」一节。
