## Why

2026-10-26 的 `hardening-governance-contracts`（12 任务、942 测试）暴露的不是规则太少，而是**门禁分层错误**：基于文本启发式的检查（`contract-check` 的消息抽取、`check-evidence` 的占位词正则）与保护 git 历史的合流门禁同属 exit≠0，于是误报直接卡住交付，执行者被迫为适配脚本而写 spec。同轮还有两处残留物没有使用者：`dispatch.mjs`（SKILL 明写「不参与正常流水线」）与 `run-state.mjs heartbeat`（该 change 的账本 `heartbeats` 为 0）。本轮把这些收敛掉，并把 spec 撰写规则写进冻结点，减少下一轮在冻结后才发现契约缺陷的概率。

## What Changes

- `check-evidence.mjs`：命令型字段（`acceptance_command`）只拒**整值**占位，不再按子串判通用词。删除 `LOST/UNKNOWN/TEST/NOT_COLLECTED` 对命令文本的误伤，占位专用词仍拦。
- `contract-check.mjs`：收窄提取面——删全局 `message:` 提取与 `newXError` 首参提取；`assert.throws/rejects` 第二实参为函数字面量或函数调用时不进消息通道；spec 侧一条 `Error("…")` 方言都解析不出时，消息通道报「不适用」并 exit 0，只对 SCEN 对账。**不加 CODE 通道**（实测会把 27 个大写反引号 token 全当错误码，误报换个方向）。
- **BREAKING** 删除 `skills/paseo-pipeline/dispatch.mjs` 及其测试：SKILL 已声明它是 legacy 兜底、不参与流水线，实际零使用。
- **BREAKING** 删除 `run-state.mjs heartbeat` 子命令与 `lib/run-state.mjs` 的 `heartbeatStatus`：账本 `heartbeats` 字段保留以兼容旧文件，但不再有写入入口。
- `SKILL.md` §2.1 写入 5 条 spec 撰写规则（环境独立、闭环 scope、一场景一承载、delta 先对基线、矩阵计数由命令生成）；`templates/lead.md` 增派发权限与 brief 事实来源两条。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `pipeline-delivery`：派发要求不再有 legacy 派发脚本；运行账本不再有 heartbeat 注册入口；证据与契约门禁改为「阻断 / 提示」两级，并新增冻结点的 spec 撰写规则要求。

## Impact

- 代码：`skills/paseo-pipeline/contract-check.mjs`、`test/check-evidence.mjs`、`run-state.mjs`、`lib/run-state.mjs`、`SKILL.md`、`LESSONS.md`、`templates/lead.md`、`test/run-all.sh`；删除 `dispatch.mjs`、`test/dispatch.test.mjs`。
- 测试：`contract-check.test.sh` 补 R20–R23，`test/check-evidence.test.mjs`、`test/run-state.test.mjs`、`test/docs.test.mjs` 同步。
- 兼容性：两个删除项均为零使用的 legacy 面；`run-state.json` 旧文件仍可读（`heartbeats` 字段被忽略）。
