#!/usr/bin/env bash
# LEGACY 兜底路径：原生 MCP 派发为默认（见 SKILL.md）。
# LEGACY: completion callback not verified for this path（paseo run --no-wait 未绑定父 agent 通知）。
# 仅用于 tasks.md 声明 `Review: mechanical` 的任务；strict 任务必须走正常 Auditor 流程，不得用本快轨。
# 合规小修快轨：主会话/Lead 不必自己改产品代码。
# 一条命令：新建 Paseo worktree 分支(task/<change>/<id>) → 派 qingqibing 按 brief 修 → 等完成 → merge-task 合流(含测试与记账)。
# 审计：默认记 review=pass(mechanical)；涉及 Risk-surface 的改动请改走正常 Auditor 流程，不要用本快轨。
#
# Usage: hotfix.sh <change> <task-id> <brief-file> <test-cmd>
# 在集成 workspace(integration/<change>)根目录运行，工作区须干净。
set -euo pipefail
CHANGE="${1:?change}"; TID="${2:?task-id}"; BRIEF="${3:?brief-file}"; TEST_CMD="${4:?test-cmd 必填（合流验证命令，缺省拒绝派发）}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRANCH="task/${CHANGE}/${TID}"
BASE="$(git rev-parse --abbrev-ref HEAD)"

[ -f "$BRIEF" ] || { echo "[hotfix] brief 不存在: $BRIEF" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "[hotfix] 工作区不干净，先提交或清理" >&2; exit 1; }

# 固定带上集成分支 HEAD，避免子 agent 读到旧快照（实测：Auditor 因分支 tasks.md 旧快照误判）
HEAD_SHA="$(git rev-parse --short HEAD)"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
{ cat "$BRIEF"; printf '\n\nConstraints: 基点为集成分支 %s@%s；只改 brief 列出的文件；完成后提交并保持工作区干净。\n' "$BASE" "$HEAD_SHA"; } > "$TMP"

TITLE="[Pipeline] Runner hotfix ${TID} ${CHANGE}"; TITLE="${TITLE:0:60}"
# 角色参数取自 dispatch.mjs 的 profile 解析，保证与 list_profiles 一致
# mode/thinking 缺省不发明默认值：读不到即输出 none 并省略对应参数；pi provider 不支持 --mode，一律省略。
read -r PROVIDER MODE THINK < <(node -e '
const c=require(process.env.HOME+"/.paseo/config.json");
const p=c.daemon.agentProfiles.find(x=>x.id==="agent_profile_qingqibing");
console.log(`${p.provider}/${p.model} ${p.modeId||"none"} ${p.thinkingOptionId||"none"}`)')

CLI=(run --no-wait -q --title "$TITLE" --provider "$PROVIDER")
if [[ "$PROVIDER" != pi* ]] && [ "$MODE" != "none" ]; then CLI+=(--mode "$MODE"); fi
if [ "$THINK" != "none" ]; then CLI+=(--thinking "$THINK"); fi
CLI+=(--new-workspace worktree --new-branch "$BRANCH" --base "$BASE")
CLI+=(--label "pipeline.change=${CHANGE}" --label "pipeline.role=qingqibing")

AGENT_ID="$(paseo "${CLI[@]}" "$(cat "$TMP")")"
echo "[hotfix] agent=$AGENT_ID branch=$BRANCH"
paseo wait "$AGENT_ID"

node "$DIR/merge-task.mjs" "$BRANCH" "$TID" "pass(mechanical)" "$TEST_CMD"
