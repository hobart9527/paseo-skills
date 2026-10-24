---
name: paseo-ui
description: AI-Native 前端与 UI/UX 工业级交付流水线：按阶段挂载单一最佳外部成熟 Skill 提示词（vendor 独立切片），分 Lite（单页/专项优化快轨）与 Full（0→1/重构/公共组件）双档；支持颜色/排版/布局/动效/微质感/微文案等专项精准打靶；覆盖 L3 认知、L1 视觉宪法、L0 复合原语、L2 时序动效与横切技术走查；以真实代码修改、极端数据注入、多视口实测与探针为收口凭据。触发词：/paseo-ui、UI设计、界面优化、页面重构、前端走查。
user-invocable: true
argument-hint: "[polish · bolder · typography · color · layout · motion · distill · quieter · clarify · audit · full] [target]"
---

# Paseo UI Pipeline

前端与 UI/UX 工业级交付流水线。核心原则：**直接修改真实工程源码，不造静态玩具；每个能力槽严格挂载唯一最佳的外部成熟 Skill 切片；以极端数据破坏注入为编码门禁，真实多视口截图与 DOM 探针为收口凭据。**

---

## 规则裁决链（优先级写死）

$$
\text{业务真实需求} > \text{项目既有代码与 DESIGN.md} > \text{baseline-ui 工艺禁令} > \text{专项槽 Skill} > \text{impeccable 通用规范} > \text{ui-ux-pro-max 检索目录} > \text{模型随机偏好}
$$

### 不可妥协的冲突裁决条款

1. **动效总闸**：以 `baseline-ui` 为最高门禁——「未明确请求绝不添加动效」。触感反馈（`:active:scale-[0.96~0.98]` 与 focus 焦点环）除外；高频操作（日均 ≥100 次、键盘快捷键操作）**零动效即时响应**；审批/流程后台严禁添加无意义的装饰性入场/循环动效。
2. **缓动与时长**：严禁引入自定义 `cubic-bezier` 曲线（Spring 物理参数除外）；触感反馈时长强制 ≤200ms；状态过渡动画超过 300ms 必须有明确设计理由，严禁任何 >300ms 的拖沓过渡。
3. **动效属性限制**：动画与过渡仅允许作用于合成器属性（`transform`, `opacity`），严禁过渡布局属性（`width`, `height`, `top`, `left`, `margin`, `padding`）；高度折叠使用 CSS Grid `grid-template-rows: 0fr -> 1fr` 或 `framer-motion` 的 `layoutId`。
4. **字体与排版**：默认禁止修改 `tracking-*`（letter-spacing）；display 级特大字号紧缩必须在 `DESIGN.md` 中有明确条款；数据、金额、比率、计数器强制使用 `tabular-nums` 等宽对齐，金额一律右对齐。
5. **视觉与色彩禁令**：操作型界面（Operate / Admin / Dashboard）默认禁用全屏渐变、多色渐变及纯装饰性毛玻璃；图标沿用项目现有图标库（新项目默认 `lucide-react`），同一界面不混用多套图标，严禁在生产界面直接混入 Text Emoji；状态徽章遵循「文字 + 语义底色 + 矢量微图标」三重防御。
6. **原语与组件系统**：遵循「项目已有原语 > 参考复合组件规范手写 > 引入新依赖（需人类确认）」。严禁在未获人类授权的情况下运行 `npx shadcn add/init` 改写工程架构；表格数据使用语义化表格结构（项目已有 Table 原语，或原生 `<table>/<thead>/<tbody>/<th scope>`），严禁 `div soup` 模拟；弹窗使用项目已有 Dialog 原语或原生 `<dialog>`，具备 Focus-trap 与 Esc 退出。
7. **无人值守执行规约**：外部 Skill 中「停下来向用户提问」的条款，在后台子 agent 中分两类处理——**方向性提问**（视觉方向、设计世界、是否替换既有风格）不得自行假设，按「Vendor 适配覆盖」把待选方案作为产出交回、结束本回合，由主会话转人类确认；**执行细节提问**按合理假设推进并在交接报告中显式标明假设。走查与审计按 P0-P3 缺陷全量收录，不受「最多只报 3 条」限制。
8. **证据分级记录**：交接结论必须区分四级证据：源码静态规则核对、`capture.mjs` 多视口渲染截图、DOM 探针输出（`horizontal_overflow`、按控件统计的 `active_feedback_coverage`、`small_touch_target_count`）、`playwright-cli` 交互轨迹快照。环境工具缺失时标明「降级：未采集」，严禁静默假定合格。
9. **原语优先修复**：同一视觉缺陷在 ≥2 个调用点出现时，修共享原语或 token，不逐点打补丁；改动因此触及共享原语时按 L-2 档处理（见 Lite 分级）。

### 单一设计宪法与 Vendor 适配覆盖

派发子 agent 时，brief 必须原样附带本节；本节优先于 vendor 原文中的同类条款。

**真源分层**（每层只有一个可写真源）：

| 层 | 文件 | 写什么 | 不写什么 |
| :--- | :--- | :--- | :--- |
| L3 产品 | `PRODUCT.md` | 用户、核心任务、为什么做 | 视觉规则 |
| L1/L0 设计 | `DESIGN.md` | 方向、语义角色、深度策略、组件模式、禁令 | 不复抄 token 数值，只引用 token 名（写「`--muted` 用于次级文字」，不写 `#5c6064`） |
| 数值 | 代码 token（如 `index.css`、`tailwind.config.js`） | token 具体取值 | — |

**interface-design 适配**：
1. **`system.md` 即 `DESIGN.md`**：原文凡读 `.interface-design/system.md` 处，改读项目 `DESIGN.md`；禁止创建 `.interface-design/` 目录。
2. **保存映射**：原文「After Completing a Task」要保存的内容，按下表写入 `DESIGN.md` 对应章节（google design.md 规范章节；项目已有自定义章节时并入语义最近的一节，不新增平行文件）：

   | system.md 内容 | DESIGN.md 章节 |
   | :--- | :--- |
   | Direction and feel、Signature、Domain | `## Overview` |
   | Color world、palette 角色 | `## Colors` |
   | Type scale ratio、hierarchy | `## Typography` |
   | Spacing base unit、density | `## Layout` |
   | Depth strategy（borders/shadows/layered） | `## Elevation & Depth` |
   | Key component patterns | `## Components` |
   | Rejecting 清单、反模式 | `## Do's and Don'ts` |

3. **写入权限**：Full 档 Stage 1 经人类确认后，由 Builder 直接写入 `DESIGN.md`，随确认点冻结；Lite 档与返工阶段新沉淀的模式只写 `DESIGN.proposed.md`，由人类在下次确认时合并。子 agent 不得私自覆写 `DESIGN.md`。
4. **Suggest + Ask 交回**：原文「Suggest + Ask」在主会话执行时直接向人类提问；在后台子 agent 执行时，把 Suggest 块（Domain / Color world / Signature / Rejecting / Direction，可附 specimen）作为产出写入交接报告并结束本回合，由主会话用 AskUserQuestion 转人类确认后再派 Builder 落地。Lite 档不做方向选择，跳过此步。

**impeccable 适配**：
- `<skill-base-dir>` 固定为 `~/.claude/skills/paseo-ui/vendor/impeccable`；原文 `.claude/skills/impeccable/scripts/impeccable` 一律解析为 `~/.claude/skills/paseo-ui/vendor/impeccable/scripts/impeccable`。
- 启动器首次运行会联网下载二进制；子 agent 环境不可联网时按原文「Launcher unavailable」分支直接读 `PRODUCT.md` / `DESIGN.md` 与 `reference/craft-floor.md`，并在报告标注「降级：impeccable 启动器未运行」。
- 原文 `document` 流程生成或刷新 `DESIGN.md`、或要求 AskUserQuestion 时，同样受上方写入权限与 Suggest 交回约束。

**accessibility-scan 适配**：
- 扫描器依赖 `npx -y @accesslint/...@latest`（联网 + 启动 Chrome），由主会话或可联网的执行角色先跑，JSON 结果落盘到 `./captures/a11y.json`；只读审计角色（如 Auditor）只读该 JSON 与源码研判，不自行安装或启动扫描器。
- 扫描未运行或失败时，在缺陷单写「降级：a11y 扫描未采集」，不得以源码走读结论冒充扫描结果。

---

## 能力槽与 Vendor 独立切片全景表

所有外部能力统一通过 `~/.claude/skills/paseo-ui/vendor/` 进行版本锁定（由 `LOCK.json` 与 `sync.sh` 管理），派发子 agent 时只注入目标 `.md` 绝对路径，杜绝上下文暴涨：

| 层级 | 能力槽位 | 选定最佳 Skill / 文件 | 绝对路径 (`~/.claude/skills/paseo-ui/vendor/...`) | 核心职责与标准 |
| :--- | :--- | :--- | :--- | :--- |
| **L3 认知** | 需求塑形 | impeccable `shape` | `impeccable/reference/shape.md` | 用户核心任务提炼、主任务通道降噪、产出结构化 design brief |
| **L3 认知** | B2B 宪法/方向 | Dammyjay93 `interface-design` | `interface-design/SKILL.md` | B2B 管理后台原生架构：字号比率三档、60/30/10 色彩权重、微质感深度 |
| **L3 认知** | 界面降噪 | impeccable `distill` / `quieter` | `impeccable/reference/distill.md`<br>+ `impeccable/reference/quieter.md` | 6 维信息降噪清单，剔除杂乱装饰与冗余视觉噪音 |
| **L3 认知** | 微文案 | impeccable `clarify` | `impeccable/reference/clarify.md` | 错误提示三要素（现状/根因/解法）、按功能重写动作按钮文案 |
| **L1 视觉** | 色彩系统 | jakubkrehel `better-colors` | `better-colors/SKILL.md` | 单色阶单职责、15° 同色异阶区分、Tailwind v3 语义映射（6 个辅助指南） |
| **L1 视觉** | 排版系统 | jakubkrehel `better-typography` | `better-typography/SKILL.md` | 角色行高比例、字阶梯度、151 项 Before/After 核对表、iOS 16px 防缩放 |
| **L1 视觉** | 布局节奏 | impeccable `layout` | `impeccable/reference/layout.md` | 4pt/8pt 节奏基数、Squint 模糊测试、容器自适应间距 |
| **L1 视觉** | 层级加强 | impeccable `bolder` | `impeccable/reference/bolder.md` | 视觉层级过平时放大主次对比（仍受条款 1–5 约束） |
| **L0 工艺** | 基础原语/底线 | ibelick `baseline-ui` | `baseline-ui/SKILL.md` | 极简工艺底线：Tailwind 缺省优先、安全区处理、禁止阻塞粘贴 |
| **L0 工艺** | 交互触感/图标 | jakubkrehel `better-ui` | `better-ui/SKILL.md`<br>+ `better-ui/icons.md`<br>+ `better-ui/icon-transitions.md` | `:active:scale-0.96` 微触感、图标尺寸与笔触统一、状态 cross-fade 过渡 |
| **L0 工艺** | 发布前打磨 | impeccable `polish` | `impeccable/reference/polish.md` | 功能性优先于视觉 polish，全动线走查与收尾对齐 |
| **L2 动效** | 动效决策树 | raphaelsalaja `to-spring` | `to-spring-or-not-to-spring/SKILL.md` | 动效必要性决策树：手势用 Spring、系统用 Easing、高频操作零动画 |
| **L2 动效** | 动效实现模版 | iart-ai `micro-interaction` | `micro-interaction/SKILL.md`<br>+ `micro-interaction/references/` | `framer-motion` 与纯 CSS `@starting-style` 状态切换、列表布局补间 |
| **L2 动效** | 减弱动效防御 | iart-ai `accessible-animation` | `accessible-animation/SKILL.md` | 三级降级策略（移除/淡入/保留）、0.01ms 安全网防 transitionend 断裂 |
| **L2 动效** | 动效审查门禁 | emilkowalski `review-animations` | `review-animations/SKILL.md` | 10 项不可妥协审查规则，拖沓动效直接判 Block |
| **横切** | 鲁棒硬化 | impeccable `harden` | `impeccable/reference/harden.md` | 超长字符折行、极值金额、0 数据空态、接口异常/并发状态机防御 |
| **横切** | 响应式适配 | impeccable `adapt` | `impeccable/reference/adapt.md` | 320/390/1280 视口布局重组，触控目标 ≥44px，表格转卡片模式 |
| **横切** | 视觉技术审计 | impeccable `audit` | `impeccable/reference/audit.md` | 5 维技术健康度走查，结合 `impeccable detect` 本地二进制静态扫描 |
| **横切** | 无障碍规则引擎 | AccessLint `accessibility-scan` | `accessibility-scan/SKILL.md` | 基于真实 DOM 与 selector 的 a11y 规则检测（Tab 焦点环、ARIA 标记） |
| **横切** | React 性能规则 | vercel `react-best-practices` | `react-best-practices/SKILL.md` | 70 条规则防瀑布流、防非必要重渲染、优化 Context 与 Bundle |
| **横切** | 深层交互捕获 | microsoft `playwright-cli` | `playwright-cli/SKILL.md`<br>+ `playwright-cli/references/request-mocking.md` | 驱动真实浏览器点开深层 Modal/Drawer/Dropdown，输出交互快照证据 |
| **扩展** | 图表与数据图形 | Claude `dataviz` | 系统内建 `dataviz` Skill | B2B 数据看板、KPI 卡片、趋势图与统计图表无障碍色板对齐 |
| **态 C** | 设计系统生成 | `ui-ux-pro-max` | `~/.claude/skills/ui-ux-pro-max/` | 0→1 重构时通过 `search.py --design-system` 提取 50+ 风格与 10-Role Token 表 |

---

## 证据采集工具：`capture.mjs`

```bash
node ~/.claude/skills/paseo-ui/capture.mjs <url> --out ./captures/<phase> \
  --viewports 390,1280 [--states default,stressed,empty,error] [--mock ./captures/mocks.json]
```

- **运行器**：优先本地或全局 Playwright（DOM 探针完整）；退回系统 Chrome CLI 时只有截图，探针记为 `unmeasured`，不得当作通过。
- **探针字段**：`horizontal_overflow`（横向溢出）、`active_feedback_coverage: {covered, total}`（可按压控件中挂有 `:active` 规则的数量；`has_active_feedback` 为 `covered > 0`，无可按压控件时为 `null`）、`small_touch_target_count`（<44px 控件数）、`has_tabular_nums`。
- **状态注入（Break-UI）**：`--mock` 指向 JSON，按状态名声明要拦截的接口；`"*"` 为所有状态共享的基础数据，状态路由优先级更高：

  ```json
  {
    "*":        [{ "url": "**/api/tasks*", "bodyFile": "fixtures/tasks.json" }],
    "stressed": [{ "url": "**/api/tasks*", "json": { "items": [{ "title": "AAAA…(50+ 无空格)", "amount": 999999999 }] } }],
    "empty":    [{ "url": "**/api/tasks*", "json": { "items": [] } }],
    "error":    [{ "url": "**/api/tasks*", "status": 500, "json": { "message": "upstream timeout" } }]
  }
  ```

  某状态的路由**全部被命中**才算进入该状态（`state_confirmations[*].observed = "mock:n/n routes hit"`）；有路由未命中即判 `state_unconfirmed`，说明页面没请求这份数据，截图不代表该状态。`--mock` 只在 Playwright 运行器可用，否则直接失败。
- **无 mock 的状态**：页面自身在 `body`/`html`/应用根上写 `data-state` 时可直接确认；两者都没有时，该状态判为未确认。`capture.mjs` 等待 `networkidle` 后才截图，抓不到 loading 态；loading 态用 `playwright-cli` 按 `references/request-mocking.md` 拦住接口后手动截取。
- **产物**：`./captures/<phase>/*.png` + `capture-manifest.json`。`captures/` 是运行时产物，不提交。

---

## 参数路由与双档分流

### 参数路由表

| 参数 | 去向 | 挂载切片 |
| :--- | :--- | :--- |
| `polish` | 快轨 ① 视觉质感 | `interface-design/SKILL.md` + `impeccable/reference/polish.md` + `better-ui/SKILL.md` |
| `bolder` | 快轨 ① 视觉质感 | `impeccable/reference/bolder.md` + `interface-design/SKILL.md` |
| `typography` | 快轨 ① 视觉质感 | `better-typography/SKILL.md` |
| `color` | 快轨 ② 色彩 | `better-colors/SKILL.md` |
| `layout` | 快轨 ③ 布局与响应式 | `impeccable/reference/layout.md` + `impeccable/reference/adapt.md` |
| `motion` | 快轨 ④ 动效 | `to-spring-or-not-to-spring/SKILL.md` + `micro-interaction/SKILL.md` + `accessible-animation/SKILL.md` |
| `distill` / `quieter` | 快轨 ⑤ 降噪 | `impeccable/reference/distill.md` + `impeccable/reference/quieter.md` |
| `clarify` | 快轨 ⑥ 微文案 | `impeccable/reference/clarify.md` |
| `audit` | 快轨 ⑦ 走查（只读） | `accessibility-scan/SKILL.md` + `impeccable/reference/audit.md` |
| `full` 或命中 Full 触发场景 | Full 档 | 见下文六阶段 |
| 无参数 | 主会话按需求描述归入上表；跨 ≥2 条快轨时按条款 9 与影响面选 Lite 分级，仍不跨档则顺序执行多条快轨 | — |

### 模式 A: Lite 档（专项快轨）

**核心原则**：局部明确的优化诉求，一条快轨一个执行者闭环，不走 A/B 方向选择、不走双路评审。

**快轨表**：

| 快轨 | 典型需求 | 边界纪律 |
| :--- | :--- | :--- |
| ① 视觉质感 | 页面太素、层级过平、字阶混乱 | **改码**：微边框、分层 Depth、字阶梯度、`tabular-nums`。不动业务逻辑与接口。 |
| ② 色彩与暗色 | 对比度不足、深浅色不协调、硬编码色值 | **改码**：单色阶单职责，消除 15° 脏色与硬编码色，接入语义 token。不动布局尺寸与动效。 |
| ③ 布局与响应式 | 间距节奏乱、移动端挤压/溢出 | **改码**：4/8pt 节奏、容器自适应、窄屏重排。不动视觉色彩与文案。 |
| ④ 时序与动效 | 过渡生硬、按钮缺触感反馈 | **改码**：落实 `:active:scale-0.96` 与退出动画；高频操作零动画，反馈 ≤200ms。 |
| ⑤ 降噪瘦身 | 视觉太杂、信息过载、装饰过剩 | **改码**：6 维降噪，剔除无意义色块、徽章与纯装饰毛玻璃。 |
| ⑥ 微文案 | 报错不可读、按钮文案含糊 | **改码**：只改用户可见文案与 `aria-label`，不改 i18n key 结构与业务逻辑。 |
| ⑦ 走查 | 上线前合规检查、Tab/焦点/溢出 | **只读**：主会话先跑 AccessLint 扫描与 `capture.mjs` 探针，执行者基于结果输出 P0–P3 缺陷单，不改源码。 |

**Lite 执行分级**（按影响面，不按快轨）：

| 分级 | 判据 | 执行者 | 隔离 | 评审 |
| :--- | :--- | :--- | :--- | :--- |
| **L-0** | 改动 ≤2 个文件，且不触共享原语（`components/ui/`）与全局 token 文件 | 主会话直接改 | 原地 | 自动门禁 |
| **L-1** | 多文件，但不触共享原语与全局 token | 设计营造师 Builder | worktree | 自动门禁（代替 Builder profile 默认的交叉评审） |
| **L-2** | 触及共享原语或全局 token（影响面跨页面） | 设计营造师 Builder | worktree | 自动门禁 + 设计师 Designer 前后截图抽检一次 |

走查快轨 ⑦ 的执行者：看截图选设计师 Designer，看代码与 a11y JSON 选审计员 Auditor；L-2 的 Designer 抽检同样只读。

**Lite 执行流**：
1. **基线**：确认目标文件的 `git status`。若目标文件有未提交改动，L-1/L-2 不建 worktree（会丢失这些改动），先问人类是先提交还是改为原地执行；原地执行时先把 `git diff -- <目标文件>` 存为 `./captures/baseline.patch`，交付时只报告相对基线的增量。
2. **改前截图**：启动预览后跑 `capture.mjs … --out ./captures/before`（视口与状态参数记下，改后复用同一组）。
3. **派发或直改**：brief 限定目标文件、快轨切片绝对路径、本 Skill「单一设计宪法与 Vendor 适配覆盖」节；L-1/L-2 在 `create_workspace(isolation: "worktree", branchName: "ui/<track>-<target>")` 中执行。
4. **自动门禁**：从项目 `package.json` 读取实际脚本（如 `build`、`test`、`lint`），全部退出码为 0；改后跑 `capture.mjs … --out ./captures/after`，`horizontal_overflow` 不得新增、`small_touch_target_count` 不得上升。
5. **呈报**：`git diff --stat`、before/after 截图对、探针前后对比、伴随的 `DESIGN.proposed.md`（如有），由人类确认后合入；worktree 合入后清理。

### 模式 B: Full 档（标准工业级流水线）

- **触发场景**：全新功能页面（0→1）、大面积业务流程重构（≥3 个交互界面）、公共组件库改造。
- **与 paseo-pipeline 的边界**：需求同时含后端/接口改动，或拆出 ≥3 个有依赖的非 UI 任务时，整体走 `paseo-pipeline`（OpenSpec change）。此时本档六阶段作为该 change 中 UI 任务的内部流程：Stage 1 的产出并入 pipeline 确认点 1（`PRODUCT.md`、`DESIGN.md` 随 spec 冻结），Stage 6 合入 `integration/<change>` 分支，主干合入归 pipeline 确认点 2；此时不调用 `openspec` CLI。纯 UI 需求则独立运行本档。
- **编排者**：Stage 1 由主会话直接编排（方向确认需人类在场）；Stage 2–5 预计派发 ≥4 次，按全局约定交总控 Lead 无人值守执行，主会话只守 Stage 1 与 Stage 6 两个确认点。

---

## Full 档全流程流水线（六阶段闭环）

```text
[Stage 1: 意图与宪法] ──> ★确认点 1（方向 + 宪法冻结）
          │
          ▼
[Stage 2: 编码与硬化 (worktree)] ──> [Stage 3: 截图与探针] ──> [Stage 4: 双路并发反证]
                                                                        │
          ┌─────────────────────────────────────────────────────────────┘
          ▼
[Stage 5: 定向返工收敛 ≤2 轮] ──> [Stage 6: 终审呈报] ──> ★确认点 2（合入） ──> 清理归档
```

### Stage 1: 意图塑形与设计宪法（Grounding & Constitution）
1. **现状扫描**：
   - 读 `PRODUCT.md`；缺失时，Stage 1 由 `shape.md` 产出的 design brief 一并呈人类确认，确认后写入 `PRODUCT.md`（L3 层，只写用户与任务）。
   - 态 A（已有 `DESIGN.md`）：直接读取，继承既有方向。
   - 态 B（存量工程无规范）：从代码 token 文件与公共组件中提取既有模式，起草 `DESIGN.md`（只写语义角色，不抄数值）。
   - 态 C（全新 0→1 页面）：调用 `ui-ux-pro-max` 的 `search.py` 生成 A/B 两种不同密度（`--density`）与版式（`--variance`）的设计系统草案。
2. **派发 Builder 塑形**：
   - 角色：`设计营造师 Builder`（`agent_profile_shejishi_builder`）。
   - 注入上下文：`vendor/impeccable/reference/shape.md` 与 `vendor/interface-design/SKILL.md`。
   - 产出：功能架构、核心动线、界面展示态矩阵（Idle/Loading/Empty/Error/Stressed）；业务状态机以既有 spec 为准，不自造。**仅态 C 产出 A/B 两套方向对比**；态 A/B 只产出一套与既有方向一致的方案，若认为需要改方向，写成 Suggest 块交回。
3. **★ 确认点 1**：Builder 交回的方案（含 interface-design Suggest 块）由主会话转人类拍板；确认后按「单一设计宪法」保存映射写入 `DESIGN.md`，与 `PRODUCT.md` 一起冻结。

### Stage 2: 独立工程编码与硬化（Build & Harden）
1. **隔离环境**：`create_workspace(isolation: "worktree", branchName: "ui/<feature>")`。主干目标文件有未提交改动时，先按 Lite 执行流第 1 步处理。
2. **改前截图**：在 worktree 起预览，跑 `capture.mjs … --out ./captures/before`（存量页面适用；0→1 页面跳过）。
3. **派发 Builder 落地**：
   - 注入上下文：
     - 工艺基线：`vendor/baseline-ui/SKILL.md`
     - 界面规范：`vendor/better-colors/SKILL.md` + `vendor/better-typography/SKILL.md` + `vendor/impeccable/reference/layout.md`
     - 复合原语：`vendor/better-ui/SKILL.md` + `vendor/better-ui/icons.md`
     - 动效规则：`vendor/to-spring-or-not-to-spring/SKILL.md` + `vendor/micro-interaction/SKILL.md`
     - 硬化：`vendor/impeccable/reference/harden.md`
   - 修改真实工程源码，遵循语义化复合原语与 `:active:scale-0.96` 触感；同一缺陷多点出现时按条款 9 修原语。
4. **极端坏数据破坏自验（Break-UI）**：Builder 编写 `./captures/mocks.json`（格式见「证据采集工具」），至少覆盖：
   - `stressed`：50+ 字符无空格字符串、`¥999,999,999.00` 极值金额；
   - `empty`：0 条数据；
   - `error`：接口 5xx 或网络中断，验证错误条与重试入口。
   只改输入、网络 mock 与视口，不碰生产数据与业务代码路径。
5. **持久回归（可选）**：项目已安装 `@playwright/test` 时，为关键页及上述 mock 态补 `toHaveScreenshot()` 用例；未安装则在报告中列为建议，不自行新增依赖。
6. **本地构建与静态检测**：
   - `impeccable detect --json` 静态扫描（启动器不可用时标「降级：未采集」）；
   - 项目 `package.json` 中的 `test` / `build` / `lint` 脚本，退出码必须为 0。

### Stage 3: 截图与交互证据采集（Capture & Probe）
1. 启动本地预览或开发服务（如 `npm run preview -- --port <port>`）；先查端口占用，不复用他人服务。
2. 多视口 × 多状态截图与探针：
   ```bash
   node ~/.claude/skills/paseo-ui/capture.mjs http://localhost:<port> --out ./captures/after \
     --viewports 390,1280 --states default,stressed,empty,error --mock ./captures/mocks.json
   ```
   所有状态须 `confirmed: true`；未确认的状态如实记为缺口，不得以 default 截图顶替。
3. **深层弹窗抓取**：页面含 Dialog/Drawer/Modal 时，用 `vendor/playwright-cli/` 点击打开并截图存入 `./captures/after/`；`playwright-cli` 不可用时标「降级：未采集」。
4. **a11y 扫描**：主会话按「accessibility-scan 适配」运行扫描器，产出 `./captures/a11y.json`。

### Stage 4: 双路并发客观反证（Concurrent Audit）
两路异族 Agent 并发审查：

- **读图探针（前置）**：派 Designer 前，先给它一张已知截图，让它说出页面主按钮的文案；答错或含糊即判定本轮不可读图，路 A 改用 claude 家族 profile，并在报告中记录探针结果。
- **路 A（视觉多模态走查）**：
  - 角色：`设计师 Designer`（`agent_profile_jiangzuo`，按读图探针结果决定是否替换）。
  - 注入上下文：`vendor/impeccable/reference/audit.md` + `vendor/review-animations/SKILL.md`。
  - 输入：`./captures/before` 与 `./captures/after` 下的截图、`capture-manifest.json` 探针、`DESIGN.md`。
  - 职责：对照设计宪法与动效基线，提取客观缺陷（Contract 违背条款 + Runtime 视口/状态复现 + Correction 唯一建议），严禁输出主观打分。
- **路 B（工程/无障碍/代码审计）**：
  - 角色：`审计员 Auditor`（`agent_profile_anchasi`，Codex 异族模型）。
  - 注入上下文：`vendor/accessibility-scan/SKILL.md` + `vendor/react-best-practices/SKILL.md`。
  - 输入：`./captures/a11y.json`、原始 `git diff`（比较基点为 worktree 分支与其基线分支的 merge-base）。
  - 职责：检查键盘 Focus-Trap、ARIA 属性、Tab 遍历、React 重渲染漏洞，核对改动路径不越出任务边界。

### Stage 5: 定向返工收敛（Convergence ≤2 轮）
1. 归并两路审查发现的阻断项（P0/P1）；同源缺陷按条款 9 合并为原语级修复。
2. 在原 worktree 唤起 Builder 定向修复。
3. 重跑 Stage 2 第 6 步门禁与 Stage 3 截图，确认缺陷关闭；2 轮后仍未关闭的阻断项原样上报，不再返工。
4. **设计契约反哺**：修复中发现视觉规范缺陷（如某色板在深色模式对比度不足），只产出 `DESIGN.proposed.md`，不覆写 `DESIGN.md`。

### Stage 6: 终审呈报与合入（Final Approval & Merge）
1. 关闭本 Skill 启动的预览服务。
2. 向人类呈报交付报告：
   - before/after 多视口、多状态截图；
   - 探针结果（溢出、按压反馈覆盖率、触控目标）及未确认状态清单；
   - 读图探针结果、双路审查结论与未关闭项；
   - `git diff --stat` 与核心代码变更摘要；
   - 伴随的 `DESIGN.proposed.md`（如有）。
3. **★ 确认点 2**：人类确认后执行 fast-forward / squash 合入（独立运行合入主干；pipeline 内运行合入 `integration/<change>`），清理临时分支、worktree 与 `./captures/`。
