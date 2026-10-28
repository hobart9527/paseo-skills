# Tester brief：<change> / <task>（attempt <n>，仅 `Review: strict`）

你是本任务的测试先行者（`Pipeline-Role: ceshi`）。工作目录见末尾。
**先写 Red 测试，不实现**——测试必须因「功能不存在」而失败，不是因语法错误而失败。

## 目标

- 任务：<一句话说明要固定的行为>
- 场景：读 `openspec/changes/<change>/specs/<spec>.md` 里的 `SCEN-*`，每个场景至少一条断言。
- 数学类任务：写差分对拍或小定义域穷举，不写浮点误差界（误差界考察的是写 spec 的能力，不是验证能力）。
- **断言对准 Seam 行为**：测试必须断言公共接口行为与不变式，不对准私有实现细节，保证重构不碎。
- **确定性轻量反馈环（Tight Red Loop）**：测试必须确定（无随机、无时序竞争、无外网），尽量秒级返回；失败必须清晰指示「功能缺失」而非执行期环境崩溃。

## 边界

- base SHA：`<base-sha>`（勿 rebase、勿 merge 主干）
- Write scope（精确列表）：
  - `<test/a.test.mjs>`
- Verify 命令（与 `tasks.md` 的 `Verify with` 一致）：`<verify-command>`
  Red 判据：它现在**必须失败**，并把失败输出贴进信封的 `red_output`。

## 爆炸半径扫雷（Blast Radius Sweep，必做）

写新测试前先 `rg` 全局扫描本任务要改的枚举/契约在老测试里的断言引用：

```bash
rg -n '<要改的符号>' --glob '!node_modules'
```

发现破坏性断言就写进信封的 `conflicting_tests`，并说明需要把哪些老测试纳入 `Write scope`。
**不要在测试里迁就旧断言**——那会把 spec 冲突伪装成实现问题。

## 提交

```
Pipeline-Role: ceshi
Pipeline-Author: <你的 agent id>
```

## 信封（≤20 行）

```
kind: phase-complete | blocked
task: <task>
attempt: <n>
phase: test
result: <一句话>
reviewed_sha: <你的提交 sha>
red_output: <失败输出的关键几行，证明是「功能缺失」而非语法错误>
conflicting_tests: <需要同步迁移的老测试；无则 none>
blockers: <无则 none>
next_action: impl | blocked
```
