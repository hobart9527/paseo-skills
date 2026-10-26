## 1. 打回预算的机器可读化

- [x] 1.1 `lib/roles.mjs` 新增 `ESCALATION_ROLE`、`MAX_ESCALATED_RETRIES` 与 `retryPolicy(rejections)`，阈值与决策同处一个所有者
- [x] 1.2 `reconcile.mjs` 的预算判定改走 `retryPolicy`，删除内联比较
- [x] 1.3 `READY` 条目在升级态携带 `escalate` / `role` / `rejections`，未升级时不新增任何键
- [x] 1.4 `dispatch` 动作追加可选 `escalations` 数组，且只收录 `canDispatchNow` 内已升级任务；`tasks` 形状不变
- [x] 1.5 文本通道输出升级标记 `READY    <task>  [升级重派 -> <role>，已打回 N 次]`

## 2. 回归测试

- [x] 2.1 改写编码旧语义的用例：第 2 次打回由 BLOCKED 改为升级重派
- [x] 2.2 新增 `SCEN-REC-16`：达到 `MAX_REJECTIONS` 时 `READY.escalate === true`、`role` 正确、`action.tasks` 形状不变、`action.escalations` 逐字段相等
- [x] 2.3 新增用例：第 3 次打回转 BLOCKED 并带预算耗尽原因
- [x] 2.4 新增负向对照：未达阈值任务不含 `escalate` 键、动作不含 `escalations` 键
- [x] 2.5 新增用例：`escalations` 只点名实际位于 `canDispatchNow` 的任务（cap=1、两个升级任务）

## 3. 文档与规范同步

- [x] 3.1 `SKILL.md` 重试预算段补执行载体说明（读 `reconcile` 输出、按 role 派发）
- [x] 3.2 `templates/lead.md` 新增「打回预算与升级重派」段落
- [x] 3.3 新增本 change 的 `specs/pipeline-delivery/spec.md` delta：relay 改为阻塞 `paseo wait` 并禁止 `send_agent_prompt` 推送路径；预算语义与升级目标写进 requirement

## 4. 验证

- [x] 4.1 `node --test skills/paseo-pipeline/test/reconcile.test.mjs` 全绿（采集：`tests 202 / pass 202 / fail 0 / duration_ms 116029.696834`）
- [x] 4.2 负向控制：把 `reconcile.mjs` 候选的 `escalate`/`role` 强制改回 `false`/`null` 后，`SCEN-REC-16` 9 条中 4 条转红（升级阈值、`canDispatchNow` 口径、`rejected`+`abandoned` 混合、rejected 分支 STALE），已从备份恢复
- [x] 4.3 全量回归 `bash skills/paseo-pipeline/test/run-all.sh`（须在仓库根目录执行），记录采集到的通过数（采集：Node `tests 410 / pass 410 / fail 0 / duration_ms 118691.305666`；`bash skills/paseo-pipeline/contract-check.test.sh` 采集：`通过 19 / 失败 0`）
- [x] 4.4 `openspec validate pipeline-wakeup-budget-alignment --strict` 通过（`Change 'pipeline-wakeup-budget-alignment' is valid`，4/4 产物）
- [x] 4.5 复核报告中 §3.10 的两条冲突与 §7 的第 6、7 项改为「已决并落地」

## 5. 归档（主会话执行）

- [x] 5.1 `openspec archive pipeline-wakeup-budget-alignment --yes`，确认 `openspec/specs/pipeline-delivery/spec.md` 已合并新文本
- [x] 5.2 归档后重跑 `docs.test.mjs`，确认无因 spec 文本变化而失效的断言
