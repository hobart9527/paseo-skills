#!/usr/bin/env bash
# 兼容包装：唯一 CLI 派发入口是 `task-runner.mjs`，本脚本只做「参数校验 + 派发前机械拒绝 +
# 透传退出码」，自身不含任何派发调用（profile 解析、分支/attempt 推导、意图记账与合流全在
# `task-runner.mjs` 里，两处各写一套正是本 change 要消灭的漂移源）。
# LEGACY: completion callback not verified for this path（CLI 派发通路，见 task-runner.mjs）。
# 仅用于 tasks.md 显式声明 `Review: mechanical` 且无 Risk-surface 的任务；
# strict/standard 任务必须走正常 Auditor 流程，不得用本快轨。
#
# Usage: hotfix.sh <change> <task-id> <brief-file> <test-cmd>
# 在集成 workspace(integration/<change>)根目录运行，工作区须干净。
#
# 契约真源在 tasks.md：写手 brief 由 `task-runner.mjs` 从冻结任务字段生成，合流验证命令取
# 任务的 `Verify with`。`<brief-file>` 与 `<test-cmd>` 保留为兼容旧调用形态的必填位置参数，
# 校验后**不再透传**——把它们拼进 prompt / 传给 merge 等于引入第二份契约。
#
# 历史缺陷（已修，勿回退）：
#   - 未在派发前校验 mechanical/Risk-surface → strict 任务可以从小修快轨绕过审计；
#   - 旧实现自带 profile 解析、CLI argv 组装与 claim/record，与 task-runner 形成双份逻辑。
set -euo pipefail
CHANGE="${1:?change}"; TID="${2:?task-id}"; BRIEF="${3:?brief-file}"
: "${4:?test-cmd 必填（兼容旧调用形态；契约真源是 tasks.md 的 Verify with）}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ -f "$BRIEF" ] || { echo "[hotfix] brief 不存在: $BRIEF" >&2; exit 1; }
# change 名必须是位置参数形态：`hotfix.sh --change foo T-1 ...` 会把 `--change` 当成 change
# 名，建出 `task/--change/T-1` 这样的分支、写进 `openspec/changes/--change/`（实测同类误用在
# run-state 里留下过 `--change/` 游离账本）。不猜意图，直接拒绝。
node --input-type=module -e '
const [skillDir, value] = process.argv.slice(1);
const { changeIdProblem } = await import(new URL(`file://${skillDir}/lib/change-id.mjs`).href);
const problem = changeIdProblem(value);
if (problem) { console.error(`[hotfix] ${problem}\n正确写法：hotfix.sh <change> <task-id> <brief-file> <test-cmd>`); process.exit(1); }
' "$DIR" "$CHANGE"
[ -z "$(git status --porcelain)" ] || { echo "[hotfix] 工作区不干净，先提交或清理" >&2; exit 1; }

# --- 派发前机械校验：mechanical 档与风险面（不得靠提示词自觉） ---
# 必须在委托之前生效：hotfix 入口的契约是 mechanical-only，非 mechanical 只能由调用方显式
# 走 task-runner 并接受审计，不得「先派发再等下游 exit 50」。
TASKS_FILE="openspec/changes/${CHANGE}/tasks.md"
[ -f "$TASKS_FILE" ] || { echo "[hotfix] 找不到 $TASKS_FILE" >&2; exit 1; }
node --input-type=module -e '
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const [skillDir, file, taskId] = process.argv.slice(1);
const { parseTasks, graphErrors, taskErrorsFor } = await import(pathToFileURL(`${skillDir}/lib/tasks.mjs`).href);
const { tasks, errors } = parseTasks(fs.readFileSync(file, "utf8"));
// 严重度归属由 lib/tasks.mjs 单点定义：graph 类错误让整份文件不可信，
// 另外本任务自身的 task 级错误也必须拦（快轨只允一个任务，别的任务的问题与它无关）。
// 旧实现硬写 `code !== "MISSING_SCOPE"` 单独放过一种错误，没有理由也没有记录。
const fatal = [...graphErrors(errors), ...taskErrorsFor(errors, taskId)];
if (fatal.length) {
  console.error(`[hotfix] tasks 解析失败: ${fatal.map((e) => `${e.code}: ${e.message}`).join("; ")}`);
  process.exit(1);
}
const task = tasks.find((t) => t.id === taskId);
if (!task) { console.error(`[hotfix] tasks.md 中没有 ${taskId}`); process.exit(1); }
if (task.review !== "mechanical") {
  console.error(`[hotfix] ${taskId} 的 Review=${task.review ?? "(未声明)"}，小修快轨只允许 Review: mechanical`);
  process.exit(1);
}
if (task.risk.some((token) => token !== "none")) {
  console.error(`[hotfix] ${taskId} 含 Risk-surface [${task.risk.join(", ")}]，必须走正常 Auditor 审查，禁止快轨`);
  process.exit(1);
}
console.log(`[hotfix] 预检通过: ${taskId} Review=mechanical Risk=none scope=${task.scope.join(",")}`);
' "$DIR" "$TASKS_FILE" "$TID"

echo "[hotfix] LEGACY: completion callback not verified for this path (delegated to task-runner.mjs)." >&2

# 委托唯一派发入口：分支/attempt、五标签、profile fail-closed、claim/record/fail 与合流
# 都由 task-runner 执行。`exec` 让退出码原样透传（含非 mechanical 的 exit 50、合流冲突的 10）。
exec node "$DIR/task-runner.mjs" "$CHANGE" "$TID"
