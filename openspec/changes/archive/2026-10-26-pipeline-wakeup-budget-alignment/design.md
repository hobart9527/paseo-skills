## Context

动机见 `proposal.md` — Why。设计上要处理的现状约束有三条：

1. **打回预算已有单一所有者**：`skills/paseo-pipeline/lib/roles.mjs` 导出 `MAX_REJECTIONS` 与 `consumesRetryBudget()`，`reconcile.mjs:403` 用它数终态 agent 的 `rejected`/`abandoned`。预算的**计数口径**已经统一，缺的只是「第 N 次之后该派谁」这条**决策**，以及它的**执行载体**。
2. **`dispatch` 动作的公开形状已被下游消费**：`actions[].tasks` 是机器 ID 数组（`reconcile.mjs:698`），文本通道与 `NEXT/ALSO` 渲染都按这个形状走。任何破坏该形状的改动都会同时打断现有执行器与测试。
3. **spec 与文档对 relay 给出相反指令**：`openspec/specs/pipeline-delivery/spec.md` 要求 grandchild→Lead→parent 的 `send_agent_prompt` 交回，`SKILL.md:147,194,210-216` 明确写该路径结构上不通（主会话不是 Paseo agent）。这不是排版分歧，是两条互斥要求——执行者无论照哪边做都会违反另一边。

## Goals / Non-Goals

**Goals:**

- 把「2 次打回 + 升级 1 次 + 耗尽 BLOCKED」表达为**机器可读**的输出，让升级可被机械执行，而不是靠提示词自觉。
- 让 spec 与 SKILL 对 relay 的表述**只有一种**，且是已验证的那种（阻塞 `paseo wait`）。
- 保持 `dispatch.tasks` 的既有形状不变，新增信息以**可选字段**附着。
- 升级判定只有一个所有者，`reconcile` 只是消费者的消费者。

**Non-Goals:**

- 不改 `merge-task.mjs` 门禁、`run-state.mjs` 租约、证据闸门——本 change 不碰合流与账本。
- 不改 Paseo daemon 配置、profile notes、`~/.paseo/task-routing.md`：`gaogong` 是既有 profile，升级只是选它，不是新增角色。
- 不做自动升级到人类（`ESCALATE_HUMAN` 仍走仲裁路径），也不做多级升级链。
- 不改 `dispatch.mjs` / `hotfix.sh` 的 legacy 路径行为。

## Decisions

### D1：策略函数放 `lib/roles.mjs`，`reconcile` 只调用

`retryPolicy(rejections)` 返回 `{ allowed, escalate, role, rejections, reason? }`，与 `MAX_REJECTIONS` / `ESCALATION_ROLE` / `MAX_ESCALATED_RETRIES` 同文件。

**为什么**：`roles.mjs` 已经是角色归类、`DISPOSITION_EFFECT`、`consumesRetryBudget` 的单一所有者；把阈值和"下一步派谁"放两处，正是本 change 要消除的那类缺陷。`reconcile.mjs` 拿到的只是一次函数调用的结果，不能再自己数、自己判断。

**替代方案（已否决）**：在 `reconcile.mjs` 内联 `if (rejections >= 2) ...`。否决理由：`dispatch.mjs` 与 `hotfix.sh` 未来若需要同一语义，会各自复制一份，重现当前的多源冲突。

### D2：升级信息用**新增可选字段**，不改 `tasks` 形状

- `READY` 条目：未升级时不加任何字段（形状与今天逐字节相同）；升级时加 `escalate: true`、`role`、`rejections`。
- `dispatch` 动作：仅在确有升级任务时追加 `escalations: [{ task, role, rejections }]`，`tasks` 数组原样保留。
- `escalations` 只收录 `out.canDispatchNow` 内的任务（`reconcile.mjs:695`）——被 cap 或全局阻断压住的任务即使已到阈值也不出现在派发动作里，否则执行器会派出一个"不该现在派"的任务。

**为什么**：把角色塞进 `tasks`（例如改成对象数组）会让所有消费 `tasks` 的执行器与断言同时失效，收益只是少一个字段。可选字段的代价是执行器要"读了才用"，而不读的旧执行器最多退化为今天的原角色重派——**降级行为等于改前行为**，这是可接受的兼容边界。

**替代方案（已否决）**：用 `role` 覆盖 `READY.role`。否决理由：`READY` 条目的字段在测试里被整体断言，且语义上"任务原本的角色"与"本次应派发的角色"是两件事，合并会让审计看不出这是升级。

### D3：relay 走 spec 侧修订，而不是改文档去迎合 spec

通过本 change 的 MODIFIED requirement 把 spec 改成「Lead 阻塞 `paseo wait`，主会话从自己的 `paseo wait` 读信封」，并在同一 requirement 里**禁止**设计 `send_agent_prompt` 向父级推送的路径、写明原因。

**为什么**：文档侧是已实测的结论（`native-smoke.md`：孙 agent 06:06:15Z 完成，Lead 到 06:13:24Z 才被人工催动），spec 侧是未验证的设计假设。让已验证的一侧胜出。更重要的一点：原冲突的成因是包 C 直接编辑 `SKILL.md` 而没有对应 delta，spec 从未随之更新——把改动装进 change，归档时才会真正合并进 `openspec/specs/`，冲突不会以同样方式复发。

**替代方案（已否决）**：改 SKILL 去写 relay。否决理由：把结构上不可达的路径写回规程，等于要求执行者做一件做不到的事，且已有一次 FAIL 记录。

### D4：计数口径不变

升级态由 `rejections`（`rejected` + `abandoned` 的终态 agent 数）决定，与现状一致。`DISPOSITION_EFFECT=retry` 的含义不动。

**为什么**：`abandoned` 计入预算这一条是 2026-10-26 已确认的决策，本 change 只补"计满之后怎么办"，不重定义"怎么计"。

## Risks / Trade-offs

- [执行器忽略 `escalations`，升级形同虚设] → `SKILL.md:202` 与 `templates/lead.md` 的「打回预算与升级重派」段落把「必须按该 role 派发」写成硬要求；文本通道同步打印 `READY <task> [升级重派 -> gaogong，已打回 2 次]`，人工走查能看见。**这仍是提示词级约束，不是工具级强制**——与 SKILL 第 8 节的既有立场一致，不声称能物理封死。
- [升级后仍打回，任务停在 BLOCKED 而人类没注意] → 沿用既有失败处置：保留 workspace 与运行账本，`reason` 明确写「须人类裁决是否继续」，作为 `NEXT arbitrate` 暴露。
- [spec 修订在归档前不生效] → change 未归档时 `openspec/specs/` 仍是旧文本，`docs.test.mjs` 不读 `openspec/specs/`，因此不会有测试因此变红。这是已知的时间窗；归档（主会话执行）后闭合。
- [可选字段被误当作必有] → 负向对照用例断言：未达阈值的任务 `READY` 条目**不含** `escalate` 键、`dispatch` 动作**不含** `escalations` 键。

## Migration Plan

1. `lib/roles.mjs` 新增常量与 `retryPolicy()`（纯新增，不动既有导出）。
2. `reconcile.mjs` 改调用点：预算判定、`READY` 条目、`dispatch` 动作、文本输出。
3. 同步 `SKILL.md:200-202` 与 `templates/lead.md` 的执行载体说明。
4. 回归：`reconcile.test.mjs` 中编码旧语义的 3 个用例改写为新语义，另加 4 个正/负向用例。
5. 回滚 = 反向恢复上述文件；无数据迁移、无 schema 变更、无持久化格式变化（`run-state.json` 不新增字段）。

## Open Questions

无。升级链只做一级、阈值取 `MAX_REJECTIONS` 字面值、不引入配置项——这三条若将来要改，改的是 `lib/roles.mjs` 一处，不影响本 change 的 spec 表述（spec 用 `MAX_REJECTIONS` 符号而非数字）。
