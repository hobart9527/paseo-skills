## Context

`hardening-governance-contracts`（2026-10-26，12 任务 / 942 测试 / 39 场景）一次通过验收，但两个静态门禁在验收时全红，且全部是误报。这不是"规则不够严"，而是**门禁分级错误**：判断文本语义的启发式与保护 git 历史的门禁共用同一个 exit 码，于是误报直接卡住交付。同轮还有两处零使用残留物。

本 change 只做收敛，不新增检查层。

## Goals / Non-Goals

**Goals**

- 两个静态闸门的误报清零或收敛到真信号，且改动净减代码。
- 把"门禁按保护对象分级"写成可复用判据，供后续判断是否新增规则。
- 把这一轮冻结后返工的五条 spec 撰写规则落到冻结点，由 Auditor 核。
- 删除零使用残留物。

**Non-Goals**

- 不新增 CODE 通道、不新增 `freeze-check.mjs`。
- 不改 `merge-task.mjs` 的任何门禁、不改 `reconcile.mjs` 的状态机。
- 不给 `heartbeats` 字段做迁移（旧账本保持可读）。
- 不追求把误报降到 0（剩余 1 条是测试故意注入的探针，属真信号）。

## Decisions

### D1 门禁按"拦的是什么"分级，不按"能不能写成代码"分级

保护 git 历史与合流正确性的（写范围、依赖 DONE、固定 tip、非自审、写锁）留在 exit≠0；判断文本语义的（消息抽取、占位词、方言）改为提示或"不适用"。

**替代方案（否决）**：逐条修误报、保留 fail-closed。否决理由：误报会随仓库方言持续再生（本轮 11 条里 6 条来自同一类谓词回调），修完还会再来；而 fail-closed 的实际后果是执行者被逼着为过闸门写 spec 字面量，把门禁变成形式主义。

### D2 `check-evidence`：命令型字段走整值判据

字段名匹配 `(?:^|_)(?:command|cmd)$` 时，只拒"整值就是占位词"（含 `<template>` 形态）；其余按命令放行。

**替代方案（否决）**：只对 `acceptance_command` 豁免通用词子串。否决理由：实测仍误伤 `grep -q FOO .env.example`（EXAMPLE）、`npm run test:sample`（SAMPLE）、`pytest tests/test_todo_api.py`（TODO）——逐词豁免永远追不全。整值判据的代码更少且没有残留。

### D3 `contract-check`：三条收窄，不加通道

1. **谓词窗口不进消息通道**：第二实参形如函数字面量（`(err) => …`、`async … =>`）或函数调用（`helper(…)`，名字不以 `Error` 结尾）时，窗口整体跳过。实测这类窗口贡献 6/11 条误报。
2. **删全局提取**：全局 `message: "…"` 会收到桩的返回值（`{ message: 'ok' }`），全局 `new XError("…")` 会收到被断言的输入（`new MasterDataSyncError('CODE', …)`）。断言内的同样形态仍由窗口覆盖，覆盖面不变。
3. **方言不匹配报"不适用"**：spec 谈错误但一条 `Error("字面量")` 都没有时，消息通道打印 N/A 并放行，场景通道继续双向对账。

**替代方案（否决）**：新增 CODE 通道，按反引号声明做双向对账。否决理由：实测 spec 侧 27 个大写反引号 token 里只有 6 个被测试按 `.code` 断言，其余是状态值、环境变量、样例 ID——会立刻冒出约 21 条新误报，只能再加白名单，误报换个方向而已。

### D4 删除 `dispatch.mjs` 前必须先拆测试

`test/dispatch.test.mjs`（434 行）里同时承载 `hotfix.sh` 的 12 条用例（SCEN-DISP-04/05/06/08 与三条预检）。直接删会连带丢失 hotfix 的全部保护。顺序固定：先抽出 `test/hotfix.test.mjs` 并验证全绿（实测 17/17），再删脚本与旧测试，最后改 `run-all.sh`。

**替代方案（否决）**：保留 `dispatch.mjs` 作为"legacy 兜底"。否决理由：SKILL 自述它"不参与正常流水线"，留有第二条 CLI 派发入口会让 legacy 被当成可选主路径；而 `hotfix.sh` 已覆盖同一路径且自带 `paseo wait`。

### D5 heartbeat 子命令删除，字段保留只读

`heartbeats` 数组保留在 `lib/run-state.mjs` 的 normalize 与 `status` 输出里（旧账本仍可读），但删除 `heartbeatStatus` 与 CLI 分支。理由：注册入口零使用（该 change 账本 `heartbeats` 为 0），但旧文件不该因此读不出来。

### D6 spec 撰写规则由 Auditor 核，不写脚本

五条规则（环境独立、scope 闭环、一场景一承载、delta 先对基线、矩阵计数由命令生成）都是语义判据。脚本化的收益低于维护成本，且本轮已证明"为过脚本而写 spec"是真实的负激励。

**触发式升级**：同一类缺陷复发 ≥2 次时才考虑脚本化。T-09（Verify 依赖被 gitignore 的文件）目前只发生 1 次，因此只写规则。

## Risks

| 风险 | 缓解 |
|---|---|
| 删 `dispatch.mjs` 后 MCP 不可用时无 CLI 兜底 | `hotfix.sh` 覆盖同一 `paseo run` 路径；MCP 长期不可用属基础设施故障（见 LESSONS 中的 OAuth 记录），不靠第二个入口解决 |
| 方言 N/A 放行后，真 drift 可能漏过 | 场景通道仍双向对账；Spec 明确要求 N/A 时"不等于通过"字样必须打印；R23 用例锁住方言匹配时的真 drift |
| 整值判据放宽后，编造命令（如 `acceptance_command: run something`）能过 | 占位词本就只防"未采集伪装成采集"，不防语义错误的命令；命令是否真跑过由 sha 绑定与 `unverified` 判据承担 |
| 谓词识别是形态判断，可能漏掉包装形态 | 漏判只导致误报（回到旧行为），不会产生假通过；R20 锁定两种真实形态 |

## Migration

- 旧 `run-state.json` 带 `heartbeats` → 正常读取，`status` 照常打印，无写入入口。
- 依赖 `dispatch.mjs` 的外部脚本 → 无（该脚本从未被 SKILL 主路径引用）。
- `contract-check` 在错误码方言仓库上 rc 由 1 变 0 → 这是本 change 的目的；原 fail-closed 行为已无仓库依赖（approval-hub 基线的 undeclared 集合与本 change 逐字相同，证明它从未拦住真问题）。
