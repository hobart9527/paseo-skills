# Builder 硬禁令紧凑胶囊（常驻注入层）

> 本胶囊是不可妥协禁令/契约压缩层（~7KB），常驻注入所有编码角色的 brief。
> 它只负责「不许做」与「必须做」；「为什么」与复杂场景模板在第三层 vendor 手册按需查阅。
> 上游切片锁定于 `~/.claude/skills/paseo-ui/vendor/`（LOCK.json 管理），冲突时以本 Skill「规则裁决链」为最高裁决。
> **裁决链内嵌**：本胶囊条款位于「业务真实需求 > 项目既有代码与 DESIGN.md」之下、「impeccable 通用规范」之上；当胶囊条款与项目既有代码约定冲突时（如项目无 `index.css` token 体系、既有表格组件已定列宽方案），以项目既有约定优先，并在交接报告中记录差异。
> **Surface Mode**：brief 首行必须声明 Surface Mode（`operate | persuade | read | experience`）；模式判错即缺陷；未标注模式的条款全模式适用。

## 表面模式（Surface Mode）

按**被改造的表面**判定唯一模式，不按整个产品；一个产品可同时有多个模式（落地页 `persuade`、后台 `operate`、文档 `read`）。

- `operate`（工作台、后台、编辑器、设置、审批流）：高信噪比、零装饰动效、禁渐变/毛玻璃、禁改字距。全部紧缩条款生效。
- `persuade`（落地页、营销页、定价页）：允许**一次**英雄区编排式入场、display 负字距（≥ `-0.02em`，floor `-0.04em`）、同色系光晕、非对称 Bento、≥25% 视口留白。
- `read`（文档、博客、帮助中心、变更日志）：衬线/人文无衬线配对、`60–72ch` 行宽、行高 `1.65–1.75`、章节锚点节奏。
- `experience`（作品集、展厅、创意交互）：同 `persuade`，作品本身主导首屏；控件仍须可识别、可键盘操作。
- 任何模式不得放宽可访问性、语义结构或工程禁令；模式只影响审美下限。

## 动效（baseline-ui / to-spring / 60fps / accessible-animation / review-animations）

- 未明确请求绝不添加动效；触感反馈（`:active:scale-[0.96~0.98]`、focus 环）除外。
- 仅允许 `transform` / `opacity`；严禁过渡 `width/height/top/left/margin/padding`。
- 交互反馈 ≤200ms；>300ms 的过渡必须有设计理由；高频操作（日均 ≥100 次、快捷键）零动效。
- 严禁自定义 `cubic-bezier`（Spring 物理参数除外）；严禁 `transition: all`（显式列出属性）。
- 必须配 `prefers-reduced-motion` 降级；循环动画离屏必须暂停。
- 高度折叠用 CSS Grid `grid-template-rows: 0fr -> 1fr` 或 `framer-motion layoutId`。
- **唯一例外**：`persuade` / `experience` 英雄区允许恰好一次编排式入场（staggered reveal），仍须 `prefers-reduced-motion` 降级，仍禁布局属性过渡，≤1 个主导时刻。

## 排版与数据（better-typography / semantic-html-first）

- 金额、数量、比率、计数器强制 `tabular-nums`；金额一律右对齐。（全模式）
- `operate` 默认禁止修改 `tracking-*`；`persuade` / `experience` 的 display 级特大字号允许负字距（≥ `-0.02em`，floor `-0.04em`，写入 `DESIGN.md`）。
- 正文行宽设计目标 `65–75ch`（`read` 表面 `60–72ch`）；探针扣分线（非放宽许可）：`operate` ≤85ch、`persuade`/`read` ≤72ch、`experience` ≤76ch，超过即计 `measure_violation_count`；标题用 `text-balance`，正文用 `text-pretty`。
- 图标按钮必须有 `aria-label`；操作按钮文案按功能重写，禁止「确定/提交」类含糊文案。

## 语义结构（semantic-html-first / baseline-ui）

- 动作用 `<button type="button">`，导航用 `<a href>`；严禁 `<div onClick>` 模拟按钮。
- 数据表格必用原生 `<table>/<thead>/<tbody>/<th scope="col|row">`；严禁 div soup。
- 弹窗用项目 Dialog 原语或原生 `<dialog>`（Focus-trap + Esc 退出）；折叠用 `<details>/<summary>`。
- 复选/单选的 label 与控件共享单一命中区；A11y 语义靠原生元素，ARIA 只做增强。

## 表单（web-interface-guidelines / interaction-contracts）

- 输入框显式声明 `autocomplete` 与语义 `name`；正确 `type`/`inputmode`。
- 严禁阻止粘贴（`onPaste` + `preventDefault`）；`outline-none` 必须有替代焦点环。
- `:focus-visible` 2px 语义焦点环；错误就地显示在字段旁并聚焦首个错误。
- 提交按钮保持可用直到请求开始；请求中显示 spinner；防重复提交状态机。
- 破坏性操作必须用 AlertDialog 确认。

## 色彩（better-colors / interface-design）

- `operate` 禁全屏/多色渐变与纯装饰毛玻璃；`persuade` / `experience` 允许同色系、低饱和、服务叙事的光晕/材质层次；彩虹渐变与无意义发光全模式禁止。
- 组件内严禁硬编码色值（hex/rgb/oklch 字面量）；必须走语义 token（`--color-*` 按角色命名）。（全模式）
- 一个视图一个主色填充动作；同一色相 15° 内只承担一个含义；颜色永远不是唯一语义载体（配图标或文字）。
- 状态徽章遵循「文字 + 语义底色 + 矢量微图标」。

## 微质感与现代 CSS

- 同心圆角：`R_outer = R_inner + padding`；内外等圆角视为缺陷。
- 深色模式用 `1px` 微高光内边框（如 `ring-1 ring-white/10` 或 `oklch(1 0 0 / 0.08)`）替代生硬黑影。
- 光学对齐：箭头/播放图标视觉重心微移 1–2px；胶囊按钮左右内边距大于上下（如 `px-3.5 py-1.5`）；图标与文字 `gap-1.5/2` 居中。
- 组件自响应优先 `@container`；同行卡片内部标题/正文/底栏用 `subgrid` 对齐；流体字阶用 `clamp()`。
- 卡片内禁止再套带边框/阴影的卡片（≥3 层即缺陷）。

## 图表与数据可视化

- 图型匹配数据关系：趋势→折线、比较→条形、占比→饼图（>5 类改条形图）。
- 直接标注替代远距离图例；色盲安全双编码（不只靠颜色）；数据标签 `tabular-nums`。
- 空/加载/错误三态齐全；坐标轴有单位；暗色模式不得刺眼。

## 审美底线

- 拒绝三等分图标卡、居中 Hero + 等宽卡片行、卡片套卡片。
- 标题 `text-wrap: balance`，正文 `text-pretty`；多行标题不得留孤字。
- 标题与正文字号比：`operate` / `read` ≥1.5，`persuade` / `experience` ≥2.2。
- 正文行宽：设计目标 `65–75ch`；探针扣分线同上（`operate` ≤85ch、`persuade`/`read` ≤72ch、`experience` ≤76ch）。

## 防位移与性能（core-web-vitals / react-best-practices / baseline-ui）

- 异步图片/iframe/动态容器必须预留 1:1 几何占位（`width/height` 或 `aspect-ratio`）；骨架屏替代全屏 Spinner。
- 消除请求瀑布流（`async-` 系列）：先并行发起、再 await；便宜同步条件先判。
- 避免非必要重渲染（`rerender-` 系列）：Context 拆分、 memo 边界、稳定引用。
- 严禁 `h-screen`（用 `h-dvh`）；固定元素遵守 `safe-area-inset`；触控目标 ≥44px。
- `useEffect` 只做无法用渲染逻辑表达的事。

## 破坏态自验（harden / break-ui）

- 编码完成必须写 `./captures/mocks.json`：`stressed`（真实恶劣数据：超长实体名、`¥999,999,999.00`）、`empty`、`error`（5xx + 重试入口）。
- 杜绝无意义假数据（`AAAA...`）；每个 worst-case 必须是真实世界可能出现的数据。
