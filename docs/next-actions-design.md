# `next-actions.mjs` — 确定性调度输出（设计草案，未实现）

状态：设计待确认。本文不含代码。

## 问题

Frontier 计算、容量上限、卡住判定目前写在 `templates/lead.md` 的散文里，由长寿命 Lead（LLM）每轮重新推算。
- 贵：approval-hub 实例里 `shangshu` 单会话累计约 738k 输入 token。
- 漂移：同一状态，不同轮次可能得出不同"可派发集合"。
- 压缩后恢复靠 Lead 重读三处状态再心算（`SKILL.md` 压缩恢复一节）。

## 目标与非目标

目标：给 Lead 一条只读命令，输出**确定的**下一步清单。Lead 只执行清单，不做集合运算。

非目标：
- 不派发、不合并、不改任何文件、不写 ledger（`SKILL.md` 原则 5：Git 是状态，Paseo 是调度器）。
- 不替代 `merge-task.mjs` 的门禁。
- 不做成本预测。

## 接口

```
node "$PIPELINE_HOME"/next-actions.mjs <change> [--json] [--writer-cap 4] [--auditor-cap 2]
```

在 `integration/<change>` 的 worktree 内运行。退出码：0 正常（含"无事可做"）；2 用法；3 无法读取 Git 或 Paseo 状态（fail closed，不猜）。

## 输入（均为只读）

| 来源 | 内容 | 用途 |
|---|---|---|
| `openspec/changes/<change>/tasks.md` | 任务、依赖、scope、`Review:` | 图与 Done |
| `git branch --list 'task/<change>/*'`，`git log <integration>..<branch>` | 每个任务分支的存在、提交、trailer 角色 | 判断阶段 |
| `paseo ls --label pipeline.change=<change> --json` | 子 agent 状态、`role`/`task` 标签 | 容量、卡住 |
| `paseo inspect <id> --json` | `PendingPermissions`、`LastUsage` | 卡住原因、花费 |

已实测（Paseo 0.14.0）：`paseo ls --label k=v --json` 能过滤，但返回对象只有 `created/cwd/id/name/provider/shortId/status/thinking`，**不含 `labels`**。所以任务与角色不能从 JSON 读出。可行做法：对每个任务各发一次 `--label pipeline.task=<T-id>` 过滤（N 次调用），或解析 `name`（`[Pipeline] gaogong T-06`，依赖命名约定，较脆）。倾向前者，并把"标签键名"定为 `lead.md` 里的硬约定。这也是未决问题 6。

复用 `lib/tasks.mjs`（解析、`computeWaves`、scope 重叠）与 `lib/paseo-agents.mjs`。不引入新解析器。

## 任务阶段（由 Git + Paseo 推出，不存储）

```
DONE            tasks.md 有 Done 行
MERGE_READY     分支 tip 已绑定 pass(...) 且无运行中 agent        <- 仅当 tip 含 reviewer 记录时成立；见下
IN_REVIEW       有运行中的 reviewer
IN_IMPL         有运行中的实现 agent，或分支已有 Red 提交且无实现提交
IN_RED          有运行中的 ceshi，或分支无任何提交
READY           依赖全 Done，scope 与所有非 DONE 任务不重叠，无分支
BLOCKED_DEP     依赖未 Done
BLOCKED_ATTEMPTS 已有 3 个尝试分支（与 lead.md 熔断一致）
```

`pass(...)` 评审标签不存在于 Git，只在 Lead 的上下文里。因此 `MERGE_READY` 不能由脚本推出；脚本只报 `AWAIT_REVIEW_RESULT`，由 Lead 读 reviewer 结果后自己调用 `merge-task`。这是设计上的缺口，见"未决问题 1"。

## 输出（`--json`）

```json
{
  "change": "…", "integrationHead": "<sha>",
  "capacity": { "writers": {"used": 2, "cap": 4}, "auditors": {"used": 0, "cap": 2} },
  "dispatch": [ { "task": "T-03", "action": "create-branch+dispatch-ceshi", "reason": "deps T-01 done; scope disjoint" } ],
  "merge": [],
  "attention": [ { "task": "T-02", "agent": "7be27a1", "kind": "PENDING_PERMISSION" } ],
  "waiting": [ { "task": "T-04", "on": "T-02,T-03" } ],
  "done": ["T-01"]
}
```

排序规则必须确定：先按关键路径长度降序，再按任务 ID。这是比散文更实质的收益：优先放行关键路径上的任务，缩短总时长。

## `attention` 判定

- `PENDING_PERMISSION`：`paseo inspect` 的 `PendingPermissions` 非空。
- `IDLE_NO_RESULT`：agent 空闲、分支 tip 自上次观察无变化。需要"上次观察"，而我们没有 ledger，所以只能用 agent `UpdatedAt` 与阈值比较（默认 15 分钟）。阈值是启发式，需标注。
- `STALE_LABEL`：agent 标签的任务在 `tasks.md` 中不存在。

## 为什么不会越权

- 全部只读；不调用 `paseo create/send/kill`，不调用 `merge-task`。
- 它不是"自定义 agent runner"，`SKILL.md` 原则 5 不变：输出是对 Git/Paseo 的查询视图，丢了可重算。
- 输出是建议；Lead 仍对每次派发负责，`merge-task` 仍是唯一合并入口。

## 测试方案

用现有 e2e 的假 `paseo` 夹具，构造 5 种图状态，断言 `dispatch/waiting/attention` 的**精确**输出：
1. 刚 CP-1：只有 wave 1 任务可派发。
2. 菱形，T-02 完成、T-03 进行中：T-04 仍在 `waiting`。
3. 容量满（4 个 writer）：`dispatch` 为空，`reason` 为容量。
4. 已有 3 个尝试分支：`BLOCKED_ATTEMPTS`。
5. Paseo 不可达：退出 3，不输出猜测。

另加一个性质测试：对同一输入多次运行，输出逐字节相同。

## 未决问题（需你决定）

1. **评审结果不在 Git 里。** `MERGE_READY` 无法推出。选项：(a) 接受缺口，脚本只到 `AWAIT_REVIEW_RESULT`；(b) 要求 reviewer 把 `pass(...)` 作为带 trailer 的空提交落到任务分支（改 `reviewer.md`，会破坏"审查者零写入"）；(c) Lead 把评审结果写进 `run-log.md`（`merge-task` 已追加该文件，但那是合并后）。倾向 (a)。
2. **`IDLE_NO_RESULT` 的阈值**和"上次观察"：是否接受仅用 `UpdatedAt` 的启发式。
3. **关键路径优先**是否要做成默认。它改变现有"先到先派"行为。
4. **放哪里运行**：Lead 每轮必跑，还是仅在压缩恢复和通知后跑。后者省 token，前者更稳。
5. 是否同时输出成本汇总（读 `LastUsage`），与 `lead.md` 熔断对齐。注意 `LastUsage` 在我实测的一个 agent 上全为 0，需先确认 Paseo 何时填充。

6. **标签键名未在仓库里约定。** `lead.md` 只说"task/change/role labels"，没写键名；实测只见 `pipeline.change`。需先固定 `pipeline.task`、`pipeline.role` 等键，否则 `next-actions` 无从过滤。

## 建议的落地顺序

1. 先定未决问题 1、3。
2. 抽出 `lib/frontier.mjs`（纯函数：图 + 状态 → 清单），先写它的测试。
3. 再写 CLI 薄壳与 Paseo/Git 读取。
4. 最后改 `lead.md`：把"Frontier dispatch"一节改为"运行 `next-actions` 并执行其 `dispatch`"，散文规则只保留不变式。
