# Paseo Pipeline 实践与踩坑记录 (LESSONS.md)

记录流水线演进中的实测数据、缺陷复盘与设计推演。供排查问题与回归参考；操作规程与硬门禁以 `SKILL.md` 为准。

---

## 1. 角色与派发

- **Tester 能力误判**：旧版 `SKILL.md` 曾把测试工程师写成"只写单测"，而 profile `notes` 中其实支持 E2E 与跨模块集成测试。角色职责必须以 `list_profiles` 的 `notes` 为唯一真源，禁止在 skill 中硬编码或自创边界。
- **配置指纹与核对**：实测 9 次派发里 6 次是同一 profile 的重复确认。改用配置指纹缓存：change 开始时解析 `list_profiles`，同 profile 已核对无偏差时跳过重复核对，兼顾安全性与减少冗余调用。
- **只读角色静音**：2026-10-23 `vector-ops` 实测中，dot 的 Auditor 因调用 memory MCP 工具被安全策略拦截，停在等待权限状态，导致整条完成通知链挂起数分钟。所有只读角色（Auditor、Critic、Arbiter、Scout）brief 中必须显式声明禁调 memory/MCP/网络工具。
- **编排者不留在主会话**：2026-10-23 `vector-ops` 和 2026-10-24 `number-theory-factors` 两次实测，主会话亲自编排均遭遇 2–3 次上下文压缩。任务数 ≥4 或预计 >30 分钟的任务，必须交由总控 Lead (`agent_profile_shangshu`) 无人值守执行，主会话只守人类确认点。
- **create_agent 参数防御**：2026-10-24 `integer-sequence-ops` 实测中曾因漏传 `title` 触发 `MCP error -32602`。`title` 字段为 Schema 必填且有 ≤60 字符硬约束，派发前必须统一格式并截断 `[Pipeline] ${role} ${action} ${change}`.slice(0, 60)。
- **tasks.md 标题序号漂移**：任务标题如果在 DAG 设计中调整过层级序号（如从 `1.4` 变成 `2.1`），按带序号的长字符串查找替换会报 `String to replace not found`。Done 行标记必须基于任务 ID 锚点（`T-NN:`）定位。

---

## 2. Workspace 与分支生命周期

- **分支命名一致性**：实测曾出现 change 叫 `vector-ops`，分支却建为 `integration/vector-ops-concurrency`，导致后续对账完全失效。分支命名必须严格使用 `integration/<name>`、`spec/<name>`、`task/<name>/<task>`。
- **Base branch not found 竞态**：以新创建的分支为 baseBranch 时，daemon 本地引用可能尚未就绪，首建会报 `Base branch not found`（实测延迟达 48 秒）。优化方案：spec workspace 基点用主干；任务 workspace 创建时一律带 `path: <主仓库路径>`，确保直接定位本地仓库。
- **Spec workspace 归档时机**：实测曾发生在 08:24 spec 冻结后漏归档 spec workspace，一直滞留到 08:43:56 收尾才归档，晚了约 19 分钟。冻结确认点 1 的三步动作必须固定：合流 -> 立即归档 spec workspace -> 再派首个任务。
- **Workspace 对账合并**：实测归档 6 次对应 6 次独立 `list_workspaces` 调用。收到完成通知时，同轮对账共用一次列表快照，避免反复扫描。

---

## 3. 调度与空等损耗

- **完成通知处理反例**：实测同一轮连续三次空等：
  - scale 的 Runner 08:27:42 完成，Auditor 08:32:57 派出（空等 5m15s）；
  - dot 的 Tester 完成后空等 4m09s；
  - norm 的 Runner 完成后空等 3m06s。
  空等期间主模型仅在整理长上下文，且两次上下文压缩均发生在此间隙。
- **极简信封驱动**：收到通知后必须在 100ms 内完成"验状态 -> 记意图 -> 派下游"，合流与记账排在派发后或等待空档，严禁在派发下游前深入推理解读长篇日志。
- **禁止跨任务批量合流记账**：2026-10-24 `integer-sequence-ops` 实测中，T-01、T-02、T-03 并发完成后，Lead 将三者统一批处理合流记账为一个 commit，导致仅依赖 T-01 的 T-04 从 11:04 等到 11:06，产生了约 2 分钟的无谓排队。规范明确：单任务合流记账提交后，立即重算 Ready 并派发就绪的下游任务，消除批量屏障。

---

## 4. Spec 设计与尺寸分档

- **避免单函数单独立项**：2026-10-24 `number-theory-factors` 实测中，4 个小函数与 1 个导出被拆成了 5 份独立 spec，产物达 369 行，为实现代码（87 行）的 4.2 倍。同域能力应聚合到一份 spec（单能力挂多 Requirement/Scenario），降低契约碎片化。
- **公共入口契约归属**：公共入口（如 `index.js`）的导出契约必须归属于唯一目录，合并为一条 Requirement。旧做法为每个函数单独拆一条导出 Requirement，导致归档后主 spec 极度臃肿。
- **数值契约自检**：次正规区间（`|x| < 2 ** -1022`）网格间距恒为 `Number.MIN_VALUE`，相对误差界恒不成立。出现相对误差条款时必须加 `Math.max(E, 2 ** -1022)` 下限。另外，加入"所有 literal 均为正确舍入值"元条款时，曾导致 `norm([3e200, 4e200]) === 5e200` 冲突（真值为 `4.9999999999999995e200`），误杀合规实现。

---

## 5. contract-check 演进历史

- **历史测试污染**：若向门禁传入整个 `test/` 目录，增量仓库中的既有历史断言会被全部判定为 `undeclared`（实测一次报 `undeclared=48`）。门禁测试侧只传本 change 声明的测试。
- **级别语义区别**：单任务测试只覆盖局部，按全量跑必然出现 `untested > 0`（实测 T-02 单任务跑全量报 `untested=11`）。因此任务级用 `--partial`（只验 `undeclared=0`），收尾才要求全量双零。
- **断言字段与被测回调过滤**：旧版将 `assert.throws(..., { name: "RangeError" })` 中的 `name` 误判为消息；将 `assert.throws(() => toBase("10", 1))` 中的参数 `"10"` 误判为断言消息。现已严格过滤判别字段并只扫描回调函数后的实参。
- **常量解引用与按文件隔离**：测试中常见 `const M = "..."; assert.throws(f, { message: M })`。旧版未解引用导致 `tested=0 undeclared=0` 假通过。跨文件同名常量（如 `TYPE_MESSAGE`）若合并建表会导致互相覆盖污染，现已实现单文件独立常量作用域。
- **covered = tested 原则**：不能仅以"文件中出现过错误字面量"判断覆盖，必须以真实断言引用为准，防止删除断言后因残留字面量而假通过。
- **fail-closed 判定时序**：测试侧若存在 throws 却提取不到有效消息，必须在 spec 判空之前报错退出，避免动态拼接消息被误判为 SKIPPED。
- **zsh 分词与 --tasks 自动解析**：在 zsh 中传递变量 `$T` 不会自动 word-split，导致多个测试路径被当成单个参数传递，触发假 SKIPPED。通过增加 `--tasks <tasks.md> [--task <id>]` 参数，由脚本直接从 `Verify with:` 与 `Write scope:` 解析路径，彻底消除 shell 分词风险。
- **Scenario 编号双向静态对账 (SCEN-*)**：在 `contract-check.mjs` 中引入 spec 声明的 `#### Scenario: SCEN-*` 与测试侧引用的场景编号双向静态比对。无需大模型介入（耗时 <10ms），即可对正常分支与边界测试实现 100% 机械覆盖（`phantom_scens=0 untested_scens=0`），杜绝假覆盖与场景错别字。

---

## 6. 采集与度量规范

- **执行时长采集**：必须使用 `完成通知时间戳 − 派发时快照 createdAt`。不能用 `updatedAt − createdAt`，因为 agent 归档后 `updatedAt` 会被覆盖为归档时刻。
- **数据真实性**：快照无 token 用量字段时写"未采集"，禁止用 `list_models` 目录估算；模型名一律照抄快照别名，不得脑补具体版本号。
- **冒烟题目设计经验**：必须满足 ≥5 任务（超过 cap=3 才能观察真实背压）、≥1 条依赖链（验证依赖释放）、≥1 对共享文件（验证全量审查分支）。

---

## 7. 2026-10-24 integer-set-partition-ops 复盘与流水线精简

- **微型算子过度施压与 Task Pod**：69 行核心实现消耗了 14 个 agent、7 个 worktree 和 10 次集成分支提交（5 次 merge + 5 次记账）。流程按最坏情况统一施压造成严重摩擦。对同域微型任务必须采用 Task Pod 模式（`pod/<name>`）：单 workspace、Tester/Runner 批量接力、Auditor 单次复核合并 diff、单次合流，派发次数和提交数减少 70% 以上。
- **合流记账原子化与脚本门禁 (`merge-task.sh`)**：旧流程将 merge 与更新 `tasks.md` 拆为两步提交，且依赖人工记忆执行全量测试与退出码捕获，实测中曾多次漏跑全量测试。现改由 `merge-task.mjs` 脚本自动化执行：工作区干净检查 -> `merge --no-commit` -> 跑全量测试 -> 自动更新 `tasks.md` 标记 `[x]` 与 Done 行 -> 一次性原子提交。测试失败或合并冲突时自动 abort 并回滚至合并前，消灭脏状态与重复提交。
- **审计分级而非豁免**：静态三门门禁不能替代独立审计（Goodhart 陷阱：过分迁就测试用例可能掩盖边界漏洞）。优化方向是合并审计批次（Pod 级审一次），并根据风险动态调整深度（strict 或改共享入口用 high thinking，其余普通任务用 low thinking）。数学/算法类算子由 Tester 补充差分对拍与小定义域穷举，从测试源头筑牢防线。
- **编排权属重新划线**：将交由 `agent_profile_shangshu` 无人值守的判据修正为"预计派发 ≥6 次或预计 >30 分钟"；日常微型 Pod 任务（通常仅需 2–3 次派发）由主会话直接编排，主会话保持"只读信封、不读业务代码全文"的纪律。
- **派发参数严格机械化**：禁止为了满足格式而编造 `features: {"reason": "..."}` 等虚假字段；严格从 `list_profiles` 逐字段复制，profile 未声明字段直接省略。派发后一次快照核对并采集时间戳。
- **分支清理与模板闭环**：禁止使用 `git branch -D`（强制删除），允许使用 `git branch -d` 安全清理已合入主干的临时分支；`proposal.md` 转写时必须包含 `## What Changes` 章节以消除 `openspec archive` 告警；归档命令统一附加 `--yes` 杜绝终端交互阻塞。
