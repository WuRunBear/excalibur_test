# DESIGN.md — 像素风设计系统契约

本项目 UI 改造的视觉契约。所有前端组件在实现前必须遵守本文件定义的 token、形状、字体与组件映射。

## 1. 设计方向

- **风格**：复古掌机 / GBA 浅色像素风（全浅色主题）。
- **组件库**：`@pixelium/web-vue@0.1.4`（Pixelium Design，本身就是像素风组件库）。
- **主题激活**：`<html class="light">`（已写入 `index.html`）。浅色是 pixelium 默认态，`class="light"` 用于覆盖系统深色模式偏好。
- **像素步进**：`--px-bit: 4px`（库默认值，勿改）。

## 2. 调色板（浅色，对齐 pixelium OKlab 浅色系）

| Token | Hex | 用途 |
|---|---|---|
| `--color-background` / `px-bg` | `#f5f5f5` | 页面背景 |
| `--color-background-soft` / `px-soft` | `#fafafa` | 次级背景 |
| `--color-surface` / `px-panel` | `#ffffff` | 面板/卡片背景 |
| `px-line` | `#e6e6e6` | 分隔线 |
| `px-border` | `#c8c8c8` | 常规描边 |
| `px-border-hover` | `#969696` | 悬停描边 |
| `px-muted` | `#646464` | 次要文字 |
| `px-text` | `#323232` | 主文字 |
| `px-primary` / `--color-primary` | `#00a891` | 主色 / 选中 |
| `px-primary-dark` | `#0b806e` | 主色深 / 按下态 |
| `px-danger` | `#fd6860` | HP / 危险 / 关闭 |
| `px-warning` | `#ff7d00` | 饥饿 / 警告 |
| `px-success` | `#00b42a` | 任务完成 / 确定 |
| `px-notice` | `#409eff` | 口渴 / 提示 / 选中态 |
| `px-sakura` | `#ff9ab2` | 强调（少用） |

Tailwind 工具类可直接写 `bg-px-panel`、`text-px-text`、`border-px-border`、`text-px-primary` 等（`@theme` 已映射）。

## 3. 字体

- **家族**：`Fusion Pixel Zh_hans`（已由 `@pixelium/web-vue/dist/font.css` 注册 @font-face，随包发布）。
- **全局应用**：`body` 已设 `font-family: var(--font-pixel)`（见 `base.css`）。
- **字号**：只用 12px / 14px / 16px（对齐 4px 网格，位图字体最锐利）。正文 14px，标题/标签 12px。
- **禁用**：Inter 栈、`font-weight` 加粗（位图字体无多字重，加粗会糊）。
- **文字对齐**：中文界面默认左对齐，标题可用 `letter-spacing` 拉开像素感（`1px` 步进）。

## 4. 形状与描边

- **圆角**：一律 `border-radius: 0`（方角）。禁止 `rounded-*`、`rounded-lg`。
- **面板描边**：2px 实线深色外框 + 右下 2px 深灰投影（经典像素浮雕），已封装为 `base.css` 的 `.px-panel` / `.px-panel__title`，自定义容器优先复用。
- **边框颜色**：外框用 `px-text`（#323232），投影用 `px-border-hover`（#969696）。
- **禁止**：`backdrop-blur`、毛玻璃、渐变圆角、`shadow-lg` 软阴影（像素风用硬投影/描边）。
- **按钮/状态反馈**：hover 换描边色（`border-px-border-hover`），active 用 2px 内凹（`box-shadow: inset 2px 2px 0 0`）。

## 5. 间距

- 4px 网格：间距只用 `4 / 8 / 12 / 16`（即 `p-1 / p-2 / p-3 / p-4`）。
- 面板内边距 `p-2`（8px），面板间距 `gap-1`（4px）或 `gap-2`（8px）。

## 6. 组件映射（pixelium 组件替换手写 Tailwind）

| 现状（手写 Tailwind） | 替换为 pixelium 组件 |
|---|---|
| 面板容器 `bg-black/60 backdrop-blur` | `.px-panel`（自定义容器）或 pixelium `Container`/`Card` 样式 |
| 热键槽 / 图标触发器 `<button>` + emoji | `Button`（`shape="rect"`，`variant="plain"`/`outline"`，`size="small"`，`icon` 插槽放 pixelium 图标） |
| 血条 / 需求条（手写 `<div>` 宽度百分比） | `Progress`（`variant="solid"`，`theme="danger"`/`warning"`/`notice"`，`percentage` 绑定） |
| 音量滑条 `<input type="range">` | `Slider`（`modelValue` 绑定） |
| 调试开关 `<button>` toggle | `Switch`（`modelValue` 绑定） |
| 设置弹窗手写 overlay | `Dialog`（`visible` 绑定）或保留 overlay 结构但改 `.px-panel` 风格 |
| 物品名 / 状态文字 | `Tag`（`variant="plain"`，`theme` 按语义） |
| 悬停提示 | `Tooltip` / `Popover` |
| 后台菜单/头像/下拉 | 已用 pixelium `Menu`/`Avatar`/`DropDown`，保持并统一浅色主题 |

## 7. 图标

- **一律使用 pixelium 像素图标**（`@pixelium/web-vue/icon-pa/es`，pixelarticons 库，486 个图标）。
- **禁止 emoji 作为 UI 图标**（UI 层硬编码 emoji 必须替换）。以下为实际存在的图标名映射：
  - ⚙️（设置）→ `IconSliders` / `IconSliders2`；🎒（背包）→ `IconShoppingBag` / `IconBriefcase` / `IconLuggage`
  - 🔨（制作）→ `IconPlus`（pixelarticons 无锤子图标，用"新增/制作"语义）或 `IconSectionPlus`
  - ✕（关闭）→ `IconClose` / `IconCloseBox`；折叠/展开 → `IconChevronUp` / `IconChevronDown` / `IconChevronRight`
  - 🌙 / ☀️（昼夜）→ `IconMoon` / `IconSun`；确定/选中 → `IconCheck`；刷新 → `IconReload` / `IconSync`
  - 🛡️（护甲）→ `IconShield`；💧（口渴/水滴）→ `IconDrop` / `IconDropHalf` / `IconDropFull`
- **可接受的既有债务**：`game/net/types.ts` 中数据驱动的 `ITEM_ICONS`（emoji）属于游戏内容数据（武器/工具/食物等在 pixelarticons 中无对应图标），本次不迁移；装备槽/需求条的 emoji 若找不到对应像素图标，可保留并视为内容数据。仅替换 UI 层（设置/关闭/折叠/背包/制作等）硬编码 emoji。
- 图标尺寸用 16px（`size="16"` 或 `text-base`），颜色 `currentColor` 继承文字色。图标组件只接受 `size` / `color` 两个 props。

## 8. 动效与可访问性

- **只用 GPU 合成属性**：`transform` / `opacity`，禁止动画 `width/height/left/top`。
- **动效必须服务交互**：hover/active/选中态、面板开合、加载态（pixelium 自带 `.px-animation__loading`）。禁止无意义装饰动画。
- **`prefers-reduced-motion: reduce` 时禁用非必要过渡**。
- **对比度**：正文 `px-text`（#323232）于 `px-panel`（#fff）满足 WCAG AA；`px-muted` 仅用于辅助文字。
- **可点击目标 ≥ 24×24px**（像素风下热键槽最小 `h-6 w-6` = 24px）。
- **焦点态**：键盘可操作控件保留 `focus-visible` 描边（`outline: 2px solid px-primary`）。

## 9. 文件职责

| 文件 | 职责 |
|---|---|
| `src/components/GameUI/Index.vue` | HUD 编排器：面板显隐 + 定位（absolute 布局），桥接 `bridge` 事件 |
| `src/components/GameUI/components/*.vue` | 各面板内部样式，只接收 props/发 emits，不自定绝对定位 |
| `src/layouts/MainLayout.vue` | 后台外壳（pixelium 布局组件，浅色像素风） |
| `src/views/IndexView.vue` | 后台首页内容 |
| `src/assets/base.css` | 全局字体/背景/`.px-panel` 工具类 |
| `src/assets/main.css` | Tailwind v4 `@theme` token 映射 |
