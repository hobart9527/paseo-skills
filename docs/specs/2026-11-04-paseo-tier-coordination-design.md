# Paseo 与 Tier 路由协作优化设计

## 意图与目标
让本地运行规则准确表达 Paseo 完成通知与唤醒的边界，并为 Tier 2 的 handoff/worktree 选择提供最小判据；避免把通知误当可靠唤醒，也避免扩大现有编排体系。

## 非目标与约束
- 不修改 Paseo daemon、tool guard、Tier gate、profile 或 Tier 1/2/3 门槛。
- 不增加脚本、角色、定时任务或新的状态存储。
- 不发布 GitHub issue/comment；不 push、不合并、不清理分支/worktree。
- 保留 Git 为交付状态事实源、Paseo 为 agent/workspace transport 的原则。

## 方案
1. **只改项目内 Pipeline 文档**：最小，但不能解决 `~/.paseo/task-routing.md` 对完成回调的绝对化表述，也无法覆盖 Tier 2 路由。
2. **更新 Pipeline 文档与本机 task-routing 文档**（推荐）：只修改两处规则文案，分别明确通知不是唤醒保证，以及何时选择 handoff 或 worktree；不改变执行机制。
3. **加入 hook 或 gate 强制执行**：能增加约束，但超出本次 A 的文档优化范围，并引入新的误报与维护成本，因此不采用。

## 推荐方案细节
- 在 `~/.paseo/task-routing.md` 将“会注册完成回调”改成“会注册完成通知，但不保证唤醒 idle 父级”；明确应按 Paseo agent 状态和 Git 状态对账恢复，避免把 callback 当唯一推进信号。
- 在 `skills/paseo-pipeline/SKILL.md` 对齐同一通知语义，说明 `paseo wait` 是显式等待/恢复手段，不是通知可靠性的证明。
- 在 `~/.paseo/task-routing.md` 增加 Tier 2 判据：任务需要隔离 workspace、独立持续执行或可并行调查时选 worktree agent；任务可交给独立会话完成、无需当前会话同步推进时用 handoff。已有风险/共享契约规则优先，拿不准仍走 Tier 2。
- Tier 1/2/3 门槛、pipeline 调度与状态机制均保持不变。

## 验收
- 两份规则文档不再暗示 `notifyOnFinish` 保证唤醒 idle 父级。
- 明确区分“完成通知”与“对账/恢复”，且不声称 wait 提供可靠 watchdog。
- Tier 2 handoff/worktree 有可操作、无重叠的选择判据。
- Tier 1/2/3 入口门槛、Pipeline 角色、Git 状态原则未改变。
- diff 仅包含上述两份规则文档；无 hook、代码、配置或上游发布改动。
