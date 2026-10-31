# Design: pipeline-dispatch-convergence

## Context

见 proposal.md。三个派发入口的差异是采集值（读 `hotfix.sh`、`task-runner.mjs`、`merge-task.mjs`、`run-state.mjs` 源码得出），不是推测。

## Goals / Non-Goals

**Goals**

- 一个 CLI 派发入口，其分支、基点、标签、意图账本行为由代码强制，不靠 brief 或主会话自觉。
- 手动 MCP 路径上，写手被派进集成 workspace 这类错误在**登记回执时**被拦住，不等到合流。
- change 产物未提交这一状态在建集成 workspace 之前被拦住。
- 任何入口都不能为一个“没有真实审计员”的任务产出审计通过记录。

**Non-Goals**

- 不合并 `reconcile`/`merge-task` 的职责；不改 exit 码语义。
- 不为手动 MCP 路径建新的派发包装（那是 `create_agent` 的原生路径，SKILL §1 的默认）。
- 不处理 `paseo wait` rc=1 的根因（未归因，见 proposal）。
- 不清偿 31 条 phantom 存量债。

## Decisions

### D1 哪个入口留下

比较过三种：

- **A. 留 `hotfix.sh`，删 `task-runner.mjs`**：`hotfix.sh` 已硬化、有 17 条测试和规格场景。代价：丢掉 `--speculative`、`--fast`、DAG 多任务调用，且 bash 内联 node 难测难扩。
- **B. 留 `task-runner.mjs`，`hotfix.sh` 降为包装（选定）**：可测的 Node 实现；吸收 `hotfix` 的全部已验证行为；`hotfix.test.mjs` 原样变成回归契约，证明吸收没有丢行为。代价：要改 `task-runner` 的 3 个关键路径并迁移其测试。
- **C. 两个都留，各补丁**：继续存在两份分支/标签/profile 逻辑，下一次漂移是确定的。否决。

选 B 的另一个理由：`task-runner` 已在 SKILL 与 `run-all.sh` 登记，删除它是行为回退；而保留并纠正更接近“远端已合入的意图”。

### D2 交接门禁放在 CP-1 之后，不放进 `freeze-check`

`freeze-check` 在 CP-1 **之前**运行，此时 change 目录必然未提交；把“已提交”做成 `freeze-check` 的阻断项会让冻结永远过不了。因此单独成 `handoff-check.mjs`，由交接序列在 CP-1 之后、建集成 workspace 之前调用；`task-runner` 派发前也调用同一份 `lib/handoff.mjs`，保证两个入口的判据只有一份。

### D3 登记回执处拦截，而不是派发处

手动 MCP 路径没有可挂钩的派发包装；唯一每次都会经过的机械点是 `run-state.mjs record`（它已读取 agent 的 Paseo 记录校验标签）。在这里加判据：写手角色 + impl/test 阶段 + agent 记录的 cwd 当前分支匹配 `^integration/` → exit 2。读不到记录或分支时放行（与标签校验同口径：拿不到的记录不能既当证据又当免责），但**该放行必须在 stderr 留一行说明**，不静默。

### D4 审计诚实：停下而不是伪造

非 mechanical 档的审计员必须是独立 agent，`merge-task` 因子 3b 要求审计意图有真实回执。`task-runner` 无法自己派 Auditor 并等待其信封（那是编排者职责），因此改为 exit 50 并打印下一步；编排者拿到真实 Auditor 的 `pass(...)` 标签后以 `--review-tag` 重入，由 `merge-task` 自己验。同时删除对 `PIPELINE_ALLOW_HOMOGENEOUS_REVIEW` 的硬编码设置：该豁免只能由人显式设置。

### D5 `paseo wait` 容错不等于归因

`paseo wait` 在文档中描述为恒 rc=0，本次实测返回 rc=1。容错策略：先解析 `--json`；无法得到 `status` 时改用 `paseo inspect <id> --json` 的 `Status` 字段轮询（间隔与上限可由 `--timeout` 控制）；超时退出码 51（agent 可能仍在运行，**禁止**重派）。不在文档里断言根因。

### D6 风险

- `task-runner` 改动面大（派发、等待、审计、合流四段），任务顺序化（T-03 → T-04）避免同文件并行。
- 移除离线 fallback 后，测试必须靠 `paseo` 替身；`hotfix.test.mjs` 已有可复用的替身写法。
- 吸收 hotfix 行为时若遗漏，会由 T-05 的 `hotfix.test.mjs` 全量回归暴露——这是把它放在 T-05 而非开头的原因。
