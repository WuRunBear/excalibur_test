# 新协议（v2）对接修改方案：键值表 EntityState + 兴趣裁剪 + 完整玩法

> 目标文档：服务端对接协议（客户端接入指南）。服务端地址：`wss://3001.op.ms7d99.com`（`.env.local` 已配置，无需改动）。
> 本文件是**前端修改实施计划**：按阶段拆分，每个阶段可独立提交/验证，可在独立分支上逐步执行。

## 1. 背景

当前前端（`excalibur_test`）已有一版联机对接，但按**旧协议**实现：

- `EntityState` 是扁平字段（`id/x/y/hp/shape/radius/w/h`）。
- `RoomState` 只有 `tick/players/entities`。
- `InputPayload` 只有 `seq/moveX/moveY`。
- 没有命令通道（`command`）、没有玩法状态（背包/需求/任务/对话）。

新服务端协议（v2）完全不同：

- `EntityState` 改为 **SoA 键值表**（`values: map<string, number>` + `stringValues: map<string, string>`），key 形如 `"Transform.x"`、`"Inventory.3.kind"`。
- `RoomState` 新增 `hour/phase/mapId`（昼夜 + 场景）。
- `PlayerState` 新增 `visibleEntities`（**兴趣裁剪**，默认视野半径 300px）。
- 新增 `command` 消息通道（8 种命令：consume/drop/transfer/craft/equip/place/deconstruct/dialogue）。
- 输入增加 `interact/attack/talk` 三个边沿信号。

**Schema 是线协议的一部分**：客户端声明必须与服务端一致（字段名/类型/顺序），否则握手后解析错乱。因此 `src/game/net/schema.ts` 必须整体重写。

已做连通性验证（2026-08-06）：

- `GET https://3001.op.ms7d99.com/health` → `{"ok":true}`
- `GET https://3001.op.ms7d99.com/maps/runtime` → 正常返回，grid 64×64、tile 16×16

## 2. 协议差异对照（旧 → 新）

| 项目 | 旧（现状） | 新（目标） |
|------|-----------|-----------|
| EntityState | `id/x/y/hp/shape/radius/w/h` | `id` + `values` + `stringValues` |
| PlayerState | `sessionId/entityId` | 追加 `visibleEntities` |
| RoomState | `tick/players/entities` | 追加 `hour/phase/mapId` |
| InputPayload | `seq/moveX/moveY` | 追加 `interact/attack/talk` |
| 消息通道 | `input` | 追加 `command` |
| 实体来源 | `state.entities` 全量 | `visibleEntities`（开裁剪时）否则 `entities` |
| 实体辨识 | 服务端给 shape 字段 | 客户端按 §3.6 key 组合辨识种类 |
| 玩法状态 | 无 | 背包/需求/装备/任务/对话/建造 |

## 3. 对接目标

按协议文档 §6 对接清单完整落地，达到**完整玩法可玩**：

1. Schema 声明与 §3.4 严格一致。
2. `joinOrCreate("game")` 单房间常驻，断线重连复用实体（`entityId` 不变）。
3. 每帧 `input`（seq 递增、速度 ≤200px/s），E 采集 / 空格 攻击 / T 对话 边沿触发。
4. 渲染遍历自己的 `visibleEntities`（非空时），否则回退 `state.entities`。
5. 按 §3.6 辨识实体种类、按 §3.5 读字段。
6. UI 操作 → `command`（8 种命令全覆盖）。
7. 用 `/maps/runtime` 初始化地图与出生点，`mapId` 变化时重建地图。

### 3.1 键位（本次确认）

| 键 | 语义 | 协议映射 |
|----|------|---------|
| WASD | 移动 | `input` moveX/moveY |
| E | 采集（边沿） | `input.interact=true` |
| 空格 Space | 攻击（边沿） | `input.attack=true` |
| T | 对话（边沿） | `input.talk=true` |
| C | 打开合成面板 | UI 指令 → `command craft` |
| G | 丢弃选中槽 | `command drop` |
| B | 放置选中 kit（玩家朝向偏移 ~32px） | `command place` |
| X | 拆除最近建筑 | `command deconstruct` |
| 数字 1–6 / 点击 | 选中快捷槽 | 点击使用 → `command consume/equip` |

## 4. 非目标

- 不做客户端预测/回滚/本地碰撞。
- 不做服务端没有的状态（如 mp、金币，服务端不下发则 UI 隐藏或显示占位）。
- 不实现 UI 拖拽动画的精细交互（transfer 用"点击源槽→点击目标槽"的简化交互）。
- 不做贴图美术，实体表现继续用纯色 + 文本/emoji 临时视觉。

## 5. 核心数据流（保持不变，仅升级字段语义）

1. 用户按键 → 输入采集生成 `InputPayload`（50ms 节流）。
2. `connection.sendInput()` → 服务端。
3. 服务端写回 `RoomState`（增量补丁）。
4. `onStateChange` → 解析实体表（visibleEntities/entities 兼容）→ `EntityStore` 写快照。
5. `EntityStore.sample()` 插值 → `ActorManager` 落地 Actor。
6. UI 状态适配：按本地 `entityId` 提取玩家实体字段 → `GameUIState`（含背包/需求/任务/对话）。
7. UI 指令 → `onCommand` → `connection.sendCommand()`。

## 6. 文件级修改计划（按实施顺序）

> 建议每阶段一个 commit，按"A→B→C→D→E"顺序推进；A 阶段完成后即可验证"能进世界、能移动、实体可见"。

### 阶段 A：协议层（`src/game/net/`）

#### A1. 重写 `src/game/net/schema.ts`

**此文件是线协议，必须与文档 §3.4 完全一致（字段顺序即协议顺序）：**

```ts
import { Schema, type, MapSchema } from '@colyseus/schema'

export class EntityState extends Schema {
  @type('uint32') public id: number = 0
  @type({ map: 'number' }) public values = new MapSchema<number>()
  @type({ map: 'string' }) public stringValues = new MapSchema<string>()
}

export class PlayerState extends Schema {
  @type('string') public sessionId: string = ''
  @type('uint32') public entityId: number = 0
  @type({ map: EntityState }) public visibleEntities = new MapSchema<EntityState>()
}

export class RoomState extends Schema {
  @type('uint32') public tick: number = 0
  @type('float64') public hour: number = 8
  @type('uint8') public phase: number = 0
  @type('string') public mapId: string = ''
  @type({ map: PlayerState }) public players = new MapSchema<PlayerState>()
  @type({ map: EntityState }) public entities = new MapSchema<EntityState>()
}
```

注意：

- `values` 的 key 就是 §3.5 的字段 key（`"Transform.x"` 等），与字段顺序无关，动态读写。
- `MapSchema` 实现 Map 接口：`get/set/has/forEach/size` 可用。
- **删除旧版扁平字段**（x/y/hp/shape/radius/w/h 不再存在）。
- 文件头注释由 `@colyseus/schema` 自动生成——直接手工替换为上述定义，并保留生成说明即可（后续如引入 `schema:sync` 会重新生成，见 E3）。

#### A2. 扩展 `src/game/net/types.ts`

- `InputPayload` 增加可选字段：

```ts
export interface InputPayload {
  seq: number
  moveX: number
  moveY: number
  interact?: boolean
  attack?: boolean
  talk?: boolean
}
```

- 新增命令负载类型（与 §2.2 严格一致）：

```ts
export type CommandPayload =
  | { type: 'consume'; slot: number }
  | { type: 'drop'; slot: number }
  | { type: 'transfer'; slot: number; toSlot: number }
  | { type: 'craft'; recipe: string }
  | { type: 'equip'; slot: number }
  | { type: 'place'; slot: number; x: number; y: number }
  | { type: 'deconstruct'; target: number }
  | { type: 'dialogue'; option: number }
```

- 新增客户端目录常量（仅 UI 展示用，服务端才是权威）：
  - `ITEM_KINDS`（§4.1，16 种）+ 物品中文名/图标映射（food/tool 分类供 useItem 判定）。
  - `RECIPES`（§4.4，10 个配方：recipe id、消耗、产出、站点类型 0=手搓 1=火堆）。
  - 服务端关键数值常量：`SPEED_LIMIT=200`、`INTERACT_RADIUS=24`、`ATTACK_RADIUS=32`、`TALK_RADIUS=48`、`PLACE_DISTANCE=64`、`VIEW_RADIUS=300`。

#### A3. 扩展 `src/game/net/connection.ts`

- 新增 `sendCommand(payload: CommandPayload): void` → `room.send('command', payload)`。
- 其余（sendInput/碰撞调试/HTTP 拉取）保持不变。

**阶段 A 验收**：`pnpm type-check` 通过；`pnpm dev` 能连上服务端（Schema 一致 → 状态能解析，即使渲染还是旧逻辑会显示不出来，但不再握手失败）。

### 阶段 B：同步与辨识（`src/game/world/`、`src/game/actors/`）

#### B1. 重写 `src/game/world/entityStore.ts` 的实体解析

`EntitySnapshot` 扩展为玩法快照（渲染 + UI 双用）：

```ts
export type EntityKind =
  | 'player' | 'enemy' | 'npc' | 'resource' | 'item'
  | 'campfire' | 'portal' | 'building' | 'unknown'

export interface NeedsSlot { name: string; current: number; max: number }
export interface InventorySlot { kind: string; count: number }
export interface QuestEntry { questId: string; state: number; count: number }
export interface DialogueState { npcId: number; treeId: string; nodeId: string; options: string[] }

export interface EntitySnapshot {
  id: number
  kind: EntityKind
  x: number; y: number
  hp: number
  shape: 0 | 1
  radius: number; w: number; h: number
  needs: NeedsSlot[]
  inventory: InventorySlot[]          // 12 槽，空槽 kind=''
  itemKind?: string; itemCount?: number   // ItemMeta 地面物品
  resourceRemaining?: number
  equipment?: { weaponSlot: number; toolSlot: number; armorSlot: number }
  stationType?: number                // CraftingStation
  light?: { radius: number; fuelRemainingMs: number }
  portal?: { targetMap: string; x: number; y: number }
  placeable?: { footprintW: number; footprintH: number; canCollide: number }
  dialogueSource?: string             // NPC 的树 id
  quests?: QuestEntry[]
  dialogue?: DialogueState             // 仅对话中
}
```

解析规则（按 §3.5 的 key 清单读取）：

- 数值 key 用 `entity.values.get(key)`；字符串 key 用 `entity.stringValues.get(key)`。
- **key 消失 = undefined**：所有读取必须容忍 undefined（`?? 默认值`）。
- `Collider.shape`：0=圆形 1=矩形；`Collider.radius`。
- `Needs.{i}.name/current/max`：i 从 0 起，name ∈ hunger/thirst（§4.2：0=hunger 1=thirst）。
- `Inventory.{i}.kind/count`：固定 12 槽，**空槽 kind 是 `""` 占位**（key 存在 ≠ 有货）。
- `Quest.{i}.questId/state/count`：state 0未接/1进行/2可交/3完成。
- `Dialogue.{i}.option`：选项文本数组；对话结束整组 key 消失。
- `Equipment.weaponSlot/toolSlot/armorSlot`：背包槽索引，-1=空。

实体表来源（§3.2 兼容逻辑，`readEntities` 改为接收 `MapSchema<EntityState>`）：

```ts
const mine = state.players.get(sessionId)
const entityMap =
  mine && mine.visibleEntities.size > 0 ? mine.visibleEntities : state.entities
```

种类辨识（§3.6，顺序即优先级，首个命中即返回）：

```
ResourceNode.remaining !== undefined            → 'resource'
ItemMeta.kind !== undefined                     → 'item'
DialogueSource.treeId !== undefined             → 'npc'
CraftingStation.stationType + LightSource.*     → 'campfire'
Portal.targetMap !== undefined                  → 'portal'
Placeable.footprintW !== undefined              → 'building'
Health.current + 存在 Needs.*                   → 'player'
Health.current !== undefined                    → 'enemy'
否则                                              → 'unknown'
```

#### B2. `src/game/actors/entityActor.ts` + `src/game/world/actorManager.ts`

- `EntityActor` 增加 `kind` 与表现字段；按 kind 选择颜色/形状/标签：
  - player：青色圆 + 昵称/`你`；enemy：红色圆；npc：绿色圆 + 名字（后续可用 `DialogueSource.treeId` 区分）；resource：棕色圆；item：黄色小圆 + emoji 图标（按 kind 映射：🪵🪨🫐🍖…）；campfire：橙色方 + 🔥；portal：紫色方 + 门；building：灰色方。
- 用 Excalibur `Text`/emoji 作为临时图标（`actor.graphics.use(...)`）。
- `matchesRender` 判定加入 kind：kind/shape/尺寸任一变化才重建 Actor；**只变化 hp/数量等数值时不重建**（避免闪烁）。
- 本地玩家高亮逻辑保留（`localEntityId === id`）。

**阶段 B 验收**：进游戏后能看到各类实体按 §3.6 正确着色/标注；玩家、资源点、火堆、掉落物等种类正确。

### 阶段 C：主逻辑（`src/game/index.ts`）

- `readInputPayload()`：移动不变；新增边沿信号——用 `this.input.keyboard.wasPressed(Keys.E / Keys.Space / Keys.T)`，**只在按下那帧**置 `interact/attack/talk=true`（服务端边沿触发消费后清除）。
- `handleRoomStateChange()`：用阶段 B1 的表来源逻辑取实体；记录 `hour/phase/mapId`；`mapId` 变化时重新 `fetchMapRuntime()` 并重建地图层（`detachMapTileMap` + `attachMapTileMap`），同时清空调试碰撞体。
- `onCommand()` 新增玩法分支（UI 指令 → `sendCommand`）：

| UI 指令 | 映射 |
|---------|------|
| `useItem{slot}` | 背包 slot 物品为食物/水 → `consume`；为工具 → `equip`（客户端按 kind 分类，§4.1） |
| `dropItem{slot}` | `drop{slot}` |
| `transferItem{slot,toSlot}` | `transfer{slot,toSlot}` |
| `craftItem{recipe}` | `craft{recipe}` |
| `placeItem{slot}` | `place{slot, x:玩家x+朝向偏移, y:玩家y+朝向偏移}`（偏移 ~32px，服务端 64px 校验） |
| `deconstructItem{target}` | `deconstruct{target}`（热键 X：从快照中找最近 `building` 实体） |
| `dialogueSelect{option}` | `dialogue{option}` |

- `emitNetworkUiState()`：把需求/背包/任务/对话/昼夜从本地玩家快照写入 `GameUIState`（见 D1）。

**阶段 C 验收**：E 采集 → 资源点 remaining 减少、物品入包；空格攻击 → 敌人 hp 下降；T 对话 → 对话 key 出现；热键 C/G/B/X 能触发服务端命令（以状态变化为准）。

### 阶段 D：玩法 UI（`src/components/GameUI/`）

#### D1. 扩展 `src/game/type.ts`

```ts
export interface GameUIState {
  fps: number
  isPaused: boolean
  player: { x: number; y: number; facing: Facing }
  world: { hour: number; phase: number; mapId: string }
  stats: PlayerStats                      // hp 来自 Health.current
  needs: Array<{ name: string; current: number; max: number }>
  inventory: Array<{ kind: string; count: number }>   // 12 槽
  equipment: { weaponSlot: number; toolSlot: number; armorSlot: number }
  quests: Array<{ questId: string; state: number; count: number }>
  dialogue: DialogueState | null
  debug: GameDebugState
}
```

`GameCommand` 新增：

```ts
| { type: 'useItem'; slot: number }
| { type: 'dropItem'; slot: number }
| { type: 'transferItem'; slot: number; toSlot: number }
| { type: 'craftItem'; recipe: string }
| { type: 'placeItem'; slot: number }
| { type: 'deconstructItem'; target: number }
| { type: 'dialogueSelect'; option: number }
```

注意：`createInitialState()`（index.ts）与 `__tests__/bridge.spec.ts` 的 `createInitialState()` 需同步补齐新字段。

#### D2. 新增 InventoryPanel（背包 + 装备）

- 12 槽展示 `kind/count`（空槽灰显），物品中文名 + emoji 图标（与 B2 共用映射表）。
- 点击槽 = 使用（`useItem`，服务端自动决定 consume/equip）；右键或"丢弃"按钮 = `dropItem`。
- 简化转移：点击源槽再点击目标槽 = `transferItem`。
- 装备区显示三槽引用的背包槽索引（`Equipment.*`）。

#### D3. 新增 CraftPanel（合成，C 打开）

- 展示 `RECIPES` 清单：名称、消耗、产出、所需站点；火堆配方标注"需要在火堆旁"。
- 点击合成 = `craftItem{recipe}`。失败无回执 → 以状态变化为准（服务端零副作用）。

#### D4. 新增 DialoguePanel（对话）

- `GameUIState.dialogue` 非空时弹出：NPC 名（treeId）+ `nodeId` + 选项列表。
- 点击第 i 项 = `dialogueSelect{i}`；服务端推进节点或 `__end__` 结束（`dialogue` 变回 null，key 消失）。

#### D5. 改造 QuestPanel / PlayerStatusPanel / ActionBar

- QuestPanel：改绑 `quests[]`（显示 state=1 进行中 / state=2 可交的任务，进度 count）。
- PlayerStatusPanel：HP 绑 `stats.hp`；新增饥饿/口渴条（`needs`）；新增时间显示（`hour` 转 HH:MM）与昼夜标识（phase=1 夜晚 19–5 点，面板/背景变暗提示）；zone 可显示 `world.mapId`。
- ActionBar：改绑 `inventory` 前 6 槽；点击 = `useItem`；数字键 1–6 选中。
- 移除全部硬编码演示数据（hp=86/coins=128/齿轮任务等）。

**阶段 D 验收**：背包/需求/任务/对话/时间全部来自服务端状态；采集→合成→食用/装备闭环可见；对话选项可交互。

### 阶段 E：收尾与验证

- E1. `src/game/__tests__/bridge.spec.ts`：同步 `createInitialState()` 新字段，保持测试通过。
- E2. `scripts/sync-colyseus-schema.mjs`：改为容错——源文件（`../game/...`）不存在时跳过并打印警告，不中断 `pnpm schema:sync`。
- E3. 全量验证：`pnpm lint` + `pnpm type-check` + `pnpm test` + `pnpm build`。
- E4. 连服手测清单（见 §8）。

## 7. 验收标准

- [ ] Schema 与 §3.4 完全一致，握手成功、状态可解析。
- [ ] 移动/采集/攻击/对话四个输入通道正常（速度 ≤200、边沿信号只发一帧）。
- [ ] 实体按 §3.6 正确辨识并渲染（含 visibleEntities 兴趣裁剪与 entities 兼容路径）。
- [ ] 8 种 command 全部可触发，失败零副作用（无报错弹窗，以状态为准）。
- [ ] 背包 12 槽/需求/任务/装备/对话 UI 全部显示服务端真实状态，无硬编码。
- [ ] 昼夜 hour/phase 驱动 UI（时间 + 夜晚变暗）。
- [ ] 断线重连后 `entityId` 不变、背包/位置恢复（存档）。
- [ ] lint / type-check / test / build 全绿。

## 8. 连服手测清单

1. 进入世界：出生点正常、地图（blocked 网格）显示、`/maps/runtime` 拉取成功。
2. 移动：WASD 平滑移动，角色跟随（相机跟随本地实体）。
3. 采集：走近资源点按 E → remaining 下降 → 物品入包（观察 Inventory 计数）。
4. 合成：C 打开面板，craft wood_axe → 消耗 wood、产出入包；缺料时无变化。
5. 装备：useItem(axe 槽) → Equipment.weaponSlot 更新 → 攻击加成（服务端生效）。
6. 攻击：空格攻击 boar → hp 下降 → 击杀掉落 ItemMeta 实体 → 走近自动拾取。
7. 对话：T 与 NPC 对话 → DialoguePanel 选项 → 选择推进/结束。
8. 任务：对话接任务 → 进度（collect/kill）实时更新 → state=2 可交 → 提交得奖励。
9. 生存：不进食 → 需求下降 → 归零扣血；consume 食物恢复。
10. 建造：B 放置 campfire_kit → 建筑实体（Placeable/GridOccupancy）→ 火堆可合成 cooked_meat。
11. 拆除：X 拆最近自己放置的建筑。
12. 昼夜：观察 hour 推进、夜晚变暗。
13. 断线重连：刷新页面重进 → 位置/背包/任务恢复，`entityId` 不变。
14. 调试：设置里碰撞体开关/快照仍可用（消息名未变）。

## 9. 风险与注意事项

- **Schema 不一致 = 握手后解析错乱**：A1 必须一次性改对，禁止新旧混用；改错时现象为"连接成功但字段全空/乱码"。
- **`visibleEntities` 首帧后才出现**：首帧实体表可能为空，采用"非空优先"回退策略，不要用空表覆盖已有渲染。
- **key 会消失**：对话结束/需求槽缩短等场景 key 被删，读取必须容忍 undefined，UI 用 `null` 表示缺失。
- **命令失败无回执**：频率超限（20 条/秒）、缺料、满包、距离不够、无权拆除都是静默失败；UI 不要假定成功。
- **input 超速被拒会回退 seq**：客户端不要自行改 seq 逻辑，保持严格递增即可；被拒后重发。
- **不要本地预测位移**：以服务端 `Transform` 为准（现有插值缓存已符合）。
- **服务端重启丢最近存档窗口**（60s 周期内）：手测时重连后发现丢进度属正常，稍等存档周期再验证。
- **`useItem` 分类规则**：食物类（berry/raw_meat/cooked_meat/berry_pie/water）→ consume；工具类（axe/stone_axe/spear）→ equip；kit 类不响应 useItem（用 B 放置）。

## 10. 实施顺序总结

```
阶段 A（协议层）   → schema.ts + types.ts + connection.ts        [可单独验证：连上、能解析]
阶段 B（同步辨识） → entityStore.ts + entityActor.ts + actorManager.ts [可验证：实体正确渲染]
阶段 C（主逻辑）   → index.ts                                       [可验证：玩法闭环]
阶段 D（玩法 UI）  → type.ts + GameUI 面板（4 改 + 3 新）            [可验证：UI 真实状态]
阶段 E（收尾）     → 测试/脚本/全量检查 + 手测清单
```

---

## 11. 实施记录（2026-08-06，与计划的偏差及发现的服务端问题）

> 本节记录实际实施中与计划的差异、以及对部署服务端的实测结论，供后续排障。

### 11.1 Schema 已按协议文档 §3.4 落地并连服验证

- `values` 声明为 `@type({ map: 'number' })`（与 CLIENT-INTEGRATION.md §3.4 一致）。
- 实测（vitest 直连 `wss://3001.op.ms7d99.com`）：握手成功、`tick/hour/phase/mapId/players/entities` 全部正确解码；
  38 个世界实体按 §3.6 辨识全部正确（npc/resource/enemy/campfire/portal）。
- 中途怀疑 `values` 是 float32（字节流里出现 `0xca` 前缀）——经核实这是 colyseus `encode.number`
  的自适应编码（精度允许时用 float32，否则 float64），声明 `'number'` 即可，无需改动。

### 11.2 服务端 bug：visibleEntities 内容解码失败（colyseus #935/#936）

**现象**：`PlayerState.visibleEntities` 的 map key 能收到（数量随视野进出正确变化），
但每个条目的内容（id/values/stringValues）解码为空壳，客户端日志反复出现
`"refId" not found: xxx`。

**根因**（已溯源到 colyseus 官方仓库）：
- 部署服务端使用 `@view() @type({ map: EntityState }) visibleEntities`（per-client 过滤字段，
  见服务端 slice-7 `PlayerState.ts` + `GameRoom.ts` 的 `StateView` 接线）。
- 该机制在 `@colyseus/core` 0.17.43（2026-05-03 发布）存在已知缺陷：
  - colyseus/colyseus#935「getFullState produces incomplete snapshot for second filtered client」
  - 修复 PR colyseus/colyseus#936（2026-05-05 合并）「emit per-view ref introductions before encodeAll baseline」
  - 同族问题 #818「StateView not found refId when decorating Map's」
- **修复方式在服务端**：`@colyseus/core` 升级到 `>= 0.17.44` 并重部署即可；客户端无需改动。

**客户端对策（已实现）**：`EntityStore.readEntities` 采用"非空且可解码优先"回退——
`visibleEntities` 中至少一个条目能解出有效 `id` 时采信（兴趣裁剪路径），否则回退
`state.entities` 全量广播。服务端修复后同代码路径自动切回。

**当前影响**（服务端修复前）：
- 世界渲染正常（`state.entities` 可完整解码，含 NPC/资源/火堆/传送门/敌怪）。
- 本地玩家实体只存在于 `visibleEntities`（服务端设计如此），故玩家位置/背包/需求/任务/对话
  UI 在服务端修复前拿不到数据（UI 已全部绑定真实状态，显示占位而非硬编码）。
- `state.entities` 在兴趣裁剪开启时是启动时的陈旧快照（`applySnapshot` 走 interest 路径后
  不再写 `state.entities`），动态实体（玩家移动、资源消耗）需等服务端修复后经
  visibleEntities 呈现。

### 11.3 其余与计划的差异

| 计划条目 | 实施情况 |
|---------|---------|
| 阶段 B 键值表解析 | 按 §3.5 全部 key 实现（含 Needs/Inventory/Quest/Dialogue/Equipment/ItemMeta 等，实测未见的部分留兼容解析） |
| §3.6 辨识 | `player` 判定改为"存在 `Health.current` 键 + 存在 Needs"，避免 hp=0 误判为 unknown |
| 热键 C | 合成面板由 UI 按钮（🔨）开关；C 键给出提示消息（游戏域不直接操作 Vue 面板） |
| 热键 B/G/1–6 | B=放置选中槽、G=丢弃选中槽、1–6=选中快捷槽，已实现 |
| lint | 顺手格式化了 2 个既有文件（SettingsModal.vue / mapTileMap.ts），`pnpm lint` 全绿 |

### 11.4 连服手测状态（服务端修复前的预期）

- ✅ 进入世界：`/maps/runtime` 拉取成功、地图渲染、世界实体（静态）可见
- ✅ 昼夜：hour/phase 驱动时间显示与夜晚变暗
- ✅ 移动/采集/攻击/对话输入通道：协议就绪（服务端消费情况待修复后复测）
- ⏳ 玩家自身状态（背包/需求/任务/对话/位置）：**阻塞于 11.2 的服务端 bug**

