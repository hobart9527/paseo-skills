## Why

Pipeline 规范层与执行层对同一件事给出相反指令，执行者无法同时遵守：spec 要求 Lead 用 `send_agent_prompt` 把信封推给父会话，而指导文档明确说这条路结构上不通（主会话不是 Paseo agent）；文档承诺「打回 2 轮 + 升级高工 1 次」，代码却在第 2 次打回即判 BLOCKED 且完全没有升级路径。前者让唤醒链的已验证结论无法进入规范，后者让「换更深模型再试一次」成为一句没有执行载体的承诺。两者都是规范语义问题，只能由人类裁决方向，然后由本 change 把裁决同时落到 spec 与代码两侧。

## What Changes

- 修改 `pipeline-delivery` 的 relay 要求：把「Lead 回合结束前必须用 `send_agent_prompt` 向父级交回」改为「Lead 回合不结束，前台阻塞 `paseo wait`；主会话从自己的 `paseo wait` 读取最终信封」。移除对 grandchild→Lead→parent relay rule 的强制要求，改为禁止该路径并说明其原因（主会话不在 agent 图内）。
- 新增打回预算的升级语义：`rejections` 0–1 按原角色重派；等于 `MAX_REJECTIONS`（2）时升级改派 `ESCALATION_ROLE`（gaogong）一次；再被拒即 BLOCKED 交人类裁决。`reconcile` 的 `READY` 输出在升级重派时携带 `escalate`/`role`/`rejections`，`dispatch` 动作附带 `escalations` 数组，文本通道同步输出。
- 更新 `SKILL.md` 与 `templates/lead.md`，使「升级高工」不再是纯提示词要求：执行器从 `reconcile` 输出读取升级目标角色。
- 补充回归测试：第 2 次打回进入升级态（而非 BLOCKED）、第 3 次才 BLOCKED、升级仅对 `canDispatchNow` 内任务生效、未升级任务输出形状不变（负向对照）。

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `pipeline-delivery`: 变更「Event-driven operation, relay and permission discipline」中的 relay 交回方式（改为主动等待，删除 `send_agent_prompt` 强制），并在打回预算部分明确「2 次打回 + 1 次升级重派」的计数语义与机器可读的升级目标。

## Impact

- `openspec/specs/pipeline-delivery/spec.md`（经本 change 归档时合并）
- `skills/paseo-pipeline/lib/roles.mjs`：新增 `retryPolicy()` / `ESCALATION_ROLE` / `MAX_ESCALATED_RETRIES`
- `skills/paseo-pipeline/reconcile.mjs`：预算判定改走 `retryPolicy`，`READY` 与 `dispatch` 动作携带升级信息
- `skills/paseo-pipeline/SKILL.md`、`skills/paseo-pipeline/templates/lead.md`：预算语义与执行载体
- `skills/paseo-pipeline/test/reconcile.test.mjs`：升级路径正负向用例
- 不涉及：Paseo daemon 配置、profile notes、`~/.paseo/task-routing.md`、paseo-ui、approval-hub
