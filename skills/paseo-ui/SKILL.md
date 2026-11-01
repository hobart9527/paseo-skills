---
name: paseo-ui
description: 前端 UI/UX 工业级交付流水线：分 Lite 专项快轨（polish/color/typography/layout/motion/distill/clarify/table/form/skeleton/chart/onboard/audit）与 Full 0→1 六阶段重构；支持真实代码修改、极端数据破坏注入与 Playwright/CHI 机械门禁。触发词：/paseo-ui、界面优化、前端重构、UI走查。
user-invocable: true
argument-hint: "[polish · bolder · typography · color · layout · motion · distill · quieter · clarify · audit · table · form · skeleton · chart · onboard · full] [target]"
---

# Paseo UI Pipeline

前端与 UI/UX 工业级交付流水线。核心原则：**直接修改真实工程源码，不造静态玩具；每个能力槽严格挂载唯一最佳的外部成熟 Skill 切片；以极端数据破坏注入为编码门禁，真实多视口截图与 DOM 探针为收口凭据。**

---

## 规则裁决链（优先级写死）

$$
\text{业务真实需求} > \text{项目既有代码与 DESIGN.md} > \text{baseline-ui 工艺禁令} > \text{专项槽 Skill} > \text{impeccable 通用规范} > \text{ui-ux-pro-max 检索目录} > \text{模型随机偏好}
$$

### 表面模式分治（Surface Mode，首步必判）

同一套禁令不能同时服务营销页与管理后台。派发前先为本次表面判定唯一模式，写入 brief 与 `capture.mjs --surface-mode`；模式只影响审美下限，不改变可访问性、语义与工程禁令。

| 模式 | 判据（按**被改造的表面**，不按整个产品） | 美学释放 | 仍不可突破 |
| :--- | :--- | :--- | :--- |
| `operate` | 工作台、后台、编辑器、设置、审批流 | 维持全部现行紧缩：零装饰动效、禁渐变/毛玻璃、禁改 `tracking-*` | 全部通用工艺禁令 |
| `persuade` | 落地页、营销页、定价页、转化页 | Display 级负字距（≥ `-0.02em`，floor `-0.04em`）、英雄区**一次**编排式入场（staggered reveal）、同色系 OKLCH 微妙光晕、非对称 Bento、≥25% 视口留白 | 动效仍须 `prefers-reduced-motion` 降级且 ≤1 个主导时刻；禁布局属性过渡 |
| `read` | 文档、博客、帮助中心、变更日志 | 衬线/人文无衬线配对、`60–72ch` 行宽、章节锚点节奏、行高 `1.65–1.75` | 层级与对比度不降级 |
| `experience` | 作品集、展厅、创意交互 | 同 `persuade`，且允许作品本身占据首屏主导 | 控件仍须可识别、可键盘操作 |

- 一个产品可以有多个模式：工具的落地页是 `persuade`，其后台是 `operate`，其文档是 `read`。不得用产品类别替代表面判定。
- `capture.mjs` 按模式调整可读行宽与字阶门槛（探针硬上限：`operate` 85ch / 字阶比 ≥1.5；`persuade` 72ch / ≥2.2；`read` 72ch / ≥1.5；`experience` 76ch / ≥2.2）。设计目标仍以胶囊为准：正文 `65–75ch`，`read` `60–72ch`；硬上限是扣分线，不是放宽许可。
- 模式判定错误是本 Skill 的一类缺陷：把 `persuade` 判成 `operate` 会稳定产出「B2B 表单感」页面。

### 不可妥协的编排裁决条款

1. **动效总闸**：交互保持即时响应；触感反馈（`:active:scale-[0.96~0.98]`、2px 焦点环）除外；高频操作零动效；审批/流程后台严禁添加无意义的装饰性入场。唯一例外：`persuade` / `experience` 英雄区允许恰好一次编排入场。具体语法禁令以 `brief-rules.md` 为准。
2. **排版与数据基线**：数据、金额、比率、计数器强制 `tabular-nums` 等宽对齐，金额一律右对齐；正文行宽设计目标 `65–75ch`（`read` 表面 `60–72ch`）。
3. **原语与组件系统**：遵循「项目已有原语 > 参考复合组件规范手写 > 引入新依赖（需人类确认）」。严禁在未获人类授权的情况下运行 `npx shadcn add/init` 改写工程架构；表格与弹窗强制原生语义原语，严禁 `div soup` 模拟。
4. **无人值守执行规约**：外部 Skill 中「停下来向用户提问」的条款，在后台子 agent 中分两类处理——**方向性提问**（视觉方向、设计世界、是否替换既有风格）不得自行假设，按 Suggest 块作为产出交回主会话转人类确认；**执行细节提问**按合理假设推进并在交接报告中显式标明假设。走查与审计按 P0-P3 缺陷全量收录，不受「最多只报 3 条」限制。
5. **证据分级记录**：交接结论必须区分四级证据：源码静态规则核对、`capture.mjs` 多视口渲染截图、DOM 探针输出、`playwright-cli` 交互轨迹快照。环境工具缺失时标明「降级：未采集」，严禁静默假定合格。
6. **原语优先修复**：同一视觉缺陷在 ≥2 个调用点出现时，修共享原语或 token，不逐点打补丁；改动触及共享原语时自动按 L-2 档处理。

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
2. **保存映射**：组件与设计模式按标准章节沉淀至 `DESIGN.md`（`## Overview`、`## Colors`、`## Typography`、`## Layout`、`## Elevation & Depth`、`## Components`、`## Do's and Don'ts`），不新增平行文件。
3. **写入权限**：Full 档 Stage 1 经人类确认后，由 Builder 直接写入 `DESIGN.md`，随确认点冻结；Lite 档与返工阶段新沉淀的模式只写 `DESIGN.proposed.md`，由人类在下次确认时合并。子 agent 不得私自覆写 `DESIGN.md`。
4. **Suggest + Ask 交回**：后台子 agent 执行时，把 Suggest 块（Domain / Color world / Signature / Rejecting / Direction）作为产出写入交接报告并结束本回合，由主会话用 AskUserQuestion 转人类确认后再派 Builder 落地。Lite 档不做方向选择，跳过此步。

**impeccable 适配**：
- 启动器**优先使用随包二进制**（`~/.claude/skills/paseo-ui/vendor/impeccable/scripts/bin/<os>-<arch>/impeccable`），缺失时才联网下载。启动器不可用时直接读 `vendor/impeccable/reference/craft-floor.md`，报告标注「降级：impeccable 启动器未运行」。
- **产物路径收口**：严禁在项目根产生 `.impeccable.md` 或 `.impeccable/` 等平行真源。Surface Mode 并入 `DESIGN.md` 的 `## Overview`；comp 图片可保留在 `./captures/comps/`。
- **detect 证据统一落盘**：`impeccable detect --json` 由编排者统一执行并写入 `./captures/impeccable-detect.json`。
- **通道 B 只读契约**：评审角色以只读模式运行，**只读取当前 worktree 内声明的证据文件（`./captures/*`、`DESIGN.md` 与代码 diff）**；**严禁读取 worktree 外部路径（如 `~/.claude/skills/`）**，**严禁自行执行任何 CLI 命令**（所需静态扫描与 a11y 报告均由编排者统一预先落盘至 `./captures/`）。

**ui-ux-pro-max 适配**：
- `--design-system --persist` 产出的 `design-system/<slug>/MASTER.md` 是**派发期草稿**，不是项目真源：派发结束前必须把选定方向合入 `DESIGN.md`，并删除或移出 `design-system/`，严禁两套设计真源并存。
- 图表规范以本 Skill 能力槽与 `brief-rules.md` 为准，不另建图表专章。

**accessibility-scan 适配**：
- 扫描器命令为全局预装的 `accesslint-chrome ensure` 与 `accesslint scan`（**不使用 `npx -y` 运行时拉取**）。由编排者统一跑完并将 JSON 写入 `./captures/a11y.json`；评审角色只读该 JSON，不自行启动扫描器。扫描未运行或失败时记「降级：a11y 扫描未采集」。

---

## 三层渐进式装配（Layered Progressive Mounting）

所有外部能力切片锁定于 `~/.claude/skills/paseo-ui/vendor/`（由 `LOCK.json` 管理）。派发子 agent 严格执行三层装配，严禁全量盲目注入：

- **通道 A · 路径注入（编码角色）**：在 worktree 内以 bypassPermissions 运行的写码角色，brief 中给第二层切片的绝对路径指针并标注「实现前通读」。
- **通道 B · 全文内联（只读评审角色）**：带静音守则（只读 cwd 下文件、不联网）的角色读不到 worktree 外的 vendor 路径；编排者把评审切片**全文直接粘贴进 brief 正文**，证据材料（`./captures/*`、`DESIGN.md`）一律给当前 worktree 相对路径。

1. **第一层 · 硬禁令紧凑胶囊（常驻注入）**：
   - 文件：`~/.claude/skills/paseo-ui/brief-rules.md`（实测 ~9.3KB / ~2.3k tokens，含表面模式与设计真源映射）。
   - 内容：不可妥协的 Don'ts/Musts（表面模式、真源分工、动效、排版、语义结构、表单、色彩、微质感、防位移、破坏态自验）。
   - 每个编码角色（Builder / Lite 执行者 / Stage 5 返工）的 brief 必须原样附带全文。
2. **第二层 · 任务特征动态路由（按需切片）**：
   - 由 Stage 1 产出（或 Lite 参数映射）确定特征掩码，只把命中切片注入 brief（通道 A 绝对路径，通道 B 全文内联）。每个编码 brief 的第二层总量 **≤12KB**。
3. **第三层 · 上游手册按需查阅（不主动注入）**：
   - 上游切片保留为只读手册。brief 末尾附一句：「遇到胶囊未覆盖的边界场景，到 `~/.claude/skills/paseo-ui/vendor/` 对应切片精准查阅后再写码」。
4. **机械门禁兜底（不靠 Agent 自觉）**：
   - 最终判定一律以 `capture.mjs` 退出码 0（CHI ≥90、证据完整、探针已测）与 `accesslint` WCAG 报告为准，违规机械打回。

**注入预算限制**：

| 角色类 | 第一层 | 第二层 | 实测最差 | 预算上限 |
| :--- | :--- | :--- | :--- | :--- |
| 编码（Stage 2/5、Lite ①–⑫） | 胶囊全文（~9.3KB） | 命中切片，总量 ≤12KB | 复合界面 11.8KB | ≤22KB |
| 塑形 Stage 1 态 A | — | shape.md + interaction-contracts | 8.4KB | ≤12KB |
| 塑形 Stage 1 态 B/C | — | shape.md + interface-design + new-work | 41KB | ≤43KB |
| 只读评审（快轨⑦、Stage 4 两路） | — | ≤3 切片全文内联（通道 B） | Stage 4 路 B 21KB | ≤26KB |

---

## 证据采集工具：`capture.mjs`

```bash
node ~/.claude/skills/paseo-ui/capture.mjs <url> --out ./captures/<phase> \
  --viewports 390,1280 [--states default,stressed,empty,error] [--mock ./captures/mocks.json] \
  [--serve "npm run preview"] [--port auto] [--surface-mode operate|persuade|read|experience] [--self-test]
```

- **运行器与进程组治理**：
  - 优先 Playwright（DOM 探针完整）；系统 Chrome CLI 模式探针记为 `unmeasured`，**CLI 模式永远无法通过门禁**（`craft_gate.reason = probe_unmeasured`）。
  - `--serve "<cmd>"` 与 `--port auto`：自动分配空闲端口、以独立进程组拉起预览；退出时对整个进程组先 SIGTERM、1.5s 未退则 SIGKILL，彻底消除孤儿服务。占位符只替换 `{port}` / `$PORT` / `${PORT}`；固定端口 URL 会自动重写为实际分配端口。
  - `--self-test`：一键校验 Playwright、符号链接解析、随包二进制、状态机与门禁逻辑。
- **探针度量与 Craft Health Index (CHI: 0-100)**：
  - 由 `capture.mjs` 基于真实 DOM 计算得出，客观反映工艺水平，绝非 LLM 幻觉评分。
  - 度量项涵盖：`horizontal_overflow`（横向溢出）、`cls_score`（累计位移）、`small_touch_target_count`（移动端 <44px，桌面端 <24px）、`unlabeled_control_count`、`th_without_scope_count`、`numeric_cell_misaligned_count`、`low_contrast_count`（Canvas CSS Color 4 解析 + 祖先 alpha 合成）、`:active` 按压反馈覆盖率、以及四大审美探针（`measure_violation_count`、`heading_scale_flat`、`nested_card_count`、`orphan_heading_count`）。
- **Fail-Closed 机械门禁**：
  - 以下任一情况 `capture.mjs` 强制输出 CHI 0 分（Grade F）、`craft_gate.passed = false`、**以退出码 3 坚决阻断**：
    1. 页面脚本崩溃（`pageerror`）或动作执行失败；
    2. 截图数为 0（`no_screenshots`）；
    3. 存在捕获失败或未确认状态（`capture_incomplete` / `status !== "captured"`）；
    4. 探针未测（`probe_unmeasured`，含 CLI 回退）。
  - **`capture.mjs` 退出码 0 的充要条件是「证据完整 + 探针已测 + CHI ≥ 90」。**
- **破坏态注入与交互动作（Break-UI & Deep Actions）**：
  - `--mock` 支持按状态声明网络路由拦截与交互动作：
    ```json
    {
      "*":        [{ "url": "**/api/tasks*", "bodyFile": "fixtures/tasks.json" }],
      "stressed": [{ "url": "**/api/tasks*", "json": { "items": [{ "title": "超长真实实体名称...", "amount": 999999999.00 }] } }],
      "empty":    [{ "url": "**/api/tasks*", "json": { "items": [] } }],
      "error":    [{ "url": "**/api/tasks*", "status": 500, "json": { "message": "error" } }],
      "modal":    { "actions": [{ "click": "[data-modal-trigger]", "waitMs": 300 }] }
    }
    ```
  - 状态确认优先级：**状态路由 > 动作声明 > DOM state**。任一动作失败或路由未命中即判 `state_unconfirmed`，图不入 `captures`，门禁必失败。
- **产物**：`./captures/<phase>/*.png` + `capture-manifest.json`（运行时证据，不入版本控制）。

---

## 路由映射全景表（Master Router）

所有参数与专项快轨对应单一最佳切片。第二层切片绝对路径统一省略前缀 `~/.claude/skills/paseo-ui/vendor/`：

| 参数 / 快轨 | 适用典型场景与改码边界 | 第二层必读切片（通道 A 路径 / 通道 B 全文内联，≤12KB） | 第三层按需查阅手册 |
| :--- | :--- | :--- | :--- |
| `polish` / `bolder` (① 质感/层级) | 页面太素、层级过平、字阶混乱。<br>**改码**：微边框、分层 Depth、字阶梯度。不动业务逻辑。 | `impeccable/reference/bolder.md`<br>+ `impeccable/reference/polish.md` | `interface-design/SKILL.md`<br>`better-ui/SKILL.md` |
| `typography` (① 排版) | 字体行高不齐、数字未等宽。<br>**改码**：字阶角色、行高比例、`tabular-nums`。 | `better-typography/SKILL.md` | `ui-ux-pro-max/references/quick-reference.md` |
| `color` (② 色彩) | 对比度不足、深浅色不协调、硬编码色。<br>**改码**：单色单职，接入语义 token。不动布局与动效。 | `better-colors/SKILL.md` | `better-colors/` 辅助指南 |
| `layout` (③ 布局/响应式) | 间距节奏乱、移动端挤压或溢出。<br>**改码**：4/8pt 节奏、容器自适应、窄屏重排。不动色彩文案。 | `impeccable/reference/layout.md`<br>+ `impeccable/reference/adapt.md` | — |
| `motion` (④ 动效) | 过渡生硬、按钮缺触感反馈。<br>**改码**：`:active:scale-0.96`，高频零动画，反馈 ≤200ms。 | `to-spring-or-not-to-spring/SKILL.md`<br>+ `micro-interaction/SKILL.md` | `60fps-animation/SKILL.md`<br>`accessible-animation/SKILL.md` |
| `distill` / `quieter` (⑤ 降噪) | 视觉杂乱、信息过载、装饰过剩。<br>**改码**：6 维降噪，剔除无意义色块与纯装饰毛玻璃。 | `impeccable/reference/distill.md`<br>+ `impeccable/reference/quieter.md` | — |
| `clarify` (⑥ 微文案) | 报错不可读、按钮文案含糊。<br>**改码**：重写可见文案与 `aria-label`，不动 i18n key 与逻辑。 | `impeccable/reference/clarify.md` | `impeccable/reference/harden.md` |
| `audit` (⑦ 走查) | 上线前合规检查、Tab/焦点/溢出。<br>**只读**：主会话跑扫描与探针，执行者输出缺陷单，不改源码。 | `accessibility-scan/SKILL.md`<br>+ `impeccable/reference/audit.md`（**通道 B 全文内联**） | `accessibility-scan/shared/methodology.md` |
| `table` (⑧ 表格/树表) | 表格挤压、滚动表头丢失、数值未对齐。<br>**改码**：原生 `table` 原语、吸顶、`tabular-nums text-right`、窄屏卡片化。 | `semantic-html-first/SKILL.md`<br>+ `impeccable/reference/operate.md` | `better-typography/SKILL.md`<br>`ui-ux-pro-max/references/quick-reference.md` |
| `form` (⑨ 表单) | 报错突兀、缺少辅助说明、聚焦态丢失。<br>**改码**：五构件解剖、2px 焦点环、失焦校验、防重复提交。 | `web-interface-guidelines/command.md`<br>+ `interaction-contracts/SKILL.md` | `impeccable/reference/clarify.md`<br>`impeccable/reference/harden.md` |
| `skeleton` (⑩ 防跳动) | 数据加载时页面严重跳动。<br>**改码**：1:1 几何占位骨架屏替代全屏 Spinner，消除 CLS。 | `core-web-vitals/CLS.md`<br>+ `baseline-ui/SKILL.md` | `impeccable/reference/optimize.md` |
| `chart` / `dataviz` (⑪ 图表) | 图表配色乱、色盲不可辨、暗色刺眼。<br>**改码**：图型匹配、直接标注、色盲双编码、三态完备。 | `impeccable/reference/visualize.md`<br>+ `ui-ux-pro-max/references/quick-reference.md` | `better-colors/SKILL.md` |
| `onboard` / `empty` (⑫ 空态) | 首次进入无引导、空列表仅有暂无数据。<br>**改码**：行动引导 Empty State、渐进式披露、Undo 撤销。 | `impeccable/reference/onboard.md`<br>+ `impeccable/reference/clarify.md` | `interaction-contracts/SKILL.md` |
| `full` / 复杂重构 | 0→1 全新页面、≥3 个界面重构、组件库改造。 | 按 Full 档六阶段执行 | 见 Full 档流转 |

---

## 模式 A: Lite 档（专项快轨）

**核心原则**：局部明确的优化诉求，一条快轨一个执行者闭环，不走 A/B 方向选择、不走双路评审。

**Lite 执行分级（按影响面）**：

| 分级 | 判据 | 执行者 | 隔离环境 | 评审验收 |
| :--- | :--- | :--- | :--- | :--- |
| **L-0** | 改动 ≤2 个文件，不触共享原语与全局 token，且**主 checkout 累计写入文件数（含补丁与提案）≤3** | 主会话直接改 | 原地 | 自动门禁（package.json 脚本 + capture.mjs） |
| **L-1** | 多文件，或主 checkout 写入将超 3 个，但不触共享原语与全局 token | 设计营造师 Designer（`list_profiles` UI 角色） | worktree | 自动门禁（探针与 package.json 门禁兜底） |
| **L-2** | 触及共享原语（`components/ui/`）或全局 token（影响跨页面） | 设计营造师 Designer | worktree | 自动门禁 + 独立 Auditor 截图对比抽检一次（通道 B 全文内联） |

**审查独立性**：L-2 抽检必须由独立只读角色（`list_profiles` 异族审查角色）执行，严禁同一 profile 或同一实例自我审查。

**Lite 6 步执行流**：
1. **基线确认**：目标文件有未提交改动时，原地执行先将改动存为 `./captures/baseline.patch`；若写入文件数预计超 3 个，必须建 worktree（L-1）。
2. **表面模式判定**：按规则判定 `--surface-mode`，写入 brief 与采集参数。
3. **改前截图**：`capture.mjs --serve '<预览命令> {port}' --port auto --out ./captures/before`。
4. **组装 Brief 并执行**：
   - 编码 Brief 极简三段式：**Surface Mode 声明** + **第一层胶囊 `brief-rules.md` 全文** + **路由表第二层切片绝对路径**。
   - L-1/L-2 在 `create_workspace(isolation: "worktree", branchName: "ui/<track>-<target>")` 中执行。
5. **自动门禁闭环**：
   - `package.json` 构建与测试脚本退出码全为 0；
   - 跑改后截图 `--out ./captures/after`：**`capture.mjs` 退出码必须为 0（证据完整 + 探针已测 + CHI ≥90，且 CHI 不得低于 before）**。
6. **交付呈报**：输出 diff、before/after 截图对、探针对比与 `DESIGN.proposed.md`（如有），人类确认后合并。

---

## 模式 B: Full 档（标准工业级流水线）

- **触发场景**：全新功能页面（0→1）、大面积业务流程重构（≥3 个交互界面）、公共组件库改造。
- **与 paseo-pipeline 边界**：若同时含后端/接口改动，或拆出 ≥3 个有依赖的非 UI 任务，整体走 `paseo-pipeline`（OpenSpec change），本流水线作为其内部 UI 环节；纯前端 UI 需求独立运行本档。
- **编排纪律**：Stage 1 由主会话直接编排（方向确认需人类拍板）；Stage 2–5 由总控 Lead 或主会话无人值守调度。写入角色用 `bypassPermissions` 派发；只读评审角色保持 `auto-review`。

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
   - 态 A（已有 `DESIGN.md`）：直接读取继承。
   - 态 B（存量工程无规范）：从既有 token 与公共组件提取模式，起草 `DESIGN.md`。
   - 态 C（全新 0→1 页面）：调用 `python3 ~/.claude/skills/paseo-ui/vendor/ui-ux-pro-max/scripts/search.py "<domain-keyword>" --design-system` 生成 A/B 设计系统草案；同时以 `impeccable/reference/new-work.md` 确定 Aesthetic World。
2. **表面模式判定**：判定 `operate | persuade | read | experience`，理由写入 brief。
3. **派发 Builder 塑形**：
   - 注入：`shape.md`、`interface-design/SKILL.md` 与 `interaction-contracts/SKILL.md`；态 C 追加 `new-work.md`。
   - 产出：功能架构、核心动线、展示态矩阵、**Interaction Contract 矩阵**（中断/焦点/回滚/破坏确认）。
4. **★ 确认点 1**：方案与 Suggest 块呈人类拍板；确认后写入 `DESIGN.md` 与 `PRODUCT.md` 一起冻结。**Interaction Contract 矩阵随宪法冻结，作为 Stage 2 必读输入**。

### Stage 2: 独立工程编码与硬化（Build & Harden）
1. **隔离环境**：`create_workspace(isolation: "worktree", branchName: "ui/<feature>")`。
2. **改前截图**（存量页面）：编排者在 worktree 跑 `capture.mjs --serve ... --out ./captures/before`。
3. **派发 Builder 落地**：
   - Brief 组装：**Surface Mode 声明** + **Stage 1 冻结的 Interaction Contract 矩阵** + **第一层胶囊 `brief-rules.md` 全文** + **路由表第二层切片绝对路径（总量 ≤12KB）**。
   - 遵循语义复合原语与 `:active:scale-0.96` 触感；金额/数值强制 `tabular-nums text-right`。
4. **极端坏数据破坏自验（Break-UI）**：
   - Builder 参考 `vendor/break-ui/CATALOG.md` 编写 `./captures/mocks.json`，覆盖 `stressed`、`empty`、`error` 三大破坏态。
5. **本地构建与静态检测**：
   - 编排者统一执行 `~/.claude/skills/paseo-ui/vendor/impeccable/scripts/impeccable detect --json > ./captures/impeccable-detect.json`；
   - `package.json` 中 `test` / `build` / `lint` 脚本退出码全为 0。

### Stage 3: 截图与交互证据采集（Capture & Probe）
1. **一体化多视口采集**：
   ```bash
   node ~/.claude/skills/paseo-ui/capture.mjs --serve '<预览命令> {port}' --port auto \
     --out ./captures/after --viewports 390,1280 --surface-mode <mode> \
     --states default,stressed,empty,error,modal --mock ./captures/mocks.json
   ```
   **门禁要求**：所有状态 `confirmed: true`，`capture.mjs` 退出码必须为 0（证据完整 + 探针已测 + CHI ≥ 90）。退出码 3 直接打回返工。
2. **深层交互与弹窗抓取**：Dialog/Drawer 优先在 `--mock` 声明 `actions` 自动化触发；或用 `playwright-cli` 手动驱动截取。
3. **a11y 权威扫描**：编排者执行全局预装 `accesslint-chrome ensure` 与 `accesslint scan`，生成 `./captures/a11y.json`；收尾用 `accesslint-chrome stop -p <port>` 精确停杀。

### Stage 4: 双路并发客观反证（Concurrent Audit）
两路异族 Agent 并发审查：

- **读图探针（vision_canary）**：
  - 编排者在路 A brief 第一行注入视觉问答金丝雀（例如要求回报 1280 视口指定主操作 CTA 的可见文字与底色特征）。
  - 编排者直接核对；若回答含糊或不可读图，该路报告作废，**直接由主会话亲自读图完成视觉走查**，并在交接报告中记录替换事实。路 A 审查者只分发截图与规范说明，隔离源码访问以防作弊。
- **路 A（视觉多模态走查 - 看图）**：
  - 角色：设计营造师 Designer（`list_profiles` UI 角色）。
  - 注入：**通道 B 全文内联** `impeccable/reference/audit.md` 与 `critique.md` 要点。
  - 输入：`./captures/before` 与 `./captures/after` 截图、`capture-manifest.json`、`./captures/impeccable-detect.json`、`DESIGN.md`。
  - 职责：对照设计宪法提取客观缺陷，执行 UX 启发式走查（主操作可达性、信息负荷、空态引导），严禁主观打分。
- **路 B（工程/无障碍/动效代码审计 - 读码）**：
  - 角色：审计员 Auditor（`list_profiles` 异族只读审查角色）。
  - 注入：**通道 B 全文内联** `accessibility-scan/SKILL.md` + `react-best-practices/SKILL.md` + `review-animations/SKILL.md`（合计 ≤26KB 预算）。
  - 输入：`./captures/a11y.json`、`./captures/impeccable-detect.json`、`./captures/diff.patch`（由编排者预先生成，免自跑 git）。
  - 职责：检查 Focus-Trap、ARIA 属性、React 性能与 CSS 动效规范（合成器属性、减弱动效降级）。

### Stage 5: 定向返工收敛（Convergence ≤2 轮）
1. 归并两路阻断项（P0/P1）；同源缺陷合并为原语级修复。
2. 原 worktree 内唤起 Builder 定向修复。
3. 重跑构建门禁与 Stage 3 采集，确认 **`capture.mjs` 退出码归 0（证据门全绿）**；2 轮未关闭项原样呈报。
4. 规范缺陷反哺：仅产出 `DESIGN.proposed.md`，不私自覆写 `DESIGN.md`。

### Stage 6: 终审呈报与合入（Final Approval & Merge）
1. 确认收尾：清理遗留服务与扫描端口。
2. 呈报交付报告：before/after 截图对、CHI 指数与扣分明细、探针比对、canary 判定、双路审查结论、`git diff --stat`。
3. **★ 确认点 2**：人类确认后合入代码，清理 worktree 与 `./captures/`。
