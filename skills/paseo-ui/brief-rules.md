# Builder 硬禁令紧凑胶囊（常驻注入层）

> 本胶囊是不可妥协禁令/契约压缩层（~9.3KB），常驻注入所有编码角色的 brief。
> 它只负责「不许做」与「必须做」；「为什么」与复杂场景模板在第三层 vendor 手册按需查阅。
> 上游切片锁定于 `~/.claude/skills/paseo-ui/vendor/`（LOCK.json 管理），冲突时以本 Skill「规则裁决链」为最高裁决。
> **裁决链内嵌**：业务真实需求 > 项目既有代码与 DESIGN.md > 本胶囊条款 > vendor 规范。与项目既有约定冲突时（如既有表格方案、既有 token 命名），以项目约定优先，并在交接报告中记录差异。
> **Surface Mode**：brief 首行必须声明 Surface Mode（`operate | persuade | read | experience`）；模式判错即缺陷；未标注模式的条款全模式适用。

## 表面模式（Surface Mode）

按**被改造的表面**判定唯一模式，不按整个产品（落地页 `persuade`、后台 `operate`、文档 `read`）。

- `operate`（工作台、后台、编辑器、设置、审批流）：高信噪比，零装饰动效，禁渐变/毛玻璃，禁改字距。全部紧缩条款生效。
- `persuade`（落地页、营销页、定价页）：允许**一次**英雄区编排式入场、display 负字距（≥ `-0.02em`，floor `-0.04em`）、同色系光晕、非对称 Bento、≥25% 视口留白。
- `read`（文档、博客、帮助中心、变更日志）：衬线/人文无衬线配对、`60–72ch` 行宽、行高 `1.65–1.75`、章节锚点节奏。
- `experience`（作品集、展厅、创意交互）：同 `persuade`，作品本身主导首屏；控件仍须可识别、可键盘操作。
- 任何模式不得放宽可访问性、语义结构或工程禁令；模式只影响审美下限。

## 单一真源与设计落盘（真源分层）

- **真源三层分工**：
  - L3 产品（`PRODUCT.md`）：用户、核心任务、为什么做。严禁写视觉规则。
  - L1/L0 设计（`DESIGN.md`）：方向、语义角色、深度策略、组件模式、禁令。严禁硬编码色值数值，只引用 token 名（写「`--muted` 用于次级文字」，不写 `#5c6064`）。
  - 数值：代码 token（`index.css`、`tailwind.config.js` 等）唯一定义具体数值。
- **落盘约定**：
  - `system.md` 即 `DESIGN.md`：严禁创建 `.interface-design/` 或 `.impeccable/` 等平行真源目录。
  - 组件与设计模式统一沉淀至 `DESIGN.md` 对应标准章节（`## Overview`、`## Colors`、`## Typography`、`## Layout`、`## Elevation & Depth`、`## Components`、`## Do's and Don'ts`）。
  - 写入权限：Full 档经人类确认后写入 `DESIGN.md`；Lite 档只写 `DESIGN.proposed.md`，由人类在合入时确认合并。

## 动效与交互时序（baseline-ui / to-spring / 60fps / accessible-animation / review-animations）

- 界面交互保持即时响应；动效仅限显式请求与触感反馈（`:active:scale-[0.96~0.98]`、2px 焦点环）。
- 交互反馈 ≤200ms；状态过渡超过 300ms 须有明确设计理由；高频操作（日均 ≥100 次、快捷键）零动效。
- 动画与过渡仅允许作用于合成器属性（`transform`, `opacity`）；严禁过渡布局属性（`width/height/top/left/margin/padding`）。
- 缓动参数使用系统标准 Easing 或物理 Spring；严禁自定义 `cubic-bezier`；严禁 `transition: all`（显式声明过渡属性）。
- 高度折叠使用 CSS Grid `grid-template-rows: 0fr -> 1fr` 或 `framer-motion` 的 `layoutId`。
- 动效必须配 `prefers-reduced-motion` 降级（移除或仅淡入）；循环动画离屏必须暂停。
- **英雄区例外**：`persuade` / `experience` 英雄区允许恰好一次编排式入场（staggered reveal），≤1 个主导时刻，仍须 reduced-motion 降级。

## 排版与数据（better-typography / semantic-html-first）

- 金额、数量、比率、计数器强制 `tabular-nums` 等宽对齐；金额一律右对齐。（全模式）
- 正文行宽设计目标 `65–75ch`（`read` 表面 `60–72ch`）；探针扣分线（非放宽许可）：`operate` ≤85ch、`persuade`/`read` ≤72ch、`experience` ≤76ch，超出即计 `measure_violation_count`。
- 标题排版使用 `text-wrap: balance`，正文使用 `text-wrap: pretty`；多行标题末行严禁留孤字。
- 标题与正文字号比率：`operate` / `read` ≥1.5，`persuade` / `experience` ≥2.2；低于门槛即计 `heading_scale_flat`。
- `operate` 模式禁止修改字距；`persuade` / `experience` 的 display 级特大字号允许负字距（≥ `-0.02em`，floor `-0.04em`）。
- 图标按钮必须具备 `aria-label`；操作按钮文案按具体功能命名，禁止「确定/提交」等含糊指称。

## 语义结构（semantic-html-first / baseline-ui）

- 交互动作用原生 `<button type="button">`，页面导航用 `<a href>`；严禁 `<div onClick>` 模拟按钮。
- 数据表格强制使用原生 `<table>`/`<thead>`/`<tbody>`/`<th scope="col|row">`；严禁 `div soup` 模拟。
- 模态弹窗使用项目现有 Dialog 原语或原生 `<dialog>`（具备 Focus-trap 与 Esc 退出）；折叠使用 `<details>`/`<summary>`。
- 复选框/单选框的 label 与控件必须共享单一命中区；A11y 依赖原生 HTML 语义，ARIA 只做增强。

## 表单与校验（web-interface-guidelines / interaction-contracts）

- 输入框显式声明 `autocomplete` 与语义 `name`；准确声明 `type` 与 `inputmode`。
- 保证用户输入自由：严禁阻止粘贴（`onPaste` + `preventDefault`）；`outline-none` 必须配有替代焦点环。
- `:focus-visible` 配备 2px 高辨识度语义焦点环；校验时序采用「失焦校验 + 输入即清错误」；错误提示就地展示于字段旁并自动聚焦首个错误。
- 保持提交按钮可用直到网络请求真正发出；请求期间呈现加载指示器；部署防重复提交状态机。
- 破坏性/不可逆操作必须使用 AlertDialog 进行二次确认。

## 色彩与材质（better-colors / interface-design）

- 组件色值一律绑定语义 token（`--color-*` 按功能角色命名）；严禁硬编码 hex/rgb/oklch 字面量。（全模式）
- 一个视图确立一个主操作填充色；同一色相 15° 内只承担一个状态含义；颜色永远不作为唯一样式语义载体（必须辅以图标或文字说明）。
- 状态徽章遵循「文字说明 + 语义底色 + 矢量微图标」三重辨识。
- `operate` 模式禁用全屏/多色渐变与纯装饰毛玻璃；`persuade` / `experience` 允许同色系、低饱和光晕与材质层次；彩虹渐变全模式禁止。

## 微质感与现代 CSS

- 同心圆角几何规律：`R_outer = R_inner + padding`；内外等圆角视为工艺缺陷。
- 深色模式采用 `1px` 微高光内边框（如 `ring-1 ring-white/10` 或 `oklch(1 0 0 / 0.08)`）塑造层次，替代生硬黑影。
- 光学对齐微调：几何非对称图标（播放、箭头）视觉重心微移 1–2px；胶囊按钮水平内边距大于垂直（如 `px-3.5 py-1.5`）；图标与文字 `gap-1.5/2` 居中对齐。
- 组件响应式优先采用 `@container`；同行卡片内部标题/正文/底栏通过 `subgrid` 严格对齐；流体排版使用 `clamp()`。
- 特性区优先采用非对称 Bento、主次分栏或单列叙事流；严禁三等分图标卡、居中 Hero + 等宽卡片行、以及 ≥3 层套娃嵌套卡片。

## 图表与数据可视化

- 图型严格匹配数据关系：时间趋势→折线图、离散对比→条形图、结构占比→饼图/环形图（超过 5 类强制转条形图）。
- 采用直接标注替代远距离图例；落实色盲安全双编码（形状/纹理 + 颜色）；数据标签强制 `tabular-nums`。
- 完整覆盖空态、加载态、异常错误态；坐标轴必须注明度量单位；暗色模式避免高对比度荧光刺激。

## 防位移与性能（core-web-vitals / react-best-practices / baseline-ui）

- 异步媒体（图片/视频/iframe）与动态容器必须预留 1:1 几何占位（`width/height` 或 `aspect-ratio`）；使用局部骨架屏替代全屏 Spinner，防止 CLS 抖动。
- 消除数据请求瀑布流（先并行触发、再分别 await）；轻量同步条件前置判断。
- 消除非必要重渲染：合理切分 Context 边界、确立稳定的 memo/callback 依赖引用。
- 视口高度使用 `h-dvh` 替代 `h-screen`；固定定位元素遵守 `env(safe-area-inset-*)`；交互触控目标移动端 ≥44px、桌面端 ≥24px。
- `useEffect` 严格限制于外部系统同步，严禁用于派生渲染状态。

## 破坏态自验（harden / break-ui）

- Full 档重构与数据交互快轨（密集表格 ⑧、表单 ⑨、骨架屏 ⑩、首次激活 ⑫）编码完成后必须编写 `./captures/mocks.json`，至少覆盖：
  - `stressed`：注入真实恶劣数据（超长真实实体名、多音节国际化字符、`¥999,999,999.00` 极值金额、特殊符号破折号）；
  - `empty`：0 条数据真实空态（含行动引导）；
  - `error`：接口 5xx 或网络异常，验证错误提示三要素与重试入口。
- 纯静态样式/文案快轨（①–⑥）若无接口交互，仅采集 `default` 态实测。严禁在生产数据或业务逻辑内硬编码假数据。
