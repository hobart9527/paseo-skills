// reconcile.mjs — 只读对账（单一策略属主，design D3/D4）。
// 用法: node reconcile.mjs <change> [--cap 3] [--json]
// 前置: 在 integration/<change> 分支上运行；不写任何文件。
//
// 判定顺序（互斥）：
//   INVALID  图/行非法（仅 MISSING_SCOPE/BAD_DONE_LINE 到任务级；其余图错误直接退 1），
//            或已勾选但 Done 无法按 D4 验证（账本失配）
//   DONE     已勾选且 first-parent 合流提交 M 满足 M^2 == Done.source 展开的 tip
//            且 M 的 Pipeline-Task trailer 含该 task
//   ACTIVE   任务面 agent 处于 initializing/running（终止性前置，无视 attempt/phase/disposition）
//   UNRESOLVED 最新 (attempt, phase) 终态 agent 无 disposition（pendingPermission 不被掩盖）
//   MERGE    task/<change>/<id>[-aN] 或 pod/<change> 分支领先集成分支
//   BLOCKED  依赖未 DONE
//   BLOCKED_RESOURCE 写范围与占用集（ACTIVE∪UNRESOLVED∪MERGE∧已放行 READY）路径前缀重叠
//   READY    可派发
//
// 运行态角色：控制面 shangshu/xunjian/yushi/dalisi*/mige（无 task 身份、不占坑）；
// 任务面只读 anchasi（要 task/attempt/phase，不持写范围）；任务面写入
// gongbu/gaogong/qingqibing/ceshi（持写范围、计入 cap）。
// initializing/running 且 role 缺失/未知、任务面缺身份、task 不在 tasks.md → UNMAPPED，
// fail closed：canDispatchNow 清空。paseo ls 不可用 → runtime=unavailable，canDispatchNow 恒空。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseTasks } from "./lib/tasks.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const capIdx = args.indexOf("--cap");
const parsedCap = capIdx >= 0 ? Number(args[capIdx + 1]) : 3;
const cap = Number.isFinite(parsedCap) ? parsedCap : 3;
const change = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--cap");
if (!change) {
  console.error("Usage: node reconcile.mjs <change> [--cap 3] [--json]");
  process.exit(1);
}

const emptyGroups = () => ({
  INVALID: [], DONE: [], ACTIVE: [], UNRESOLVED: [], MERGE: [],
  BLOCKED: [], BLOCKED_RESOURCE: [], READY: [], UNMAPPED: [], RUNNING: [],
  canDispatchNow: [],
});

function fatal(message) {
  console.error(message);
  if (asJson) {
    console.log(JSON.stringify({ change, cap, runtime: "unavailable", error: message, ...emptyGroups() }, null, 2));
  }
  process.exit(1);
}

const sh = (cmd, a) => {
  try {
    return execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

// --- 前置：分支必须是 integration/<change> ---
const expectedBranch = `integration/${change}`;
const currentBranch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (currentBranch !== expectedBranch) {
  fatal(`[reconcile] 当前分支必须为 ${expectedBranch}（实际: ${currentBranch ?? "未知"}）`);
}

// --- 解析 tasks.md（单一解析器 lib/tasks.mjs） ---
const tasksFile = path.join("openspec", "changes", change, "tasks.md");
if (!fs.existsSync(tasksFile)) {
  fatal(`[reconcile] 找不到 ${tasksFile}（请在集成 workspace 根目录运行）`);
}
const { tasks, errors } = parseTasks(fs.readFileSync(tasksFile, "utf8"));
const FATAL_CODES = new Set(["MALFORMED_LINE", "DUPLICATE_ID", "UNKNOWN_DEP", "SELF_DEP", "CYCLE"]);
const fatalErrors = errors.filter((e) => FATAL_CODES.has(e.code));
if (fatalErrors.length) {
  fatal(`[reconcile] INVALID 任务图：\n${fatalErrors.map((e) => `  ${e.code}: ${e.message}`).join("\n")}`);
}
const invalidByParse = new Map();
for (const e of errors) {
  if (e.task) invalidByParse.set(e.task, e.message);
}
const byId = new Map(tasks.map((t) => [t.id, t]));

// --- D4 Done 验证：first-parent 合流提交索引（secondParentSha -> trailer task ids） ---
const mergeAcceptance = new Map();
const mergeLog = sh("git", ["log", "--first-parent", "--merges", "--format=%H", "HEAD"]);
for (const commit of (mergeLog ?? "").split("\n").filter(Boolean)) {
  const second = sh("git", ["rev-parse", `${commit}^2`]);
  if (!second) continue;
  const body = sh("git", ["log", "-1", "--format=%B", commit]) ?? "";
  const accepted = new Set();
  for (const line of body.split("\n")) {
    const trailer = line.match(/^Pipeline-Task:\s*(.+)$/);
    if (trailer) {
      for (const token of trailer[1].split(/[,\s]+/).filter(Boolean)) accepted.add(token);
    }
  }
  mergeAcceptance.set(second, accepted);
}
function doneVerified(task) {
  if (!task.doneLine) return false;
  const source = expandDoneSource(task.doneLine.source);
  if (!source) return false;
  return mergeAcceptance.get(source)?.has(task.id) === true;
}
// Done.source（7 位）须唯一展开为 commit；歧义或无法展开 → INVALID。
function expandDoneSource(abbrev) {
  const candidates = (sh("git", ["rev-parse", `--disambiguate=${abbrev}`]) ?? "")
    .split("\n").filter(Boolean)
    .filter((sha) => sh("git", ["cat-file", "-t", sha]) === "commit");
  return candidates.length === 1 ? candidates[0] : null;
}
const doneSet = new Set();
for (const task of tasks) {
  if (task.done && !invalidByParse.has(task.id) && doneVerified(task)) doneSet.add(task.id);
}

// --- 待合流分支 ---
const branches = (sh("git", ["for-each-ref", "--format=%(refname:short)", `refs/heads/task/${change}/`, `refs/heads/pod/${change}`]) ?? "")
  .split("\n").filter(Boolean);
const branchTask = (b) => (b.split("/")[2] ?? "").replace(/-a\d+$/, "");
const mergeBranch = new Map();
for (const b of branches) {
  if (Number(sh("git", ["rev-list", "--count", `HEAD..${b}`]) || 0) > 0 && !mergeBranch.has(branchTask(b))) {
    mergeBranch.set(branchTask(b), b);
  }
}

// --- 运行态（fail closed） ---
const CONTROL_ROLES = new Set(["shangshu", "xunjian", "yushi", "mige"]);
const WRITER_ROLES = new Set(["gongbu", "gaogong", "qingqibing", "ceshi"]);
const READONLY_ROLES = new Set(["anchasi"]);
const LIVE = new Set(["initializing", "running"]);
const PHASE_ORDER = { test: 0, impl: 1, audit: 2, merge: 3 };
const isControl = (role) => CONTROL_ROLES.has(role) || (typeof role === "string" && role.startsWith("dalisi"));

let agents = null;
try {
  const raw = execFileSync("paseo", ["ls", "--json", "--label", `pipeline.change=${change}`], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const parsedAgents = JSON.parse(raw);
  if (!Array.isArray(parsedAgents)) throw new Error("paseo ls 输出不是数组");
  agents = parsedAgents;
} catch {
  agents = null;
}
const runtime = agents ? "ok" : "unavailable";

const UNMAPPED = [];
const RUNNING = [];
const agentsByTask = new Map();
for (const a of agents ?? []) {
  const labels = a.labels ?? {};
  if (labels["pipeline.change"] !== change) continue;
  if (a.status === "running") RUNNING.push({ id: a.id, name: a.name });
  const role = labels["pipeline.role"];
  const live = LIVE.has(a.status);
  if (isControl(role)) continue;
  const taskPlane = WRITER_ROLES.has(role) || READONLY_ROLES.has(role);
  if (!taskPlane) {
    if (live) UNMAPPED.push({ id: a.id, name: a.name, reason: `pipeline.role 缺失或未知: ${role ?? "(missing)"}` });
    continue;
  }
  const taskId = labels["pipeline.task"];
  const attempt = Number(labels["pipeline.attempt"]);
  const phase = labels["pipeline.phase"];
  const identityOk = typeof taskId === "string" && byId.has(taskId) && Number.isFinite(attempt) && typeof phase === "string" && phase !== "";
  if (!identityOk) {
    if (live) UNMAPPED.push({ id: a.id, name: a.name, reason: `任务面角色 ${role} 身份不完整或 task 不在 tasks.md: ${taskId ?? "(missing)"}` });
    continue;
  }
  const member = {
    id: a.id,
    status: a.status,
    live,
    pendingPermission: a.pendingPermission === true,
    disposition: labels["pipeline.disposition"] || null,
    attempt,
    phaseRank: PHASE_ORDER[phase] ?? -1,
    writer: WRITER_ROLES.has(role),
  };
  if (!agentsByTask.has(taskId)) agentsByTask.set(taskId, []);
  agentsByTask.get(taskId).push(member);
}

// --- 任务分类（INVALID → DONE → ACTIVE → UNRESOLVED → MERGE → BLOCKED → 资源/READY） ---
const out = { change, cap, runtime, ...emptyGroups(), UNMAPPED, RUNNING };
const stateOf = new Map();
const held = []; // 占用集：ACTIVE(写入者) ∪ UNRESOLVED ∪ MERGE，随后追加已放行 READY
const candidates = [];
let liveWriterCount = 0;

for (const task of tasks) {
  const label = `${task.id} ${task.title}`.trim();
  const members = agentsByTask.get(task.id) ?? [];
  const live = members.filter((m) => m.live);

  if (invalidByParse.has(task.id)) {
    out.INVALID.push({ task: label, reason: invalidByParse.get(task.id) });
    stateOf.set(task.id, "INVALID");
    continue;
  }
  if (task.done) {
    if (doneSet.has(task.id)) {
      for (const m of live) {
        UNMAPPED.push({ id: m.id, name: m.id, reason: `任务 ${task.id} 已 DONE 但 agent 仍在 ${m.status}` });
      }
      out.DONE.push(label);
      stateOf.set(task.id, "DONE");
    } else {
      out.INVALID.push({ task: label, reason: "Done 无法按 first-parent 合流验证（账本失配）" });
      stateOf.set(task.id, "INVALID");
    }
    continue;
  }
  if (live.length) {
    out.ACTIVE.push({ task: label, agents: live.map((m) => m.id) });
    stateOf.set(task.id, "ACTIVE");
    const liveWriters = live.filter((m) => m.writer);
    liveWriterCount += liveWriters.length;
    if (liveWriters.length) held.push({ id: task.id, label, scope: task.scope });
    continue;
  }
  const terminal = members.filter((m) => !m.live);
  if (terminal.length) {
    const latest = terminal.reduce((x, y) =>
      x.attempt !== y.attempt ? (x.attempt > y.attempt ? x : y) : (x.phaseRank >= y.phaseRank ? x : y));
    if (latest.pendingPermission || !latest.disposition) {
      out.UNRESOLVED.push({
        task: label,
        agent: latest.id,
        reason: latest.pendingPermission ? "等待权限，须人类处置" : `最新 agent ${latest.status} 且无 disposition`,
      });
      stateOf.set(task.id, "UNRESOLVED");
      held.push({ id: task.id, label, scope: task.scope });
      continue;
    }
  }
  const branch = mergeBranch.get(task.id);
  if (branch) {
    out.MERGE.push({ task: label, branch });
    stateOf.set(task.id, "MERGE");
    held.push({ id: task.id, label, scope: task.scope });
    continue;
  }
  const waitFor = task.depends.filter((dep) => !doneSet.has(dep));
  if (waitFor.length) {
    out.BLOCKED.push({ task: label, waitFor });
    stateOf.set(task.id, "BLOCKED");
    continue;
  }
  candidates.push({ id: task.id, label, scope: task.scope });
}

// --- 资源串行（按文件顺序；路径段前缀重叠即冲突） ---
// 规范化：去空段/`.` 段/尾斜杠，统一重复斜杠，`..` 弹出上一段；
// `..` 越出根 → null，overlaps fail closed 视为与一切重叠。
const segments = (p) => {
  const parts = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts;
};
const overlaps = (a, b) => {
  const as = segments(a);
  const bs = segments(b);
  if (as === null || bs === null) return true;
  const shared = Math.min(as.length, bs.length);
  for (let i = 0; i < shared; i += 1) {
    if (as[i] !== bs[i]) return false;
  }
  return true;
};
for (const c of candidates) {
  if (c.scope.some((s) => segments(s) === null)) {
    out.INVALID.push({ task: c.label, reason: "Write scope 含越出根的 '..' 段，fail closed" });
    stateOf.set(c.id, "INVALID");
    continue;
  }
  const holder = held.find((h) => h.scope.some((s) => c.scope.some((t) => overlaps(s, t))));
  if (holder) {
    out.BLOCKED_RESOURCE.push({ task: c.label, conflict: holder.label });
    stateOf.set(c.id, "BLOCKED_RESOURCE");
  } else {
    out.READY.push({ task: c.label, scope: c.scope });
    stateOf.set(c.id, "READY");
    held.push(c);
  }
}

const room = Math.max(0, cap - liveWriterCount);
out.canDispatchNow = runtime === "ok" && UNMAPPED.length === 0
  ? out.READY.slice(0, room).map((r) => r.task)
  : [];
out.integrationHead = sh("git", ["rev-parse", "--short", "HEAD"]);
out.behindMain = Number(sh("git", ["rev-list", "--count", "HEAD..main"]) || 0);

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`[reconcile] ${change} head=${out.integrationHead} behindMain=${out.behindMain} cap=${cap} runtime=${runtime} activeWriters=${liveWriterCount}`);
  console.log(`DONE ${out.DONE.length}/${tasks.length}`);
  for (const e of out.INVALID) console.log(`INVALID  ${e.task}  (${e.reason})`);
  for (const e of out.ACTIVE) console.log(`ACTIVE   ${e.task}  (${e.agents.join(",")})`);
  for (const e of out.UNRESOLVED) console.log(`UNRESOLVED ${e.task}  (${e.reason})`);
  for (const e of out.MERGE) console.log(`MERGE    ${e.task}  <- ${e.branch}`);
  for (const e of out.BLOCKED) console.log(`BLOCKED  ${e.task}  (等 ${e.waitFor.join(",")})`);
  for (const e of out.BLOCKED_RESOURCE) console.log(`BLOCKED_RESOURCE ${e.task}  (冲突 ${e.conflict})`);
  for (const e of out.READY) console.log(`READY    ${e.task}`);
  for (const e of out.UNMAPPED) console.log(`UNMAPPED ${e.id}  (${e.reason})`);
  for (const r of out.RUNNING) console.log(`RUNNING  ${String(r.id).slice(0, 8)} ${r.name}`);
  console.log(`canDispatchNow: ${out.canDispatchNow.join(", ") || "(空)"}`);
  if (out.DONE.length === tasks.length && tasks.length > 0) console.log("ALL-DONE: 可进入收尾。");
}
