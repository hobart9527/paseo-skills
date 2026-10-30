#!/usr/bin/env bash
# LEGACY 兜底路径：原生 MCP 派发为默认（见 SKILL.md）。
# LEGACY: completion callback not verified for this path（paseo run --no-wait 未绑定父 agent 通知）。
# 仅用于 tasks.md 显式声明 `Review: mechanical` 且无 Risk-surface 的任务；
# strict/standard 任务必须走正常 Auditor 流程，不得用本快轨。
#
# 一条命令：派 gongbu 在 worktree 按 brief 修 → 等完成 → 用真实 tip/base 生成 review 标签 → merge-task 合流。
#
# Usage: hotfix.sh <change> <task-id> <brief-file> <test-cmd>
# 在集成 workspace(integration/<change>)根目录运行，工作区须干净。
#
# 历史缺陷（已修，勿回退）：
#   - 标签缺 task/attempt/phase → reconcile 无法归属，agent 被判定为 UNMAPPED 或永久冻结派发；
#   - 未在派发前校验 mechanical/Risk-surface → strict 任务可以从小修快轨绕过审计；
#   - 末端写死 `pass(mechanical)` → 不符合 merge-task 的 `pass(<reviewer>@<tip7>/<base7>)` 契约，
#     正常路径必然被拒绝，只有手工绕过才用得下去。
set -euo pipefail
CHANGE="${1:?change}"; TID="${2:?task-id}"; BRIEF="${3:?brief-file}"; TEST_CMD="${4:?test-cmd 必填（合流验证命令，缺省拒绝派发）}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRANCH="task/${CHANGE}/${TID}"
BASE="$(git rev-parse --abbrev-ref HEAD)"

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

echo "[hotfix] LEGACY: completion callback not verified for this path (paseo run --no-wait)." >&2

# 固定带上集成分支 HEAD，避免子 agent 读到旧快照（实测：Auditor 因分支 tasks.md 旧快照误判）
BASE_SHA="$(git rev-parse --short HEAD)"
# 已存在的尝试 = 基分支（第 1 次派发）+ 全部 `-aN` 分支（第 2..N 次）。
# 只数 `-aN` 会让第二次派发改算出 ATTEMPT=1，撞上已存在的基分支后创建失败（历史缺陷，勿回退）。
EXISTING=0
if git show-ref --verify --quiet "refs/heads/${BRANCH}"; then EXISTING=1; fi
EXISTING="$((EXISTING + $(git for-each-ref --format='%(refname:short)' "refs/heads/${BRANCH}-a*" | wc -l | tr -d ' ')))"
ATTEMPT="$((EXISTING + 1))"
# 不得写成 "${BRANCH}$([ ... ] && echo ...)"：ATTEMPT=1 时子命令退出码为 1，
# 在 set -e 下会让脚本在此静默退出（历史缺陷，勿回退）。
BRANCH_WITH_ATTEMPT="$BRANCH"
if [ "$ATTEMPT" -gt 1 ]; then BRANCH_WITH_ATTEMPT="${BRANCH}-a${ATTEMPT}"; fi

TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
{ cat "$BRIEF"; printf '\n\nConstraints: 基点为集成分支 %s@%s；只改 brief 列出的文件；完成后提交并保持工作区干净。\n' "$BASE" "$BASE_SHA"; } > "$TMP"

TITLE="[Pipeline] Runner hotfix ${TID} ${CHANGE}"; TITLE="${TITLE:0:60}"
# 角色参数取自 ~/.paseo/config.json 的 agent profile，保证与 list_profiles 一致
# mode/thinking 缺省不发明默认值：读不到即输出 none 并省略对应参数；pi provider 不支持 --mode，一律省略。
# profile 解析必须 fail-closed：找不到时旧的 `p.provider` 抛错被 `< <(...)` 吞掉，
# PROVIDER 变成空串，`paseo run --provider ""` 照常发出——派发出去却没人能完成。
# 这里显式校验非空与非 none，读不到就拒绝派发，绝不发空 provider。
# 只认 gongbu：`agent_profile_qingqibing` 不是一个角色来源，只是历史标签的遗留名，
# 用它做兜底会让「profile 没配好」静默降级成「换了个写手角色」。
PROFILE_LINE="$(node -e '
const fs=require("node:fs");
const file=process.env.HOME+"/.paseo/config.json";
if(!fs.existsSync(file)){console.error("[hotfix] 找不到 "+file);process.exit(1);}
const c=JSON.parse(fs.readFileSync(file,"utf8"));
const profiles=c?.daemon?.agentProfiles ?? [];
const p=profiles.find(x=>x.id==="agent_profile_gongbu");
if(!p){console.error("[hotfix] config.json 中无 agent_profile_gongbu");process.exit(1);}
if(!p.provider||!p.model){console.error("[hotfix] profile "+p.id+" 缺 provider/model");process.exit(1);}
console.log(`${p.provider}/${p.model} ${p.modeId||"none"} ${p.thinkingOptionId||"none"}`)')" || exit 1
read -r PROVIDER MODE THINK <<< "$PROFILE_LINE"
[ -n "${PROVIDER:-}" ] && [ "$PROVIDER" != "none/" ] || {
  echo "[hotfix] profile 解析为空，拒绝以空 provider 派发" >&2; exit 1; }

CLI=(run --no-wait -q --title "$TITLE" --provider "$PROVIDER")
if [[ "$PROVIDER" != pi* ]] && [ "$MODE" != "none" ]; then CLI+=(--mode "$MODE"); fi
if [ "$THINK" != "none" ]; then CLI+=(--thinking "$THINK"); fi
CLI+=(--new-workspace worktree --new-branch "$BRANCH_WITH_ATTEMPT" --base "$BASE")
# 五个身份标签缺一不可：reconcile 依赖它们做归属、cap 计数与 phase 排序。
CLI+=(--label "pipeline.change=${CHANGE}" --label "pipeline.role=gongbu"
      --label "pipeline.task=${TID}" --label "pipeline.attempt=${ATTEMPT}" --label "pipeline.phase=impl")

# --- 意图记账（与正常路径同一护栏，见 SKILL.md §4）：派发前 claim、拿到 agent 后 record ---
# 旧实现完全不做：意图护栏对 hotfix 派发失明，创建在途窗口会被再派一次。
# 账本在 git common dir（不弄脏工作树）。无租约时 claim 直接生效；存在有效编排租约时
# hotfix 不带 --owner 会被拒（exit 2）——这是预期：编排进行中不得走旁路快轨（SKILL.md §1）。
CLAIM_JSON="$(node "$DIR/run-state.mjs" claim "$CHANGE" --task "$TID" --attempt "$ATTEMPT" --phase impl --role gongbu --json)" || {
  echo "[hotfix] 意图认领失败，中止派发（重复意图、租约拒绝或账本被占用）" >&2; exit 1; }
CLAIM_KEY="$(node -e '
let raw="";process.stdin.on("data",(c)=>raw+=c).on("end",()=>{
  const intent=JSON.parse(raw).intent;
  if(!intent||typeof intent.key!=="string"){console.error("[hotfix] claim 回执缺少 intent.key");process.exit(1);}
  console.log(intent.key);
});' <<< "$CLAIM_JSON")" || exit 1

if ! AGENT_ID="$(paseo "${CLI[@]}" "$(cat "$TMP")")"; then
  # 派发动作失败：显式作废意图，否则未回执意图会挡住后续重派（重复意图 exit 2）。
  node "$DIR/run-state.mjs" fail "$CHANGE" --key "$CLAIM_KEY" --reason "paseo run 非零退出" >&2 || true
  echo "[hotfix] paseo run 失败，意图已作废: $CLAIM_KEY" >&2; exit 1
fi
# 回执必须登记真实 agent：回执丢失会让 reconcile 判 INTENT_PENDING 并冻结重派。
# record 失败属账本异常，硬失败并提示人工补登记，不得静默继续（否则护栏再次失明）。
node "$DIR/run-state.mjs" record "$CHANGE" --key "$CLAIM_KEY" --agent "$AGENT_ID" || {
  echo "[hotfix] 意图回执失败（agent 已派发: $AGENT_ID）；人工执行: node $DIR/run-state.mjs record $CHANGE --key '$CLAIM_KEY' --agent '$AGENT_ID'" >&2; exit 1; }
echo "[hotfix] agent=$AGENT_ID branch=$BRANCH_WITH_ATTEMPT attempt=$ATTEMPT intent=$CLAIM_KEY"
paseo wait "$AGENT_ID"

# review 标签必须绑定真实 tip 与真实 base：merge-task 会逐字段校验，
# 旧实现写死 pass(mechanical) 在正常路径上必然被拒。
#
# 用完整 SHA 截前 7 位，不用 `git rev-parse --short=7`：后者遇到前缀歧义会**自动加长**
# （输出 8 位甚至更多），而 merge-task 的 review 正则与 tip 比对都只接受恰好 7 位，
# 于是「有歧义的仓库」里 hotfix 生成合法标签却必然被拒，且报错指向标签格式而非歧义本身。
TIP_FULL="$(git rev-parse --verify "refs/heads/${BRANCH_WITH_ATTEMPT}^{commit}" 2>/dev/null)" || {
  echo "[hotfix] 分支 ${BRANCH_WITH_ATTEMPT} 不存在：写手没有提交，无可合流内容" >&2; exit 1; }
BASE_FULL="$(git rev-parse --verify "${BASE}^{commit}")" || {
  echo "[hotfix] 基点 ${BASE} 无法解析" >&2; exit 1; }
TIP7="${TIP_FULL:0:7}"
BASE7="${BASE_FULL:0:7}"
REVIEW_TAG="pass(mechanical@${TIP7}/${BASE7})"

node "$DIR/merge-task.mjs" "$BRANCH_WITH_ATTEMPT" "$TID" "$REVIEW_TAG" "$TEST_CMD"
