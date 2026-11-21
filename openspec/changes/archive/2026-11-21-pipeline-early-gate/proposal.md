# Proposal: pipeline-early-gate

## Why

D10 交付（2026-11-19）暴露了三处契约与实现脱节，每一处都在事后才被发现：

1. **角色表与识别代码不一致**。`SKILL.md` 列出八个角色（含尚书 `shangshu`），但 `next-actions.mjs` 的非 worker 角色正则不认识它，一个 `[Pipeline] shangshu FULL` 的 agent 在标题检查处直接 exit 3。
2. **审查者重复跑基线**。`templates/reviewer.md` 与 `templates/author.md` 都要求跑同一遍 sink 的 Verify 基线，一个 package 里跑了两遍。
3. **派发参数与 profile 脱节**。`create_agent` 的 `modeId`/`thinkingOptionId`/`features` 抄错或漏传时静默跑在错误配置下；更糟的是，会话 provider 与被派发 provider 不同时，省略 `modeId` 会直接被 Paseo 拒绝（`cannot inherit mode 'auto' from caller`），而 hook 的旧拒绝文案恰好建议“省略以继承”。

这三条都属于「契约写了、代码没跟」或「代码对了、没人守」的同一类问题：管线跑绿了，但下一次同样的坑还会踩。

## What Changes

- **角色表与识别代码保持同步**：`next-actions.mjs` 的非 worker 角色集合与 `SKILL.md` 的 `## Roles` 表一致，并有测试双向断言。
- **审查者读取作者记录的基线**：`reviewer.md` 不再要求自己跑一遍 sink Verify，改为读作者 `## Baseline` 的记录。
- **派发参数对齐 profile**：`tool-guard-hook.mjs` 校验 `create_agent` 的 `modeId`/`thinkingOptionId`/`features` 与匹配 profile 一致；省略或被置 `null` 时从 profile 填入 `modeId`，跨 provider 派发不再触发服务端拒绝。

**不改**：`freeze-check` 的 staged 硬决策门与 scenario Verify 规则（属 `pipeline-decision-gate` 变更）；profile 本身的内容；Paseo 的继承语义（只在本方适配）。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `pipeline-delivery`: 角色识别、审查基线来源、派发运行时参数三条需求收紧。

## Impact

`skills/paseo-pipeline/next-actions.mjs`、`skills/paseo-pipeline/templates/reviewer.md`、`skills/paseo-pipeline/hooks/tool-guard-hook.mjs` 及其对应测试。不新增表、队列、服务或外部写入；Git 仍是交付状态。

## Baseline

- `skills/paseo-pipeline/SKILL.md:34`: `## Roles` 表列出尚书 `shangshu`，而 `skills/paseo-pipeline/next-actions.mjs:247` 的非 worker 正则不含它，`shangshu` 阶段标题在标题检查处 exit 3。
- `skills/paseo-pipeline/templates/reviewer.md:19` 与 `skills/paseo-pipeline/templates/author.md:50`: 两份 brief 都要求跑同一遍 sink Verify 基线，一个 package 跑了两遍。
- `skills/paseo-pipeline/hooks/tool-guard-hook.mjs:85`: `SETTINGS` 只声明了三个字段，`settingsMismatchReason` 仅在调用显式声明字段时比较；省略时（`:95` 的 `stated.length === 0`）直接放行，而 Paseo 在跨 provider 时会拒绝该省略。同文件 `:106` 的拒绝文案建议 `Omit modeId to inherit`，正是那个会被服务端拒绝的调用。
