# Spike 报告：TS JSDoc → zod v4 → z.toJSONSchema 描述注入

- 生成时间：2026-09-24T08:56:42.512Z
- 本体 schema 目录（只读）：`game_server_test/framework/config/schema`
- zod 版本（经 createRequire(GAME_ROOT) 解析，与 schema 同实例）：`4.4.3`
- toJSONSchema reused 默认：inline（实测无 $defs/$ref；本报告逐一核对了结果）
- 运行方式：`cd excalibur_test/server && pnpm exec tsx ../scripts/spike-jsdoc-schema.mts`

## 统计总览

| kind | 输出文件 | 扫描字段数 | 直接 JSDoc | 有描述(含 bullet/ref) | 成功注入并验证 | 丢失 | 对齐告警 |
|------|----------|-----------:|-----------:|----------------------:|---------------:|-----:|---------:|
| GameDefinition | `game-definition.schema.json` | 28 | 11 | 26 | 26 | 0 | 0 |
| crafting | `crafting.schema.json` | 10 | 0 | 3 | 3 | 0 | 0 |
| MapRegistry | `map-registry.schema.json` | 10 | 8 | 8 | 8 | 0 | 0 |
| Archetype | `archetype.schema.json` | 5 | 0 | 5 | 5 | 0 | 0 |

> 注：`成功注入并验证` = 该字段的 description 在输出 JSON 的对应 JSON pointer 上被逐条核对存在且相等。
> `直接 JSDoc` 仅统计属性自身 JSDoc；`有描述` 额外含从声明 bullet 清单 / 被引用子 schema 声明回退得到的描述。

## GameDefinition（GameDefinitionSchema ← GameDefinitionSchema.ts）

- 扫描字段：28；直接 JSDoc：11；有描述：26；注入验证：26/26
- 输出：`game-definition.schema.json`；$defs=false；对齐告警：0

字段注入明细：

| JSON pointer | 字段 | 来源 | 描述（截断） | 位置 |
|--------------|------|------|--------------|------|
| `/properties/id` | id | bullet | 定义标识与显示名 | game_server_test/framework/config/schema/GameDefinitionSchema.ts:93 |
| `/properties/name` | name | bullet | 定义标识与显示名 | game_server_test/framework/config/schema/GameDefinitionSchema.ts:94 |
| `/properties/worldview` | worldview | bullet | 世界观/主题透传（不校验内部） | game_server_test/framework/config/schema/GameDefinitionSchema.ts:95 |
| `/properties/world` | world | jsdoc | 全局世界段：tile 像寸（缺省 16×16，见 WorldSchema）。 | game_server_test/framework/config/schema/GameDefinitionSchema.ts:97 |
| `/properties/world/properties/tile` | tile | ref-decl | 全局 tile 像寸（game.json 的 world.tile）——`*Tiles` 配置量… | game_server_test/framework/config/schema/GameDefinitionSchema.ts:56 |
| `/properties/world/properties/tile/properties/width` | width | jsdoc | tile 宽度（像素）。 | game_server_test/framework/config/schema/GameDefinitionSchema.ts:42 |
| `/properties/world/properties/tile/properties/height` | height | jsdoc | tile 高度（像素）。 | game_server_test/framework/config/schema/GameDefinitionSchema.ts:44 |
| `/properties/tickRate` | tickRate | bullet | 逻辑 tick 频率（次/秒） | game_server_test/framework/config/schema/GameDefinitionSchema.ts:98 |
| `/properties/map` | map | bullet | 地图清单路径（registry）与默认地图（default） | game_server_test/framework/config/schema/GameDefinitionSchema.ts:99 |
| `/properties/map/properties/default` | default | jsdoc | 默认地图 key（maps/registry.json 的 maps 表键；新玩家出生图）。 | game_server_test/framework/config/schema/GameDefinitionSchema.ts:102 |
| `/properties/map/properties/entityRules` | entityRules | jsdoc | 实体演化规则文件路径（maps/entity-rules.json，补差引擎的规则源）。 | game_server_test/framework/config/schema/GameDefinitionSchema.ts:104 |
| `/properties/map/properties/ecosystems` | ecosystems | jsdoc | 生态声明层文件路径（game/ecosystems.json，B1 编译器模式——boot 期展… | game_server_test/framework/config/schema/GameDefinitionSchema.ts:106 |
| `/properties/systems` | systems | bullet | 启用的系统列表（见 SystemEnableEntrySchema） | game_server_test/framework/config/schema/GameDefinitionSchema.ts:108 |
| `/properties/systems/items/properties/id` | id | bullet | 引用系统注册表（registerSystem）中的系统名 | game_server_test/framework/config/schema/GameDefinitionSchema.ts:28 |
| `/properties/systems/items/properties/enabled` | enabled | bullet | 是否启用（缺省启用；false 用于停用默认开启的系统，如替换内置系统时） | game_server_test/framework/config/schema/GameDefinitionSchema.ts:29 |
| `/properties/systems/items/properties/config` | config | bullet | 系统级配置（透传给系统工厂，内部结构不校验） | game_server_test/framework/config/schema/GameDefinitionSchema.ts:30 |
| `/properties/entities` | entities | bullet | 各内容文件路径 | game_server_test/framework/config/schema/GameDefinitionSchema.ts:109 |
| `/properties/behaviors` | behaviors | bullet | 各内容文件路径 | game_server_test/framework/config/schema/GameDefinitionSchema.ts:110 |
| `/properties/rules` | rules | bullet | 各内容文件路径 | game_server_test/framework/config/schema/GameDefinitionSchema.ts:111 |
| `/properties/items` | items | bullet | 各内容文件路径 | game_server_test/framework/config/schema/GameDefinitionSchema.ts:112 |
| `/properties/dialogues` | dialogues | jsdoc | 对话树配置段（game/dialogues/*.json）。 | game_server_test/framework/config/schema/GameDefinitionSchema.ts:114 |
| `/properties/quests` | quests | jsdoc | 任务定义配置段（game/quests/*.json）。 | game_server_test/framework/config/schema/GameDefinitionSchema.ts:116 |
| `/properties/netSync` | netSync | bullet | 网络同步字段配置（见 NetSyncFieldSchema） | game_server_test/framework/config/schema/GameDefinitionSchema.ts:117 |
| `/properties/netSync/properties/fields/items/properties/component` | component | jsdoc | 要同步的组件名（SoA 组件或 AoS 组件）。 | game_server_test/framework/config/schema/GameDefinitionSchema.ts:70 |
| `/properties/netSync/properties/fields/items/properties/fields` | fields | jsdoc | 要同步的字段名列表（AoS 组件按字段展平为 numbers/strings）。 | game_server_test/framework/config/schema/GameDefinitionSchema.ts:72 |
| `/properties/netSync/properties/fields/items/properties/tags` | tags | jsdoc | 可选：限定同步该字段的实体标签（bitecs tag 组件名）。 用于 AoS 组件（非 bit… | game_server_test/framework/config/schema/GameDefinitionSchema.ts:78 |

丢失清单：**空**（所有取到描述的字段都已在输出对应位置验证存在）。

无描述字段（允许缺省，不报错）：

- `/properties/map/properties/registry`（game_server_test/framework/config/schema/GameDefinitionSchema.ts:100）
- `/properties/netSync/properties/fields`（game_server_test/framework/config/schema/GameDefinitionSchema.ts:118）

### 成功标准检查

- ✔ 顶层 tickRate 描述 — path=/properties/tickRate 期望含"逻辑 tick"，实际="逻辑 tick 频率（次/秒）"
- ✔ 顶层 world 描述 — path=/properties/world 期望含"全局世界段"，实际="全局世界段：tile 像寸（缺省 16×16，见 WorldSchema）。"
- ✔ world.tile.width 描述 — path=/properties/world/properties/tile/properties/width 期望含"tile 宽度"，实际="tile 宽度（像素）。"
- ✔ world.tile.height 描述 — path=/properties/world/properties/tile/properties/height 期望含"tile 高度"，实际="tile 高度（像素）。"
- ✔ netSync.fields[].component 描述 — path=/properties/netSync/properties/fields/items/properties/component 期望含"组件名"，实际="要同步的组件名（SoA 组件或 AoS 组件）。"

## crafting（CraftingRuleSchema ← RuleSchema.ts）

- 扫描字段：10；直接 JSDoc：0；有描述：3；注入验证：3/3
- 输出：`crafting.schema.json`；$defs=false；对齐告警：0

字段注入明细：

| JSON pointer | 字段 | 来源 | 描述（截断） | 位置 |
|--------------|------|------|--------------|------|
| `/properties/recipes/items/properties/stationType` | stationType | bullet | 需要的站点类型编号（缺省 0 = 通用手搓，无需站点）； 非 0 时要求合成者在 station… | game_server_test/framework/config/schema/RuleSchema.ts:60 |
| `/properties/recipes/items/properties/inputs` | inputs | bullet | kind 字符串引用 item 表 + 数量 | game_server_test/framework/config/schema/RuleSchema.ts:61 |
| `/properties/recipes/items/properties/outputs` | outputs | bullet | kind 字符串引用 item 表 + 数量 | game_server_test/framework/config/schema/RuleSchema.ts:62 |

丢失清单：**空**（所有取到描述的字段都已在输出对应位置验证存在）。

无描述字段（允许缺省，不报错）：

- `/properties/recipes`（game_server_test/framework/config/schema/RuleSchema.ts:66）
- `/properties/recipes/items/properties/id`（game_server_test/framework/config/schema/RuleSchema.ts:59）
- `/properties/recipes/items/properties/inputs/items/properties/kind`（game_server_test/framework/config/schema/RuleSchema.ts:53）
- `/properties/recipes/items/properties/inputs/items/properties/count`（game_server_test/framework/config/schema/RuleSchema.ts:54）
- `/properties/recipes/items/properties/outputs/items/properties/kind`（game_server_test/framework/config/schema/RuleSchema.ts:53）
- `/properties/recipes/items/properties/outputs/items/properties/count`（game_server_test/framework/config/schema/RuleSchema.ts:54）
- `/properties/stationRange`（game_server_test/framework/config/schema/RuleSchema.ts:67）

### 成功标准检查

- ✔ recipes[].inputs 描述 — path=/properties/recipes/items/properties/inputs 期望含"kind 字符串引用"，实际="kind 字符串引用 item 表 + 数量"
- ✔ recipes[].outputs 描述 — path=/properties/recipes/items/properties/outputs 期望含"kind 字符串引用"，实际="kind 字符串引用 item 表 + 数量"
- ✔ recipes[].stationType 描述 — path=/properties/recipes/items/properties/stationType 期望含"站点类型"，实际="需要的站点类型编号（缺省 0 = 通用手搓，无需站点）； 非 0 时要求合成者在 stationRange 内有匹配类型"
- ✔ 无 JSDoc 字段 kind 不产生描述（允许缺省） — recipes[].inputs[].kind description=(无)

## MapRegistry（MapRegistrySchema ← MapRegistrySchema.ts）

- 扫描字段：10；直接 JSDoc：8；有描述：8；注入验证：8/8
- 输出：`map-registry.schema.json`；$defs=false；对齐告警：0

字段注入明细：

| JSON pointer | 字段 | 来源 | 描述（截断） | 位置 |
|--------------|------|------|--------------|------|
| `/properties/maps` | maps | jsdoc | 全部地图条目表（key = 地图 registry key）。 | game_server_test/framework/config/schema/MapRegistrySchema.ts:62 |
| `/properties/maps/additionalProperties/oneOf/0/properties/seed` | seed | jsdoc | 随机种子（各管道步骤经 seed + 步骤序号派生独立流，同 seed 同产出）。 可省略：省略… | game_server_test/framework/config/schema/MapRegistrySchema.ts:34 |
| `/properties/maps/additionalProperties/oneOf/0/properties/initialAgeTicks` | initialAgeTicks | jsdoc | 开机初始演化跨度（tick）：无档启动时该图从 0 演化到该时刻。 | game_server_test/framework/config/schema/MapRegistrySchema.ts:36 |
| `/properties/maps/additionalProperties/oneOf/0/properties/pipeline` | pipeline | jsdoc | 生成积木管道（按声明顺序执行，至少一步）。 | game_server_test/framework/config/schema/MapRegistrySchema.ts:38 |
| `/properties/maps/additionalProperties/oneOf/0/properties/pipeline/items/properties/generator` | generator | jsdoc | 积木注册名（生成积木注册表中的 id，如 "noise-terrain"）。 | game_server_test/framework/config/schema/MapRegistrySchema.ts:21 |
| `/properties/maps/additionalProperties/oneOf/0/properties/pipeline/items/properties/params` | params | jsdoc | 该步骤的自有参数切片（结构由各积木定义，框架不校验内部）。 | game_server_test/framework/config/schema/MapRegistrySchema.ts:23 |
| `/properties/maps/additionalProperties/oneOf/1/properties/path` | path | jsdoc | Tiled JSON 文件路径（相对本清单文件；缺文件/解析失败在加载期报错）。 | game_server_test/framework/config/schema/MapRegistrySchema.ts:45 |
| `/properties/maps/additionalProperties/oneOf/1/properties/initialAgeTicks` | initialAgeTicks | jsdoc | 开机初始演化跨度（tiled 图通常为 0——静态地图无初始生态）。 | game_server_test/framework/config/schema/MapRegistrySchema.ts:47 |

丢失清单：**空**（所有取到描述的字段都已在输出对应位置验证存在）。

无描述字段（允许缺省，不报错）：

- `/properties/maps/additionalProperties/oneOf/0/properties/kind`（game_server_test/framework/config/schema/MapRegistrySchema.ts:28）
- `/properties/maps/additionalProperties/oneOf/1/properties/kind`（game_server_test/framework/config/schema/MapRegistrySchema.ts:43）

### 成功标准检查

- ✔ union 分支0(pipeline).seed 描述 — path=/properties/maps/additionalProperties/oneOf/0/properties/seed 期望含"随机种子"，实际="随机种子（各管道步骤经 seed + 步骤序号派生独立流，同 seed 同产出）。\n可省略：省略时新档开机随机生成并随首"
- ✔ union 分支0(pipeline).pipeline 描述 — path=/properties/maps/additionalProperties/oneOf/0/properties/pipeline 期望含"生成积木管道"，实际="生成积木管道（按声明顺序执行，至少一步）。"
- ✔ union 分支1(tiled).path 描述 — path=/properties/maps/additionalProperties/oneOf/1/properties/path 期望含"Tiled JSON"，实际="Tiled JSON 文件路径（相对本清单文件；缺文件/解析失败在加载期报错）。"
- ✔ union 分支1(tiled).initialAgeTicks 描述 — path=/properties/maps/additionalProperties/oneOf/1/properties/initialAgeTicks 期望含"初始演化跨度"，实际="开机初始演化跨度（tiled 图通常为 0——静态地图无初始生态）。"

## Archetype（ArchetypeSchema ← ArchetypeSchema.ts）

- 扫描字段：5；直接 JSDoc：0；有描述：5；注入验证：5/5
- 输出：`archetype.schema.json`；$defs=false；对齐告警：0

字段注入明细：

| JSON pointer | 字段 | 来源 | 描述（截断） | 位置 |
|--------------|------|------|--------------|------|
| `/properties/kind` | kind | bullet | 原型唯一标识（刷怪/放置/查询等引用目标） | game_server_test/framework/config/schema/ArchetypeSchema.ts:27 |
| `/properties/tags` | tags | bullet | bitecs 标签组件名列表（用于查询过滤，如 netSync 按 tags 限定同步范围） | game_server_test/framework/config/schema/ArchetypeSchema.ts:28 |
| `/properties/components` | components | bullet | 组件初值表（组件名 → 初值；AoS 组件的初值形态由组件初始化钩子解读） | game_server_test/framework/config/schema/ArchetypeSchema.ts:29 |
| `/properties/behavior` | behavior | bullet | AI 行为树配置 id（引用 game/behaviors/*.json） | game_server_test/framework/config/schema/ArchetypeSchema.ts:30 |
| `/properties/team` | team | bullet | 队伍编号（战斗归属判断用；缺省无队伍） | game_server_test/framework/config/schema/ArchetypeSchema.ts:31 |

丢失清单：**空**（所有取到描述的字段都已在输出对应位置验证存在）。

### 成功标准检查

- ✔ components(record) 描述 — path=/properties/components 期望含"组件名"，实际="组件初值表（组件名 → 初值；AoS 组件的初值形态由组件初始化钩子解读）"
- ✔ components 值为 unknown → 无 properties 可递归、不报错 — components.additionalProperties = {"description":"组件配置值可为对象（SoA 字段初值）或数组等任意结构（AoS 组件如 Needs/Inventory）。\nAoS 组件的具体
- ✔ tags 描述 — path=/properties/tags 期望含"标签组件"，实际="bitecs 标签组件名列表（用于查询过滤，如 netSync 按 tags 限定同步范围）"

## 结论

- 成功标准：16/16 通过；丢失字段：0；对齐告警：0。
- 判定：**可行** —— 链路成立。

### zod v4 机制坑（实测）

1. **`.meta()` 会克隆实例**（`s !== s.meta({...})`），无法对"已加载的 zod 实例"事后补描述；本 spike 改用 `z.registry()` + `z.toJSONSchema(schema, { metadata: registry })`，registry 按**实例身份**补 description，且不需要替换 shape 里的节点引用——这是本链路能成立的关键。
2. **`.refine()` 在 v4 不产生新节点**（type 仍为 `object`，校验挂在 `def.checks`），因此 `.shape` 直接可用，不需要穿透 ZodEffects。
3. **包装节点必须按 `_zod.def.innerType` 解包**：`optional` / `default` / `nullable` / `readonly`。描述挂在外层包装实例上即可被 `toJSONSchema` 采纳（实测 `ZodDefault`、`ZodOptional` 外层描述均出现在输出）。
4. **`toJSONSchema` 默认 `reused: "inline"`**，不产生 `$defs`/`$ref`；同一子 schema 实例被多处引用时输出会内联复制，描述随之复制（本 spike 的验证器仍带 `$ref` 兜底导航以备未来切换 `reused: "ref"`）。
5. **映射约定**：`discriminatedUnion` → `oneOf`；`record` → `additionalProperties`；`array` → `items`；`z.unknown()` → `{}`（无结构、无描述）。

### 对齐策略要点

- 双侧递归：AST 沿 `z.object/.array/.record/.discriminatedUnion` 链找 base call（`.optional()/.refine()` 等链式调用自动穿透），运行时按 zod `shape` 同层按属性名对齐；属性值是标识符时解析该 const（含非导出 const，经 ts-morph 索引，不依赖运行时可导入性）。
- 描述来源三级回退：① 属性自身 JSDoc → ② 所属声明 JSDoc 的 `- 字段：描述` 条目 → ③ 同文件任意 JSDoc 块的同名字段条目（兜底，处理本仓"文档块错位"现状，如 `RuleSchema.ts` 里合成配方的 bullet 实际挂在 `RecipeInputSchema` 声明上）→ ④ 引用具名子 schema 时回退其声明描述。
- 本仓 `tickRate` 无属性级 JSDoc，其描述仅在 `GameDefinitionSchema` 声明块 bullet 里，正由②命中；`recipes[].inputs/outputs` 由③命中。

### 已知局限与启发式副作用（如实记录）

1. **组合 bullet 会让多字段共享描述**：声明块里 `- entities/behaviors/rules/items/dialogues/quests：各内容文件路径` 这类合并写法，本 spike 按 `/` 拆名后给 `entities/behaviors/rules/items`（`dialogues/quests` 有属性级 JSDoc 覆盖）分到同一句"各内容文件路径"。生产实现建议改用更精确的锚点，或先完善本体 JSDoc。
2. **文档块错位需要同文件兜底**：`RuleSchema.ts` 里合成配方的 bullet（`stationType`/`inputs`/`outputs`）实际挂在 `RecipeInputSchema` 声明上，只能靠"同文件任意 JSDoc 块同名字段"兜底（③）。同名跨声明时存在误配风险。
3. **只覆盖从 kind 根可达的 schema**：独立 const 子 schema 若未被任何导出根引用，不会出现在输出，也不参与统计。
4. **递归/自引用 schema**：AST 侧用 `seen` 集合防环；本仓未遇到，未做端到端验证。
5. **一致性守卫**：运行时 shape 与 AST 不一致（多键/少键/类型不符）会记为"对齐告警"，本仓 0 条——说明当前源码与运行时结构完全同构。
6. **registry 生命周期**：`z.registry()` 是进程内、按实例身份的表；生产应"每次启动构造 registry → 注入 → toJSONSchema"，并保证 schema 实例不被重新加载/替换，否则描述丢失。
7. **`reused: "ref"` 未端到端验证**：本 spike 用默认 inline；验证器虽带 `$ref` 导航兜底，但未对 `toJSONSchema(schema, { reused: "ref" })` 的 `$defs` 描述做端到端实测。若生产要压缩体积切到 ref 模式，应补测。
8. **本 spike 只读本体**：仅 `import`/读源码，未写 `game_server_test` 任何文件；产物全部在 `excalibur_test/tmp/spike-jsdoc-schema/`。
