# 日常 Agent 团队

2026-11-20，方案 A：名称、职责、brief 与计划输出对齐。状态：仓库方案，**未应用到 live profiles**。`agent-profiles.json` 是待应用的 profile-only 配置片段，不是完整 `config.json`，不能覆盖整个配置。运行时仍以 `list_profiles` 为准。

## 五个日常入口，不是五个阶段

| 叫法 | 保留 ID 后缀 / 旧称 | 配置提案 | 交付边界 |
|---|---|---|---|
| 调研 | chanpin / 中书 | Antigravity + Hydrogen high | 有界问题、事实入口、选项与未验证项；不写产品代码 |
| 架构 | hanlin / 翰林 | Claude + cc（用户确认 Opus 5.5） | 必要契约与共享决策；不审自己的契约 |
| 开发 | gongbu / 工部 | Claude + flash（用户确认 DeepSeek Flash） | 普通任务独自拥有测试、实现与 Verify |
| 攻坚 | gaogong / 高工 | Codex + glm（用户确认 GLM-5.3） | 复杂实现、并发、状态机、有证据的返工；不自动重规划 |
| 审查 | anchasi / 按察司 | Codex + gpt（用户确认 GPT-6.1 Sol） | 实际目标的独立需求矩阵与固定基线审查 |

按需模式：
- **测试** `ceshi`：Codex + codex（用户确认 GPT-6.1 Luna），仅显式 strict / 独立先测请求。
- **界面（将作）** `jiangzuo`：Claude + kimi（用户确认 Kimi 3 Pro），有明确 UI 验收才专项选择。
- **协调（尚书）** `shangshu`：主会话默认承担；单开时提案为 Claude + meta（用户给定 Muse Spark 1.3）。此项是按供给讨论采用的默认建议，不是已验证的性能结论。
- **契约审查（Neon）**：复用旧“高级架构师”ID `agent_profile_mvvzv70y_bweu1x85oc9`，Antigravity + `gemini-4-neon-high`。R0 独立于实际契约作者；参与过 Proposal 时换审查者。Hydrogen 与 Neon 都声明 Google 家族，不能仅因不同名称宣称家族异构。
- 旧“问题排查专家”保留 ID，改为兼容入口，不删除、不自动派发，也不虚构已禁用状态。

普通任务只选一个实现负责人。角色数量不是交接数量。用户已明确保留工部 DeepSeek、高工 Codex + GLM，不因供给或响应慢改成 Muse / Opus；没有执行模型基准，也没有更换 CLI harness。

## 名称与启动

“调研一下”“架构看下”“开发这个”“攻坚这个”“审查这份”是沟通词汇，不是新 slash commands。旧称仍可映射到相同稳定 profile ID；`[Pipeline] gongbu T-01 <change>` 等标题、`Pipeline-Role` 和 `pipeline.change` 保持协议兼容。

R0 标题保留 `[Pipeline] hanlin R0`，实际选独立契约审查 profile；stage token 不等于 profile 身份。先 `list_profiles`，逐项复制 provider/model、modeId、thinkingOptionId 和 options 为 settings.features。省略未声明设置；同机不传 serverId。

notes 用来选角色，**不会自动注入实际任务 prompt**。派发必须粘贴对应 brief，并给 workspace、base SHA、scope、需求、可用接口和实际 Verify：
- 架构：`skills/paseo-pipeline/templates/author.md`
- 测试：`skills/paseo-pipeline/templates/tester.md`
- 开发 / 攻坚 / 界面：`skills/paseo-pipeline/templates/worker.md`
- Tier 3 审查：`skills/paseo-pipeline/templates/reviewer.md`
- Tier 2：`docs/tier2-handoff-brief.md`、`docs/tier2-reviewer-brief.md`；wrapper 为 `skills/tier2-handoff/SKILL.md`，不改 app 同步的 bundled `/paseo-handoff`。

## 测试的入口、交接与恢复

普通任务由实现者测试；`riskSurface` 单独不增加测试 agent。Tier 3 的 `Review: strict` 明确选择独立 Red；若既有结构规则要求 strict，作者必须说明它会增加测试阶段，不绕过校验。Tier 2 独立 Red 由请求明确选择。风险代码仍按全局规则要测试证据与一个 reviewer。

1. 作者给真实可用接口、明确测试路径与 Verify。测试路径不限于 `test/`；不发明未来 API，不改测试基础设施或产品代码。
2. plan 对 strict 新任务输出 `dispatch-tester`。测试者提交同一 task branch，交 Red SHA、实际命令、退出码、行为断言失败及失败原因。缺包、命令不存在、未完成接口的 import failure 都不是 Red。
3. 协调者核对证据，再按 plan 派实现者在同一分支转绿；不得弱化独立断言。提交 trailer 仅说明可进入下一阶段，不能证明断言质量或不可变性。
4. 测试运行中占用任务；停止但无提交时 `BLOCKED_TESTER_RESULT`，检查或恢复已有 agent，不重复派发、不跳过。新 attempt 不复用旧 attempt 的 Red；已有实现提交不追溯插入测试阶段。

状态仍由 Git refs、当前 attempt 提交、Done 与 Paseo 状态对账，没有新调度账本、服务或队列。plan 不验证 Red 质量；merge gate 也不强制独立模型或断言不可变。这些需 brief、交接检查与有限审查共同完成。

## 权限与独立性不作假

Claude `auto`、Codex `auto-review` 不等于只读；当前 Antigravity 为 full-access。worktree 隔离 Git 改动，不限制全文件系统。审查“不写”是任务要求；前后检查 HEAD、tracked diff、untracked files 只能检测变化，不阻止读取秘密、外部写或先改后还原。

`profiles-check.mjs` 只校验 notes 模板字段（`family/harness/write/use/not/brief`）、`brief:` 路径存在（`--root`）、稳定 ID、默认实现搭配的家族差异、Antigravity 的 diff-check 声明，并拒绝“纯只读/只读无写权限”类说法。测试与审查都用 OpenAI 可通过配置 lint，但不是相互独立的家族。对具体目标必须核对实际贡献者和审查者；profile 别名、notes、不同会话均非后端身份认证。检查复用 Neon R0 的额外 profile 由派发者负责，不因它不在固定 Roles 表就省略。

## 应用与回滚边界

官方支持在 [Settings → host → Agents → Agent profiles](https://paseo.sh/docs/agent-profiles.md) 保存配置；只影响未来启动的 agent，不更新已有会话。本次尚未查明 daemon 对本地配置的完整写回/覆盖语义，因此**未直接编辑 `~/.paseo/config.json`、未重启、未调用生产配置写接口**。

应用片段前，先核实受支持的保存方式并保留现有 profiles 的完整备份；只更新列出的 ID，保留其它 daemon 配置、其它 profiles 和未知字段。不要将本片段当作完整配置导入。保存后用 `list_profiles` 对照，再启动明确授权的窄任务验证；失败则通过相同受支持方式恢复备份。现有会话不作为新 profile 生效证据。

仓库自检：

```bash
node skills/paseo-pipeline/profiles-check.mjs --config docs/agent-profiles.json
node --test skills/paseo-pipeline/test/frontier.test.mjs skills/paseo-pipeline/test/profiles-check.test.mjs skills/paseo-pipeline/test/role-handoff-docs.test.mjs
openspec validate profiles-check --strict
bash skills/paseo-pipeline/test/run-all.sh
```
