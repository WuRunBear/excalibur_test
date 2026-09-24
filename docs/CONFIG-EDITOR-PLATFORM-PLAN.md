# 平台侧改造计划：配置编辑器可视化（excalibur_test）

> 对应本体仓计划：`game_server_test/docs/CONFIG-EDITOR-PLAN.md`（描述源=JSDoc 注释、register 元数据、register.ts 接通）。
> 本文件是 excalibur_test 侧的实施计划。可行性依据：spike `scripts/spike-jsdoc-schema.mts`（16/16 通过），现状调研结论见文末参考。

---

## 0. 链路总览

```
sidecar driver 启动
  ├─ ts-morph 读本体 schema 源码前导 JSDoc（GAME_ROOT 锚定，一次性）
  ├─ 与 SCHEMA_TABLE 的 zod 实例双侧递归对齐 → z.registry() 构建描述注册表（缓存）
  └─ 新 RPC getSchema(kind) → z.toJSONSchema(schema, { metadata, reused:"inline" })
                                   │
server  GET /api/games/:gameId/schemas ←┘   （registries RPC 扩展元数据）
                                   │
web     schemas store（按 games.epoch 缓存失效）
        ConfigView 双模式：表单默认 / Monaco 兜底
        draft 改结构化对象，保存时规范化序列化
```

---

## 1. sidecar（server/sidecar/）

1.1 **新文件 `schemaDescribe.ts`**：把 `scripts/spike-jsdoc-schema.mts` 的三段逻辑产品化——
- `buildSchemaRegistry(schemaTable)`：ts-morph 解析本体 `framework/config/schema/*.ts`（锚定 `<GAME_ROOT>/framework/config/schema/`，与 driver 现有 createRequire 解析同源，`driver.ts:127-135`）→ 前导 JSDoc 提取 → 按属性名与 zod shape 双侧递归对齐（属性初始化为标识符时解析子 schema const 继续对齐）→ `z.registry()` 返回。
- 对齐告警落日志（组合 bullet 共享描述、文档块错位），不阻断启动。
- `schemaToJson(schema, registry)`：`z.toJSONSchema(schema, { metadata: registry, reused: "inline" })` 统一出口。

1.2 **`driver.ts`**：启动时在 SCHEMA_TABLE 装配完成后调用 `buildSchemaRegistry` 一次并缓存；`protocol.ts:260-267` 方法表新增：
- `getSchema(kind)` → `{ jsonSchema }`（对应 SCHEMA_TABLE 8 个 kind）
- `listRegistries` 返回扩展为每条目 `{ id, description, configSchema? }`（configSchema 同样走 toJSONSchema；本体 A3/A4 完成前字段缺省，前端降级）

1.3 后续扩展（M4）：SCHEMA_TABLE 之外被 `validateWhole` 消费的 schema（items/dialogues/quests/ecosystems/player/raid、`framework/map/evolution/schema.ts`）纳入 getSchema，kind 命名与文件路由对齐。

## 2. server（server/src/）

2.1 **新路由** `GET /api/games/:gameId/schemas`（`routes/configs.ts` 或独立 `schemas.ts`，挂载同 `games.ts:527-536`）→ 一次性返回 `{ [kind]: jsonSchema }`；服务端只透传 driver 结果，**校验逻辑零改动**（zod 终门、applyService 全不动）。

2.2 **`routes/registries.ts:17-25`**：透传扩展后的元数据字段。

2.3 **引用下拉数据缺口**：item kind / 对话 treeId / 任务 id / 地图 key 来自配置文件本身——新增轻量索引 `GET /api/games/:gameId/config-index`：configService 复用 tree/readFile 遍历活动工作区，抽取 `{ items: string[], dialogues: string[], quests: string[], mapKeys: string[], archetypes: string[] }`，带 mtime 缓存。后端校验不变。

## 3. web（web/src/）

3.1 **API 层 `api/admin.ts`**：`fetchSchemas()`（:299 风格同款）、registries 类型扩展 `description`/`configSchema`、`fetchConfigIndex()`。

3.2 **新 store `stores/schemas.ts`**：`load()` + 按 kind 取用；`games.epoch` 变更时 reset（对齐 `stores/config.ts:172-178` 的跨游戏防串模式）。

3.3 **config store draft 模型重构（最大单项）** `stores/config.ts`：
- `ConfigFile.content` 保持字符串传输不变（PUT 接口零改动）；
- store 内解析为对象 `draftObj`：表单绑定对象，**dirty = 规范化字符串对比**（`JSON.parse` 保序、新键追加尾部，天然最小 diff；禁止对已有键重排序）；
- 非 JSON 文件与 schemaKind 未知文件：维持纯字符串 + Monaco；
- `save()`/`validateCurrent()` 序列化后发送，接口形状不变。

3.4 **ConfigView 双模式** `views/ConfigView.vue`：
- 有 schemaKind 且 schema 已加载 → 表单模式默认；顶栏加「表单/源码」切换，Monaco 永远可达（表单无法表达处的出口）；
- 校验错误（422 zod issue path）映射到表单字段高亮，无 path 的整体错误回落到现有错误面板；
- 文件树、保存/校验/格式化、Ctrl+S 流程不变。

3.5 **表单渲染器（新组件目录 `components/configForm/`）**：
- `SchemaForm.vue`：JSON Schema 驱动递归渲染——string→input、number→InputNumber、boolean→switch、enum→select、array→可增删列表/表格、object→折叠分组、`oneOf`+literal 判别→kind 选择器 + 子表单（地图 pipeline/tiled）；
- `DescriptionHelp.vue`：description 渲染为字段 label 旁的 help tooltip（参数介绍的展示出口）；
- `RefSelect.vue`：引用型字段的下拉 widget，数据源 `/registries` + `/config-index`（archetype.behavior→actions、components 键→componentRegistry、配方 kind→items、dialogue treeId、quest victimKind 等，按 JSON pointer 配置映射）；
- `SystemsPanel.vue`：game.json 的 systems[] 专用编辑——来自 registries 的系统清单（含 description、已启用高亮）勾选添加/停用、每系统 config 子表单（configSchema 驱动，缺 schema 退源码）、提示「需配 rules/<同名>.json」（命名约定，无强绑定）；
- 定制 widget 注册表：crafting 配方表格、netSync fields、pipeline 步骤列表等按需补。

3.6 测试：config store 结构化模型单测（dirty/序列化/epoch reset）、SchemaForm 基础渲染快照、RefSelect 数据源单测；UI 走既有 openchamber 截图验收流。

## 4. 里程碑（与本体仓计划对齐）

| 里程碑 | 内容 | 前置 |
|---|---|---|
| P1 | sidecar getSchema + `/schemas` 路由 + schemas store（元数据管道通） | 本体 M1（注释规范） |
| P2 | draft 结构化重构 + SchemaForm + DescriptionHelp：game.json 与 5 个 rules 表单化 | P1 |
| P3 | RefSelect + `/config-index`：引用字段下拉 | P2（registries 元数据可后补） |
| P4 | SystemsPanel：框架添加/停用 + config 子表单 + src 自定义扩展展示 | 本体 M2（register 元数据 + register.ts 接通） |
| P5 | SCHEMA_TABLE 之外 kind 纳入 + components 表单化 + 定制 widget | 本体 M4 |

## 5. 参考

- 现状调研：ConfigView/monaco 接入 `web/src/views/ConfigView.vue:362-435`、`web/src/utils/monaco.ts:30-35`（`schemas:[]` 未配置）；draft 纯字符串模型 `web/src/stores/config.ts:39-105`；API `web/src/api/admin.ts:299-360`。
- sidecar 现状：`server/sidecar/driver.ts:127-135, 166-175, 207-219, 254-270`；协议 `server/sidecar/protocol.ts:260-267`。
- spike 产物与坑清单：`docs/spike-jsdoc-schema-report.md`（`.meta()` 克隆陷阱 → registry 方案；inline 无 $ref；对齐启发式）。
