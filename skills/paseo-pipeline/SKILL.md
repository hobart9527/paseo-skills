---
name: paseo-pipeline
description: SDD 交付流水线：OpenSpec 管生命周期，Paseo profiles 管角色，Lead 只做阶段编排与并发调度。入口接受需求描述或已有 change 名。触发词：/paseo-pipeline、pipeline、并发交付。
user-invocable: true
---

# Paseo Pipeline

OpenSpec 管 SDD 生命周期（产物格式、阶段顺序、校验以 `openspec` CLI 为准），Paseo profiles 管角色，本 skill 负责串联与并发调度。change 名是对账键，不是准入凭证。实践反例与踩坑历史见同目录 `LESSONS.md`。

**OpenSpec CLI 主会话独占**：所有 `openspec` CLI 命令（`init`、`new`、`validate`、`archive`）由主会话独占执行。派出的子 Agent 与 Lead 只能只读读取 `openspec/changes/<name>/` 下的产物文件，禁止执行 `openspec` 命令，防止多进程破坏状态。

**用户输入参数：** $ARGUMENTS

## 角色与派发

角色边界以 `list_profiles` 返回的 `notes` 为唯一真源，分发路由见 `~/.paseo/task-routing.md`。派发时不硬编码任何模型名称。

| 阶段 / 职责 | profile | 说明 |
|---|---|---|
| 总控编排 | 主会话 / `agent_profile_shangshu` | 预计派发 ≥6 次或预计 >30 分钟时交 Shangshu 无人值守，主会话只守确认点 1 与 2；微型 Pod 任务（通常 ≤3 次派发）主会话直接编排 |
| 需求调研 | `agent_profile_chanpin` | 产品需求规划与现状调研（吸收原 Scout 侦察兵职能，提取 Codebase Digest） |
| 契约制宪 | `agent_profile_hanlin` | 架构与契约设计；微型/中型由编排者起草；兼任架构争议裁决（吸收原 Arbiter 仲裁官职能） |
| 测试先行 | `agent_profile_ceshi` | 严格档（`Review: strict`）任务使用，先写 Red 测试；数学类任务写差分对拍或小定义域穷举 |
| 代码实现 | `agent_profile_gongbu` | 默认实现角色；兼顾极速轻量执行（吸收原 Pi-Runner 轻骑兵职能） |
| 复杂攻坚 | `agent_profile_gaogong` | 复杂任务（跨模块、并发、状态机）实现与打回升级重做 |
| 代码审计 | `agent_profile_anchasi` | 审 diff、spec 场景与 tasks.md 正交性，只报 Blocker；吸收原 Critic 挑刺官职能 |
| UI/原型 | `agent_profile_jiangzuo` | UI/UX 方案原型构建与多视口截图走查（吸收原 Builder 营造师职能） |

**原生 MCP 派发（默认路径）**：
派发通过 agent 作用域原生 MCP `create_agent`/`send_agent_prompt` 执行：
- 参数源头：`provider`、`settings.modeId`、`settings.thinkingOptionId`、`settings.features` 均取自当前活态 `list_profiles`（其中的 `featureValues→settings.features` 逐字复制）。缺省字段直接省略，禁止编造默认值。
- 通知约束：`notifyOnFinish: true`（默认启用，不可关闭），通知到达驱动后续流转。
- 标签体系：必须打齐 `pipeline.change`、`pipeline.task`、`pipeline.attempt`、`pipeline.phase`、`pipeline.role`。
- 标题约束：`title` ≤60 字符，格式为 `[Pipeline] ${role} ${task} ${change}`。

**Legacy CLI 兜底说明**：
`dispatch.mjs` 与 `hotfix.sh` 为 Legacy 兜底工具。在当前版本实测中，通过 CLI 派发无法保证父子 Agent 通知送达。仅在无法调用 MCP 时用于调试，正常流程一律使用原生 MCP。

**硬底线**：不抓凭据/直连 API/冒用身份；push、`rm -rf`、`--amend` 先问；两个人类确认点。

**小修快轨**：合规小修走 `hotfix.sh <change> <task-id> <brief> <test-cmd>`，仅限 `Review: mechanical` 任务，必须提供显式测试命令；涉及 `Risk-surface` 的任务必须走正常 Auditor 审查，不得绕过。

## Workspace 与分支生命周期（全交 Paseo）

**禁止 `git worktree add/remove/prune` 与 `git branch -D`**；允许收尾使用 `git branch -d` 安全删除已合入主干的临时分支。工作树全交 Paseo 管理。

1. **分支命名**：严格使用 `integration/<name>`、`spec/<name>`、`pod/<name>`（微型 Pod 模式）、`task/<name>/<task>`（DAG 模式，重派追加 `-a<attempt>`）。
2. **创建与隔离**：`create_workspace` 统一带 `path: <主仓库路径>`，`background: false`。
   - **集成 workspace**：基点为主干，全 change 唯一，用于合流与全量测试，收尾前永不归档。
   - **spec workspace**：基点为主干。确认点 1 冻结时固定三步：① 集成分支合入 `spec/<name>` 并跑测；② 立即 `archive_workspace` spec 工作区；③ 开始派发任务。
   - **任务/Pod workspace**：基点为 `integration/<name>`。合流成功并记账提交后方可归档。
3. **工作区保留**：失败、被打回或标记为 Blocked 的任务，其对应 workspace 保留现场供人类排查，不自动归档。
4. **批量对账**：同轮完成通知共用一次 `list_workspaces(includeBackground: true)` 快照进行存活核对。

## 事件驱动、信封纪律与系统限制

### 系统局限与双轨自愈
常规微型运行不默认启用周期性后台看门狗。**纯事件驱动在缺少外部计时器源时，回调静默丢失无法自唤醒空闲 Lead**。
流水线实施**双轨自愈机制**：
1. **主轨（事件瞬时响应）**：子 Agent 完成通过 `notifyOnFinish: true` 毫秒级唤醒父 Agent 处理合流与下游派发。
2. **副轨（Paseo 原生 Heartbeat 兜底脉冲）**：长程无人值守时，Lead 开工调用 Paseo 原生 `create_heartbeat`（建议 3 分钟，设置 `expiresIn: "2h"` 超时自毁防泄露）。
3. **惰性对账（lazy reconcile）**：心跳或外部唤醒时运行 `node skills/paseo-pipeline/reconcile.mjs <change>`，按 tasks.md + git + paseo 运行态幂等对账，发现 MERGE/READY 即刻推进，消除丢包停摆。任务全量完成后 Lead 调 `delete_heartbeat` 销毁。

### 信封规范 (≤20 行)
Agent 完成后提交结构化信封：
- `kind`: `turn-idle`（等待下游时当前回合结束，非阶段完成）、`phase-complete`（当前阶段顺利完成）、`blocked`（阻断打回或失败）。
- 必备字段：`task`、`attempt`、`phase`、`result`、`reviewed_sha`、`blockers`、`next_action`。

### 孙 → Lead → 父会话显式接力
`create_agent` 的 `notifyOnFinish` 是单级消费机制：孙 Agent 终态通知到达 Lead 后，被 Lead 消费即结束。当 Lead 自身在等待孙 Agent 时回合已结束（`turn-idle`），在孙 Agent 完成、Lead 跑完核对与合流后，**Lead 必须显式调用 `send_agent_prompt`（steer 模式）** 向父会话发送 `phase-complete` 或 `blocked` 信封，完成端到端任务接力。

### 通知去重与过期处理
去重复合键：`(agent_id, message-id/event-id, task, attempt, phase, revision)`。
- 若相同复合键已处理，或 attempt 低于当前任务记录，或 revision 与当前分支 tip 不符，直接忽略并记录一行日志。
- 消除重复事件引发的重复派发或重复合流。

### 权限纪律与暂停处理
当 Agent 请求敏感工具权限时，状态转入 `UNRESOLVED`（权限暂停）。
- **Lead / AI 严禁调用 `respond_to_permission` 代批**，任何情况下不得越权代人类审批。
- 权限请求必须通过信封上报人类，等待人类在客户端或交互界面中批准或拒绝后方可续跑。

### 重试与返工预算
- 任务实行有限重试预算：每个任务最多打回 2 轮（≤2 次打回）+ 升级高工 1 次。
- 超出预算后立即标记为 `Blocked`，保留 workspace 现场并报告人类裁决，禁止无限自旋重试。

## 阶段 0：定位
无 `openspec/` 先 `openspec init --tools claude`；入参匹配已有 change 调 `openspec status --change <name> --json` 获取断点并恢复，否则视为需求描述进入阶段 1。

## 阶段 1：Spec
1. **尺寸三档分流**：
   - 微型：同域无跨模块共享面，采用 Task Pod 模式（单 workspace `pod/<name>`，按序接力，单次合流，Auditor 单次审查 diff）。
   - 中型：少数能力域，DAG 并发模式（单任务独立 workspace，背压 cap=3，Critic 审 1 轮）。
   - 大型：跨模块、深依赖、Schema 变更，分阶段 DAG（背压 cap=3，Critic 审 ≤2 轮）。
2. **风险扫描与 Review 等级**：
   - `tasks.md` 标注 `Risk-surface: [error-handling|numerical|concurrency|...]`。
   - 含 `error-handling` 自动推导为 `Review: strict`（Tester 先写 Red 测试）。
3. **人类确认点 1：spec 冻结**：呈报概况、DAG 拓扑与 Critic 结论，经用户确认后冻结。

## 阶段 2–3：DAG 并发与安全合流

### DAG 就绪与资源并发
- 依赖释放：仅当前置任务处于 `DONE`（通过 first-parent 合流且 trailer 验证通过）时才释放下游。
- 资源冲突串行化：`Write scope` 前缀重叠的任务保守串行；互不重叠且工作区隔离的任务可在 `cap` 限制内并发派发。
- 运行态未知保护：存在 `UNMAPPED` 运行中写入者时，清空 `canDispatchNow`，安全闭合。

### 安全原子合流 (`merge-task.mjs`)
在集成 workspace 内执行合流，命令契约：
```bash
node skills/paseo-pipeline/merge-task.mjs <branch> <task-id> <review-tag> <test-cmd>
```
1. 校验当前分支为 `integration/<change>` 且工作区干净。
2. 校验 `review-tag` 格式 `pass(<reviewer-id8>@<tip7>/<base7>)`，`tip7` 必须严格等于分支 tip。若 `base7` 与当前集成 HEAD 存在基线漂移且改动文件重叠，拒绝合流要求重审；文件不重叠则放行并记录漂移，不要求强制 rebase。
3. 执行显式 `test-cmd`。测试失败或合并冲突时自动执行 `git merge --abort` 恢复现场，严禁回滚重置工作树。
4. 审查等级为 `strict` 的任务必须附带审计员 PASS 证明，禁止使用 `mechanical` 隐式批准。
5. 自动勾选 `tasks.md`，追加 `Done: source=<tip7> review=<review-tag>`。
6. 原子提交附带 trailers：`Pipeline-Task: <task-id>` 与 `Pipeline-Source: <full-sha>`。

## 失败处置与恢复
1. 读 `git log --first-parent integration/<name>` 与 `tasks.md` Done 行，二者为唯一账本。
2. 任何时候断链，运行 `node skills/paseo-pipeline/reconcile.mjs <change>` 获取当前真实任务图与就绪任务并继续。

## 收尾与人类确认点 2
1. 集成分支跑全量回归测试。
2. 运行 `test/check-evidence.mjs` 核验各项证据与审计记录。
3. 归档集成 change：`openspec archive <name> --yes`。
4. **人类确认点 2：合入主干**：呈报 diff 摘要与测试记录，经用户确认后方可合入主干分支。未经确认绝对禁止合入 main、推送远端或发布外部服务。
5. 归档工作区，清理临时分支。
