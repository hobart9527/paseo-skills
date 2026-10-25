---
name: paseo-ui
description: AI-Native 前端与 UI/UX 工业级交付流水线：按阶段挂载单一最佳外部成熟 Skill 提示词（vendor 独立切片），分 Lite（单页/专项优化快轨）与 Full（0→1/重构/公共组件）双档；支持颜色/排版/布局/动效/微质感/微文案等专项精准打靶；覆盖 L3 认知、L1 视觉宪法、L0 复合原语、L2 时序动效与横切技术走查；以真实代码修改、极端数据注入、多视口实测与探针为收口凭据。触发词：/paseo-ui、UI设计、界面优化、页面重构、前端走查。
user-invocable: true
argument-hint: "[polish · bolder · typography · color · layout · motion · distill · quieter · clarify · audit · table · form · skeleton · full] [target]"
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
- 启动器首次运行会联网下载二进制；子 agent 环境不可联网时按原文「Launcher unavailable」分支直接读 `PRODUCT.md` / `DESIGN.md` 与 `~/.claude/skills/paseo-ui/vendor/impeccable/reference/craft-floor.md`，并在报告标注「降级：impeccable 启动器未运行」。
- 原文 `document` 流程生成或刷新 `DESIGN.md`、或要求 AskUserQuestion 时，同样受上方写入权限与 Suggest 交回约束。

**accessibility-scan 适配**：
- 扫描器命令为全局预装的 `accesslint-chrome ensure` 与 `accesslint scan`（版本由宿主统一管理，**不使用 `npx -y` 运行时拉取**）。由编排者（主会话或 Lead）先跑，JSON 结果落盘到 `./captures/a11y.json`；只读审计角色（如 Auditor）只读该 JSON 与源码研判，不自行安装或启动扫描器。
- 扫描未运行或失败时，在缺陷单写「降级：a11y 扫描未采集」，不得以源码走读结论冒充扫描结果。

---

## 能力槽与 Vendor 独立切片全景表

所有外部能力统一通过 `~/.claude/skills/paseo-ui/vendor/` 进行版本锁定（由 `LOCK.json` 与 `sync.sh` 管理）。**严禁将下列切片全量注入子 agent 上下文（17 个切片实测合计 137KB / ~35k tokens，触发 Lost-in-the-Middle）**；装配一律走下方「三层渐进式装配」，全量 vendor 原文只作为第三层只读手册：

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
| **L2 动效** | 动效性能 | iart-ai `60fps-animation` | `60fps-animation/SKILL.md` | 合成器属性动画、布局抖动排查、将 width/height/top/left 动画改写为 transform |
| **L2 动效** | 减弱动效防御 | iart-ai `accessible-animation` | `accessible-animation/SKILL.md` | 三级降级策略（移除/淡入/保留）、0.01ms 安全网防 transitionend 断裂 |
| **L2 动效** | 动效审查门禁 | emilkowalski `review-animations` | `review-animations/SKILL.md` | 10 项不可妥协审查规则，拖沓动效直接判 Block |
| **横切** | 鲁棒硬化 | impeccable `harden` | `impeccable/reference/harden.md` | 超长字符折行、极值金额、0 数据空态、接口异常/并发状态机防御 |
| **横切** | 响应式适配 | impeccable `adapt` | `impeccable/reference/adapt.md` | 320/390/1280 视口布局重组，触控目标 ≥44px，表格转卡片模式 |
| **横切** | 视觉技术审计 | impeccable `audit` | `impeccable/reference/audit.md` | 5 维技术健康度走查，结合 `impeccable detect` 本地二进制静态扫描 |
| **横切** | 无障碍规则引擎 | AccessLint `accessibility-scan` | `accessibility-scan/SKILL.md` | 基于真实 DOM 与 selector 的 a11y 规则检测（Tab 焦点环、ARIA 标记） |
| **横切** | React 性能规则 | vercel `react-best-practices` | `react-best-practices/SKILL.md` | 70 条规则防瀑布流、防非必要重渲染、优化 Context 与 Bundle |
| **横切** | 深层交互捕获 | microsoft `playwright-cli` | `playwright-cli/SKILL.md`<br>+ `playwright-cli/references/request-mocking.md` | 驱动真实浏览器点开深层 Modal/Drawer/Dropdown，输出交互快照证据 |
| **L0 原语** | 密集表格/树表 | kemiljk `semantic-html-first` + impeccable `operate` | `semantic-html-first/SKILL.md`<br>+ `impeccable/reference/operate.md`<br>+ `impeccable/reference/adapt.md`<br>+ `better-typography/SKILL.md`<br>+ `ui-ux-pro-max/references/quick-reference.md` | 原生语义表格（`<table/thead/tbody/th scope>`）、表头吸顶、`tabular-nums` 数值列右对齐、移动端卡片化降级；树表与半选对齐 W3C WAI-ARIA APG 标准 |
| **L0 原语** | 表单与内联校验 | Vercel `web-interface-guidelines` + kemiljk `interaction-contracts` | `web-interface-guidelines/command.md`<br>+ `interaction-contracts/SKILL.md`<br>+ `ui-ux-pro-max/references/quick-reference.md`<br>+ `impeccable/reference/clarify.md`<br>+ `impeccable/reference/harden.md` | 字段解剖、2px 语义焦点环、失焦校验+输入即清时序、错误三要素排版、禁止阻止粘贴、防重复提交状态机 |
| **L0 原语** | 骨架屏/防跳动 | addyosmani `core-web-vitals` (CLS) | `core-web-vitals/CLS.md`<br>+ `ui-ux-pro-max/references/quick-reference.md`<br>+ `impeccable/reference/optimize.md`<br>+ `baseline-ui/SKILL.md` | 1:1 几何占位防御布局抖动 (Anti-CLS)、预设容器高度、局部骨架替代全屏 Spinner、减弱动效回退 |
| **横切** | 坏数据注入目录 | emilkowalski `break-ui` (Catalog) | `break-ui/CATALOG.md` | 极端坏数据字典（非破坏性注入 `mocks.json`，验证长无空格、极值金额、特殊符号、空态、乱码） |
| **态 C** | 设计系统生成 | `ui-ux-pro-max` | `ui-ux-pro-max/SKILL.md`（脚本 `ui-ux-pro-max/scripts/search.py`） | 0→1 重构时通过 `search.py --design-system` 提取 50+ 风格与 10-Role Token 表 |

### 三层渐进式装配（Layered Progressive Mounting，派发唯一合法方式）

上表是**第三层只读手册的总索引**，不是注入清单。派发子 agent 时按以下三层装配：

**装配通道（按角色权限二选一，派发前必须先定通道）**：
- **通道 A · 路径注入（编码角色）**：Builder 等在 worktree 内以 bypassPermissions 运行的写码角色，brief 中给第二层切片的绝对路径指针并标注「实现前通读」。
- **通道 B · 全文内联（只读评审角色）**：Auditor / Designer / Critic 等带静音守则（只读 cwd 下文件、不联网）的角色**读不到 worktree 外的 vendor 路径**；编排者派发前把评审切片**全文直接粘贴进 brief 正文**，输入材料（`./captures/a11y.json`、`./captures/diff.patch`、截图目录）一律给 worktree 相对路径；brief 首行声明「本 brief 内联材料即全部评审依据，无需读取 brief 之外的文件」。

1. **第一层 · 硬禁令紧凑胶囊（常驻注入）**：
   - 文件：`~/.claude/skills/paseo-ui/brief-rules.md`（约 4KB / ~1.2k tokens）。
   - 内容：从 20 个切片压缩出的不可妥协 Don'ts/Musts（动效、排版、语义结构、表单、色彩、防位移、React 性能、破坏态自验）。
   - 每个编码角色（Builder / Lite 执行者 / Stage 5 返工）的 brief 必须原样附带全文。
2. **第二层 · 任务特征动态路由（按需指针注入）**：
   - 由 Stage 1 产出（或 Lite 入参决定）任务特征掩码，只把**命中特征**的切片路径写入 brief（每个 ≤2 个文件，标注「实现前通读」）：
     | 特征 | 追加注入（绝对路径，省略 `~/.claude/skills/paseo-ui/vendor/` 前缀） |
     | :--- | :--- |
     | 含数据表格/树表 | `semantic-html-first/SKILL.md` |
     | 含复杂表单/校验 | `web-interface-guidelines/command.md` |
     | 含列表动效/手势 | `micro-interaction/SKILL.md` |
     | 含 0→1 设计系统 | `ui-ux-pro-max/scripts/search.py`（CLI 执行）+ `interface-design/SKILL.md` |
     | 含异步媒体/动态注入内容 | `core-web-vitals/CLS.md` |
   - 无命中的特征不注入对应切片；纯静态页面不注入任何动效切片。
3. **第三层 · 深层手册按需查阅（不主动注入）**：
   - 上表全部路径保留为只读手册。brief 末尾附一句：「遇到胶囊未覆盖的边界场景（特殊组件模板、渐变插值空间、Spring 参数选择），到 `~/.claude/skills/paseo-ui/vendor/` 对应切片精准查阅后再写码」。
4. **机械门禁兜底（不靠 Agent 自觉）**：
   - 胶囊与切片只是提示层约束；最终判定一律以 Stage 3 `capture.mjs` CHI 探针（≥90 才可进终审）与 Stage 4 `accesslint` WCAG 报告为准，违规机械打回。

**注入预算（按角色类；超出即视为装配失败，重新收窄特征掩码）**：

| 角色类 | 第一层 | 第二层 | 实测最差 | 预算 |
| :--- | :--- | :--- | :--- | :--- |
| 编码（Stage 2/5、Lite ①–⑥⑧⑨⑩） | 胶囊全文 4.2KB | ≤2 必读切片（通道 A 路径） | 快轨③ 20.7KB | ≤21KB |
| 塑形 Stage 1 态 A | — | shape.md + interaction-contracts | 8.4KB | ≤12KB |
| 塑形 Stage 1 态 B/C | — | shape.md + interface-design（宪法级特批，方向选择不可肢解） | 33.2KB | ≤35KB |
| 只读评审（快轨⑦、Stage 4 两路） | — | ≤3 切片全文内联（通道 B） | Stage 4 路 B 18.5KB | ≤25KB |

对比旧方案全量注入 137KB：编码类最差缩减 ~85%，态 C 特批仍缩减 76%。

---

## 证据采集工具：`capture.mjs`

```bash
node ~/.claude/skills/paseo-ui/capture.mjs <url> --out ./captures/<phase> \
  --viewports 390,1280 [--states default,stressed,empty,error] [--mock ./captures/mocks.json] \
  [--serve "npm run preview"] [--port auto] [--self-test]
```

- **运行器**：优先本地或全局 Playwright（DOM 探针完整）；退回系统 Chrome CLI 时只有截图，探针记为 `unmeasured`，不得当作通过。
- **服务托管与自检**：
  - `--self-test`：一键校验 Playwright 运行器、符号链接主入口解析及状态机真值表。
  - `--serve "<cmd>"` 与 `--port auto`：自动分配空闲端口、拉起本地预览进程，待健康响应后开始采集，采集结束后在 `finally` 阶段安全清理进程，杜绝孤儿服务与端口冲突。
- **探针字段**：
  - `horizontal_overflow`（横向溢出）；
  - `active_feedback_coverage: {covered, total}`（可按压控件中挂有 `:active` 规则的数量；`has_active_feedback` 为 `covered > 0`，无可按压控件时为 `null`）；
  - `small_touch_target_count`（<44px 控件数）；
  - `has_tabular_nums`（等宽数字）；
  - `button_text_wrap`（按钮内行内文字非预期多行竖排折行检测，`button_text_wrap_count`）；
  - `low_contrast_count`（基于真实 DOM 计算前背景色 sRGB 相对亮度比，检测未达 WCAG 4.5:1 / 3.0:1 的低对比度文本）；
  - `cls_score`（累计布局位移 Cumulative Layout Shift 评分，检测异步加载与状态切换时的布局跳动，门禁 <0.1）；
  - `unlabeled_control_count`（表单控件缺失 `<label>`、`aria-label` 或 `aria-labelledby` 的违规数）；
  - `missing_autocomplete_count`（文本/邮箱/电话输入控件缺失 `autocomplete` 属性数）；
  - `th_without_scope_count`（数据表格 `<th>` 表头未声明 `scope="col|row"` 数量）；
  - `numeric_cell_misaligned_count`（包含数值/金额但未声明右对齐或缺失 `tabular-nums` 的数据单元格数）。
- **工艺健康指数（Craft Health Index, CHI）**：由 `capture.mjs` 基于真实 DOM 探针计算出的客观度量分（0-100，非 LLM 幻觉评分）：
  - 满分 100 分，按客观探针扣分：横向溢出扣 30 分；CLS 抖动扣至多 20 分（$\min(20, \text{CLS} \times 100)$）；触控尺寸不足 44px 每处扣 3 分（上限 15 分）；表单控件无标签每处扣 5 分（上限 15 分）；表格 `th` 缺 `scope` 每处扣 2 分（上限 6 分）；数值列未等宽右对齐每处扣 3 分（上限 6 分）；低对比度每处扣 2 分（上限 10 分）；`:active` 触感覆盖率不足 60% 扣 5 分，不足 30% 扣 10 分。
  - 等级评定：$\ge 95$ 为 A+，$\ge 90$ 为 A，$\ge 80$ 为 B，$\ge 70$ 为 C，$\ge 60$ 为 D，$<60$ 为 F。评分明细、扣分条目与 `craft_gate`（`threshold: 90`）自动注入 `capture-manifest.json`。
- **状态注入与场景捕获（Break-UI & Deep Modal Actions）**：`--mock` 指向 JSON，按状态名声明要拦截的接口及深度交互动作；`"*"` 为所有状态共享的基础数据，状态路由优先级更高：

  ```json
  {
    "*":        [{ "url": "**/api/tasks*", "bodyFile": "fixtures/tasks.json" }],
    "stressed": [{ "url": "**/api/tasks*", "json": { "items": [{ "title": "新疆维吾尔自治区伊犁哈萨克自治州塔城地区裕民县某某物资储备中心有限公司", "amount": 999999999.00 }] } }],
    "empty":    [{ "url": "**/api/tasks*", "json": { "items": [] } }],
    "error":    [{ "url": "**/api/tasks*", "status": 500, "json": { "message": "upstream timeout" } }],
    "modal":    {
      "routes": [{ "url": "**/api/tasks*", "json": { "items": [...] } }],
      "actions": [{ "click": "[data-modal-trigger]", "waitMs": 300 }]
    }
  }
  ```

  某状态的路由**全部被命中**才算进入该状态（`state_confirmations[*].observed = "mock:n/n routes hit"`）；有路由未命中即判 `state_unconfirmed`，说明页面没请求这份数据，截图不代表该状态。若状态声明了 `actions`，Playwright 将自动按序模拟点击/输入并等待过渡，直接产出弹窗或抽屉的渲染快照（顶层简写 `"modal:actions": [{…}]` 等价于对象内 `actions`）。`--mock` 只在 Playwright 运行器可用，否则直接失败。
- **无 mock 的状态**：页面自身在 `body`/`html`/应用根上写 `data-state` 时可直接确认；两者都没有时，该状态判为未确认。`capture.mjs` 等待 `networkidle` 后才截图，抓不到 loading 态；loading 态用 `playwright-cli` 按 `references/request-mocking.md` 拦住接口后手动截取。
- **产物**：`./captures/<phase>/*.png` + `capture-manifest.json`。`captures/` 是运行时产物，不提交。

---

## 参数路由与双档分流

### 参数路由表

| 参数 | 去向 | 必读切片（第二层，≤2；通道 A 绝对路径） | 按需查阅（第三层指针） |
| :--- | :--- | :--- | :--- |
| `polish` | 快轨 ① 视觉质感 | `impeccable/reference/polish.md` | `interface-design/SKILL.md`、`better-ui/SKILL.md`、`better-ui/icons.md` |
| `bolder` | 快轨 ① 视觉质感 | `impeccable/reference/bolder.md` + `impeccable/reference/polish.md` | `interface-design/SKILL.md` |
| `typography` | 快轨 ① 视觉质感 | `better-typography/SKILL.md` | `ui-ux-pro-max/references/quick-reference.md` |
| `color` | 快轨 ② 色彩 | `better-colors/SKILL.md` | `better-colors/` 目录辅助指南 |
| `layout` | 快轨 ③ 布局与响应式 | `impeccable/reference/layout.md` + `impeccable/reference/adapt.md` | — |
| `motion` | 快轨 ④ 动效 | `to-spring-or-not-to-spring/SKILL.md` + `micro-interaction/SKILL.md` | `60fps-animation/SKILL.md`、`accessible-animation/SKILL.md`（硬禁令已在胶囊） |
| `distill` / `quieter` | 快轨 ⑤ 降噪 | `impeccable/reference/distill.md` + `impeccable/reference/quieter.md` | — |
| `clarify` | 快轨 ⑥ 微文案 | `impeccable/reference/clarify.md` | `impeccable/reference/harden.md` |
| `audit` | 快轨 ⑦ 走查（只读） | `accessibility-scan/SKILL.md` + `impeccable/reference/audit.md`（**通道 B 全文内联**） | `accessibility-scan/shared/methodology.md` |
| `table` | 快轨 ⑧ 密集表格与树表 | `semantic-html-first/SKILL.md` + `impeccable/reference/operate.md` | `impeccable/reference/adapt.md`、`better-typography/SKILL.md`、`ui-ux-pro-max/references/quick-reference.md`（`tabular-nums`/右对齐硬禁令已在胶囊） |
| `form` | 快轨 ⑨ 表单与校验 | `web-interface-guidelines/command.md` + `interaction-contracts/SKILL.md` | `ui-ux-pro-max/references/quick-reference.md`、`impeccable/reference/clarify.md`、`impeccable/reference/harden.md`（autocomplete/禁阻止粘贴/焦点环硬禁令已在胶囊） |
| `skeleton` | 快轨 ⑩ 骨架屏防跳动 | `core-web-vitals/CLS.md` + `baseline-ui/SKILL.md` | `ui-ux-pro-max/references/quick-reference.md`、`impeccable/reference/optimize.md` |
| `full` 或命中 Full 触发场景 | Full 档 | 见下文六阶段 | — |
| 无参数 | 主会话按需求描述归入上表；跨 ≥2 条快轨时按条款 9 与影响面选 Lite 分级，仍不跨档则顺序执行多条快轨 | — | — |

「必读切片」以 `~/.claude/skills/paseo-ui/vendor/…` 绝对路径注入编码角色 brief（通道 A）；快轨⑦ 评审角色走通道 B 全文内联。胶囊 4.2KB + 必读 ≤2 切片合计实测最差 20.7KB（快轨③），符合 ≤21KB 预算；「按需查阅」列只在 brief 末尾保留一句路径指引，不注入正文。

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
| ⑧ 密集表格与树表 | 数据表格挤压、滚动表头丢失、数值列未对齐 | **改码**：吸顶表头、`tabular-nums` 数值右对齐、长文本截断与 tooltip、半选操作条与窄屏卡片化。 |
| ⑨ 表单与校验 | 报错突兀、缺少辅助说明、聚焦态丢失 | **改码**：字段解剖五构件对齐、2px 焦点环、失焦校验+输入即清时序、错误三要素排版。 |
| ⑩ 骨架屏防跳动 | 接口慢导致首屏白屏、数据到达时严重跳动 | **改码**：1:1 几何占位骨架屏替代全屏 Spinner，预设容器最小高度消除 CLS。 |

**Lite 执行分级**（按影响面，不按快轨）：

| 分级 | 判据 | 执行者 | 隔离 | 评审 |
| :--- | :--- | :--- | :--- | :--- |
| **L-0** | 改动 ≤2 个文件，且不触共享原语（`components/ui/`）与全局 token 文件 | 主会话直接改 | 原地 | 自动门禁 |
| **L-1** | 多文件，但不触共享原语与全局 token | 设计营造师 Builder | worktree | 自动门禁（Builder profile 默认的交叉评审被显式豁免——缺陷由 `capture.mjs` 探针与 `package.json` 门禁兜底） |
| **L-2** | 触及共享原语或全局 token（影响面跨页面） | 设计营造师 Builder | worktree | 自动门禁 + 设计师 Designer 前后截图抽检一次（抽检走通道 B 全文内联） |

走查快轨 ⑦ 的执行者：看截图选设计师 Designer，看代码与 a11y JSON 选审计员 Auditor；L-2 的 Designer 抽检同样只读。

**Lite 执行流**：
1. **基线**：确认目标文件的 `git status`。若目标文件有未提交改动，L-1/L-2 不建 worktree（会丢失这些改动），先问人类是先提交还是改为原地执行；原地执行时先把 `git diff -- <目标文件>` 存为 `./captures/baseline.patch`，交付时只报告相对基线的增量。
2. **改前截图**：用 `capture.mjs --serve '<预览命令> {port}' --port auto` 一体化起服务并截取 `--out ./captures/before`（服务由 `capture.mjs` 自动挑空闲端口、退出时整进程组收尾，不留遗留进程，也不与他人端口冲突）；视口与状态参数记下，改后复用同一组。
3. **派发或直改**：brief = 第一层硬禁令胶囊 `~/.claude/skills/paseo-ui/brief-rules.md` 全文 + 本快轨切片绝对路径（即第二层路由，Lite 天然单特征）+ 本 Skill「单一设计宪法与 Vendor 适配覆盖」节；L-1/L-2 在 `create_workspace(isolation: "worktree", branchName: "ui/<track>-<target>")` 中执行。
4. **自动门禁**：从项目 `package.json` 读取实际脚本（如 `build`、`test`、`lint`），全部退出码为 0；改后跑 `capture.mjs … --out ./captures/after`，`horizontal_overflow` 不得新增、`small_touch_target_count` 不得上升。
5. **呈报**：`git diff --stat`、before/after 截图对、探针前后对比、伴随的 `DESIGN.proposed.md`（如有），由人类确认后合入；worktree 合入后清理。

### 模式 B: Full 档（标准工业级流水线）

- **触发场景**：全新功能页面（0→1）、大面积业务流程重构（≥3 个交互界面）、公共组件库改造。
- **与 paseo-pipeline 的边界**：需求同时含后端/接口改动，或拆出 ≥3 个有依赖的非 UI 任务时，整体走 `paseo-pipeline`（OpenSpec change）。此时本档六阶段作为该 change 中 UI 任务的内部流程：Stage 1 的产出并入 pipeline 确认点 1（`PRODUCT.md`、`DESIGN.md` 随 spec 冻结），Stage 6 合入 `integration/<change>` 分支，主干合入归 pipeline 确认点 2；此时不调用 `openspec` CLI。纯 UI 需求则独立运行本档。
- **编排者**：Stage 1 由主会话直接编排（方向确认需人类在场）；Stage 2–5 预计派发 ≥4 次，按全局约定交总控 Lead 无人值守执行，主会话只守 Stage 1 与 Stage 6 两个确认点。下文 Stage 2–5 中的「编排者」即当前阶段的负责人（Lead 档为总控 Lead，主会话编排时为主会话）——起停预览、跑 `capture.mjs` 与 `accesslint`、准备 Stage 4 两路 brief、归并缺陷单，均为编排者职责，不派给静音评审角色。无人值守角色（Lead、Builder、Auditor 等）一律以 `bypassPermissions` 模式派发，不打断等许可。

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
   - 态 C（全新 0→1 页面）：调用 `python3 ~/.claude/skills/paseo-ui/vendor/ui-ux-pro-max/scripts/search.py "<domain-keyword>" --design-system` 生成 A/B 两种不同密度（`--density`）与版式（`--variance`）的设计系统草案。
2. **派发 Builder 塑形**：
   - 角色：`设计营造师 Builder`（`agent_profile_shejishi_builder`）。
   - 注入上下文（统一使用绝对路径，免疫 worktree 隔离）：`~/.claude/skills/paseo-ui/vendor/impeccable/reference/shape.md`、`~/.claude/skills/paseo-ui/vendor/interface-design/SKILL.md` 与 `~/.claude/skills/paseo-ui/vendor/interaction-contracts/SKILL.md`（明确交互契约：触发/状态/反馈/中断/失败恢复/焦点）。
   - 产出：功能架构、核心动线、界面展示态矩阵（Idle/Loading/Empty/Error/Stressed）；业务状态机以既有 spec 为准，不自造。**仅态 C 产出 A/B 两套方向对比**；态 A/B 只产出一套与既有方向一致的方案，若认为需要改方向，写成 Suggest 块交回。
3. **★ 确认点 1**：Builder 交回的方案（含 interface-design Suggest 块）由主会话转人类拍板；确认后按「单一设计宪法」保存映射写入 `DESIGN.md`，与 `PRODUCT.md` 一起冻结。

### Stage 2: 独立工程编码与硬化（Build & Harden）
1. **隔离环境**：`create_workspace(isolation: "worktree", branchName: "ui/<feature>")`。主干目标文件有未提交改动时，先按 Lite 执行流第 1 步处理。
2. **改前截图**（存量页面适用；0→1 页面跳过）：编排者在 worktree 用 `capture.mjs --serve '<预览命令> {port}' --port auto` 截取 `--out ./captures/before`，截完即退、无遗留服务。
3. **派发 Builder 落地**：
   - 注入上下文 = **第一层硬禁令胶囊 `~/.claude/skills/paseo-ui/brief-rules.md` 全文** + **第二层特征路由切片**（按 Stage 1 产出的任务特征掩码选取：表格→`semantic-html-first/SKILL.md`；表单→`web-interface-guidelines/command.md`；列表动效→`micro-interaction/SKILL.md`；异步媒体→`core-web-vitals/CLS.md`；每个 ≤2 文件）+ 第三层按需查阅指引一句。**不再全量注入 17 个切片**。
   - 修改真实工程源码，遵循语义化复合原语与 `:active:scale-0.96` 触感；金额/数值强制 `tabular-nums text-right`；同一缺陷多点出现时按条款 9 修原语。
4. **极端坏数据破坏自验（Break-UI）**：Builder 参考 `~/.claude/skills/paseo-ui/vendor/break-ui/CATALOG.md` 极端坏数据字典编写 `./captures/mocks.json`（格式见「证据采集工具」），至少覆盖：
   - `stressed`：参考 break-ui 注入恶劣真实数据（杜绝无意义假数据；注入超长真实实体名称、多音节国际化字符串、`¥999,999,999.00` 极值金额、特殊符号破折号）；
   - `empty`：0 条数据真实空态；
   - `error`：接口 5xx 或网络中断，验证错误条与重试入口。
   只改输入、网络 mock 与视口，不碰生产数据与业务代码路径。
5. **持久回归（可选）**：项目已安装 `@playwright/test` 时，为关键页及上述 mock 态补 `toHaveScreenshot()` 用例；未安装则在报告中列为建议，不自行新增依赖。
6. **本地构建与静态检测**：
   - `~/.claude/skills/paseo-ui/vendor/impeccable/scripts/impeccable detect --json` 静态扫描（启动器不可用时标「降级：未采集」）；
   - 项目 `package.json` 中的 `test` / `build` / `lint` 脚本，退出码必须为 0。

### Stage 3: 截图与交互证据采集（Capture & Probe）
1. 编排者统一用 `--serve` 一体化采集，服务生命周期等于本次命令：起服、截图、探针、退出时整进程组 SIGTERM 收尾，不留遗留进程：
   ```bash
   node ~/.claude/skills/paseo-ui/capture.mjs --serve '<预览命令，如 npm run preview -- --port {port}>' --port auto \
     --out ./captures/after --viewports 390,1280 \
     --states default,stressed,empty,error,modal --mock ./captures/mocks.json
   ```
   端口由 `--port auto` 自动挑空闲，从源头消除「误连他人服务」与「服务属主不明」两类事故。
   所有状态须 `confirmed: true`；DOM 探针自动计算并输出 Craft Health Index (CHI: 0-100)。**CHI <90 时 `capture.mjs` 以退出码 3 结束**——此为机械门禁，不依赖任何 LLM 判断；exit 3 即直接进 Stage 5 返工，探针未采集（`unmeasured`）的维度按缺口处理不得视为通过。
3. **深层弹窗抓取**：页面含 Dialog/Drawer/Modal 时，优先在 `capture.mjs --mock` 中声明 `actions: [{ click: "...", waitMs: ... }]` 序列自动化触发截取；或调用 `playwright-cli` 手动驱动截取。
4. **a11y 权威扫描**：编排者直接运行全局预装的 `accesslint-chrome ensure` 与 `accesslint scan`，毫秒级生成 WCAG 2.2 报告 `./captures/a11y.json`（带精确 `file:line` 源码映射）；收尾用 `accesslint-chrome stop -p <port>` **精确停杀本扫描启动的实例**，严禁 `stop --all`（会连带杀掉并行流水线的托管 Chrome）。

### Stage 4: 双路并发客观反证（Concurrent Audit）
两路异族 Agent 并发审查：

- **读图探针（前置）**：派 Designer 前，先给它一张已知截图，让它说出页面主按钮的文案；答错或含糊即判定本轮不可读图，路 A 改由**主会话亲自读图**完成视觉走查（主会话本身具备多模态能力，无需替换 profile），并在报告中记录探针结果与替换事实。
- **路 A（视觉多模态走查 - 看图）**：
  - 角色：`设计师 Designer`（`agent_profile_jiangzuo`，按读图探针结果决定是否替换）。
  - 注入方式：**通道 B 全文内联**——编排者把 `~/.claude/skills/paseo-ui/vendor/impeccable/reference/audit.md` 全文粘贴进 brief（Designer 带静音守则，读不到 worktree 外路径）。
  - 输入：`./captures/before` 与 `./captures/after` 下的截图、`capture-manifest.json` 探针（CHI 指数）、`DESIGN.md`（均在 worktree cwd 内）。
  - 职责：对照设计宪法与工艺基线，提取客观缺陷（Contract 违背条款 + Runtime 视口/状态复现 + Correction 唯一建议），严禁输出主观打分。
- **路 B（工程/无障碍/动效代码审计 - 读码）**：
  - 角色：`审计员 Auditor`（`agent_profile_anchasi`，Codex 异族模型）。
  - 注入方式：**通道 B 全文内联**——编排者把 `accessibility-scan/SKILL.md` + `react-best-practices/SKILL.md` + `review-animations/SKILL.md` 三份切片全文粘贴进 brief（合计 18.5KB，符合 ≤25KB 评审预算）；Auditor 带静音守则，只读 worktree cwd。
  - 输入：`./captures/a11y.json`、`./captures/diff.patch`（编排者预先在 worktree 内执行 `git diff $(git merge-base HEAD <基线分支>)..HEAD > ./captures/diff.patch` 落盘，免 Auditor 自跑 git 命令）。
  - 职责：检查键盘 Focus-Trap、ARIA 属性、Tab 遍历、React 重渲染漏洞；**依据 `review-animations` 审查 CSS 动效代码合法性**（合成器硬件加速、贝塞尔曲线、prefers-reduced-motion 降级安全网），核对改动路径不越出任务边界。

### Stage 5: 定向返工收敛（Convergence ≤2 轮）
1. 归并两路审查发现的阻断项（P0/P1）；同源缺陷按条款 9 合并为原语级修复。
2. 在原 worktree 唤起 Builder 定向修复。
3. 重跑 Stage 2 第 6 步门禁与 Stage 3 截图，确认缺陷关闭（`capture.mjs` 退出码归 0，即 CHI ≥90）；2 轮后仍未关闭的阻断项原样上报，不再返工。返工 brief 同样走三层装配（胶囊全文 + 命中缺陷对应的切片）。
4. **设计契约反哺**：修复中发现视觉规范缺陷（如某色板在深色模式对比度不足），只产出 `DESIGN.proposed.md`，不覆写 `DESIGN.md`。

### Stage 6: 终审呈报与合入（Final Approval & Merge）
1. 确认无遗留服务：`--serve` 模式的预览随 `capture.mjs` 退出自动收尾；若曾手动起过预览，逐一关闭；`accesslint-chrome` 用 `stop -p <port>` 精确停杀（禁 `--all`）。
2. 向人类呈报交付报告：
   - before/after 多视口、多状态截图；
   - **CHI 工艺健康指数与扣分明细（终审门禁 ≥90，须 `capture.mjs` 退出码 0）**；
   - 探针结果（溢出、按压反馈覆盖率、触控目标）及未确认状态清单；
   - 读图探针结果、双路审查结论与未关闭项；
   - `git diff --stat` 与核心代码变更摘要；
   - 伴随的 `DESIGN.proposed.md`（如有）。
3. **★ 确认点 2**：人类确认后执行 fast-forward / squash 合入（独立运行合入主干；pipeline 内运行合入 `integration/<change>`），清理临时分支、worktree 与 `./captures/`。
