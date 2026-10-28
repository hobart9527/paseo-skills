// reconcile.mjs — 只读对账（单一策略属主，design D3/D4）。
// 用法: node reconcile.mjs <change> [--cap 3] [--json]
// 前置: 在 integration/<change> 分支上运行；不写任何文件。
//
// 判定顺序（互斥）：
//   INVALID  图/行非法（仅 MISSING_SCOPE/BAD_DONE_LINE 到任务级；其余图错误直接退 1），
//            已勾选但 Done 无法按 D4 验证（账本失配），或 Write scope 路径非法（BAD_SCOPE_PATH）
//   DONE     已勾选且 first-parent 合流提交 M 满足 M^2 == Done.source 展开的 tip
//            且 M 的 Pipeline-Task trailer 含该 task
//   ACTIVE   任务面 agent 处于 initializing/running（终止性前置，无视 attempt/phase/disposition）
//   UNRESOLVED 最新 (attempt, phase) 终态 agent 无 disposition（pendingPermission 不被掩盖）
//   MERGE    task/<change>/<id>[-aN] 或 pod/<change> 分支领先集成分支
//   BLOCKED  依赖未 DONE
//   BLOCKED_RESOURCE 写范围与占用集（ACTIVE∪UNRESOLVED∪MERGE∧已放行 READY）路径前缀重叠
//   READY    可派发
//
// 运行态由 lib/paseo-state.mjs 单一适配器提供；本文件禁止直接解析 `paseo ls` 输出。
// 角色/阶段集合来自 lib/roles.mjs，与 merge-task.mjs 共用一份定义。
// initializing/running 且 role 缺失/未知、任务面缺身份、task 不在 tasks.md → UNMAPPED，
// fail closed：canDispatchNow 清空。runtime != ok → canDispatchNow 恒空。
import fs from "node:fs";
import path from "node:path";
import { parseTasks, normalizeScope, isTaskId, graphErrors } from "./lib/tasks.mjs";
import { verifyDone } from "./lib/ledger.mjs";
import { readPaseoState, selectChange, hasPipelineMarker } from "./lib/paseo-state.mjs";
import {
  WRITER_ROLES, READONLY_ROLES, REVIEWER_ROLES, isControlRole, isReviewerRole,
  normalizePhase, PHASE_ORDER, DISPOSITIONS,
  DISPOSITION_EFFECT, consumesRetryBudget, retryPolicy,
} from "./lib/roles.mjs";
import {
  readRunState, openIntents, leaseStatus, intentAgeMs, DEFAULT_INTENT_GRACE_MS,
} from "./lib/run-state.mjs";
import { execFileSync } from "node:child_process";

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
  FOREIGN: [], INTENT_PENDING: [], ORPHAN_INTENT: [], canDispatchNow: [], holdReasons: [],
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
// 严重度归属由 lib/tasks.mjs 的 ERROR_SCOPE 单点定义（graph 让整份文件不可信）。
const fatalErrors = graphErrors(errors);
if (fatalErrors.length) {
  fatal(`[reconcile] INVALID 任务图：\n${fatalErrors.map((e) => `  ${e.code}: ${e.message}`).join("\n")}`);
}
const invalidByParse = new Map();
for (const e of errors) {
  if (e.task) invalidByParse.set(e.task, e.message);
}
const byId = new Map(tasks.map((t) => [t.id, t]));

// 路径合法性单一属主：normalizeScope 来自 lib/tasks.mjs。
// 非法 scope 在占用集内 fail closed：overlaps 视为与一切重叠。
const badScopeOf = (task) => task.scope.find((s) => normalizeScope(s) === null);
// 任务 ID 形态的单一属主是 lib/tasks.mjs（isTaskId），这里只额外要求「引用已在本账本中定义」。
const resolveTaskToken = (token) => (isTaskId(token) && byId.has(token) ? token : null);

// --- D4 Done 验证：复用 lib/ledger.mjs（与 merge-task.mjs 同一属主，禁止各自推导） ---
const readGit = (a) => sh("git", a);
const { doneSet: ledgerDoneSet } = verifyDone(tasks, readGit);
// 非法 Write scope 的任务整体判 INVALID，其 Done 证据不得释放依赖者——否则一个坏 scope
// 的任务会被当作已完成，把它后面的任务错误地放行。
const doneSet = new Set();
for (const task of tasks) {
  if (!ledgerDoneSet.has(task.id)) continue;
  if (invalidByParse.has(task.id) || badScopeOf(task) !== undefined) continue;
  doneSet.add(task.id);
}

// --- 待合流分支 ---
const branches = (sh("git", ["for-each-ref", "--format=%(refname:short)", `refs/heads/task/${change}/`, `refs/heads/pod/${change}`]) ?? "")
  .split("\n").filter(Boolean);
// Pod 分支 pod/<change> 不携带 task 身份（split('/')[2] 为空串），按冻结成员文件回退。
const podMembers = new Map();
const podMembersFile = path.join("openspec", "changes", change, "pod-members.json");
if (fs.existsSync(podMembersFile)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(podMembersFile, "utf8"));
    if (Array.isArray(parsed?.tasks)) for (const id of parsed.tasks) podMembers.set(id, "pod-members.json");
  } catch { /* 非法成员文件按无映射处理，落到 UNMAPPED 由调用方处置 */ }
}
const branchTaskIds = (b) => {
  const seg = b.split("/")[2] ?? "";
  const fromName = resolveTaskToken(seg.replace(/-a\d+$/, ""));
  if (fromName) return [fromName];
  if (seg === "" && podMembers.size > 0) return [...podMembers.keys()];
  return [];
};
/**
 * 分支所属 attempt：裸分支 `task/<change>/<id>` 是第 1 次，`-aN` 是第 N 次。
 *
 * 必须按数值而不是字符串比较：`-a10` 的字典序排在 `-a2` 之前，
 * 任何「取第一个匹配」的写法都会把第 10 次尝试的成果误判成第 2 次之前的旧产物。
 * Pod 分支不携带 attempt，返回 null（按冻结成员处理，不参与 attempt 排序）。
 */
const branchAttempt = (b) => {
  const seg = b.split("/")[2] ?? "";
  if (seg === "") return null;
  const match = seg.match(/-a(\d+)$/);
  if (!match) return 1;
  const attempt = Number(match[1]);
  return Number.isInteger(attempt) && attempt > 0 ? attempt : null;
};
// 任何映射不到任务的分支都必须落到 UNMAPPED，不能静默忽略。
//
// 旧判据是 `b.split("/")[2] === undefined`，只覆盖「没有冻结成员的 pod/<change>」。
// 但 `for-each-ref refs/heads/pod/<change>` 是**路径段前缀匹配**，嵌套的
// `pod/<change>/<x>` 同样会被列出来，而它的第三段是 `<x>`：既不是 `undefined`，
// `resolveTaskToken('<x>')` 也解析不出任务 → 两个判据都不命中，分支领先成集成分支时
// 既不进 MERGE 也不进 UNMAPPED，reconcile 报「一切正常」。这正是 fail-closed 该覆盖的洞。
const unmappedPodBranches = branches.filter((b) => branchTaskIds(b).length === 0);

// --- 运行态（单一适配器 lib/paseo-state.mjs；fail closed） ---
const state = readPaseoState();
const runtime = state.runtime;
const { members, suspicious } = selectChange(state, change);

// --- 运行账本（动作意图与编排租约；只读，不写） ---
// Git 记已合流事实、tasks.md 记任务契约、Paseo 记 Agent 事实，三者都不记「已发出但尚未落盘的
// 派发」。缺这一层时，创建请求在途的窗口会被再派一次，造成双写同一文件。
const runLedger = readRunState(change);
const lease = leaseStatus(runLedger.state);
const orphanIntents = [];
const pendingIntents = [];
/**
 * 意图是否已有对应的 Paseo agent（按 task/attempt/phase/role 匹配标签）。
 *
 * **必须限定在 members（本 change）内**：实际机器上同时存在上千条跨 change 的历史 agent，
 * 不同 change 常有同名任务（每个 change 都有 T-01）。在全量 agents 里按 task 匹配，
 * 会撞上别的 change 的同名任务，把「意图在途」误判成「agent 已终态但回执丢失」。
 */
const intentAgents = (intent) => members.filter((agent) => {
  const labels = agent.labels ?? {};
  if (labels['pipeline.task'] !== intent.task) return false;
  if (intent.attempt !== null && intent.attempt !== undefined
    && Number(labels['pipeline.attempt']) !== intent.attempt) return false;
  if (intent.phase && normalizePhase(labels['pipeline.phase']) !== normalizePhase(intent.phase)) return false;
  if (intent.role && labels['pipeline.role'] !== intent.role) return false;
  return true;
});
/** 有未回执意图的任务：在排除重复之前不得重派（L4-03）。 */
const intentBlockedTasks = new Map();
/** 已被逐任务分支输出过的意图键：末尾批量补齐时按 key 去重，避免同一条意图在 INTENT_PENDING 里出现两次。 */
const emittedIntentKeys = new Set();
for (const intent of openIntents(runLedger.state)) {
  const matched = intentAgents(intent);
  const ageMs = intentAgeMs(intent);
  const overdue = ageMs !== null && ageMs > DEFAULT_INTENT_GRACE_MS;
  const entry = {
    key: intent.key,
    task: intent.task,
    role: intent.role ?? null,
    ageMs,
    agents: matched.map((agent) => ({ id: agent.id, status: agent.status, live: agent.live })),
    reason: matched.length === 0
      ? (overdue
        ? `派发意图超过 ${Math.round(DEFAULT_INTENT_GRACE_MS / 60000)} 分钟仍无对应 agent（创建失败或回执丢失）`
        : '派发意图已记录、在途但尚无对应活体 agent；禁止重复派发')
      : 'agent 已终态但意图未回执（回执丢失）；禁止重复派发',
  };
  if (matched.length === 0 && overdue) {
    entry.kind = 'orphan';
    orphanIntents.push(entry);
    intentBlockedTasks.set(intent.task, entry);
  } else if (matched.length === 0) {
    // 尚无 agent、仍在宽限内：等其落地，不得重派。
    entry.kind = 'pending';
    pendingIntents.push(entry);
    intentBlockedTasks.set(intent.task, entry);
  } else if (matched.every((agent) => !agent.live)) {
    // agent 已终态但回执丢失：必须由执行器显式 record/fail 收口，不能一直挂着等。
    entry.kind = 'receipt-lost';
    pendingIntents.push(entry);
    if (!intentBlockedTasks.has(intent.task)) intentBlockedTasks.set(intent.task, entry);
  }
}

const UNMAPPED = [];
const RUNNING = [];
const FOREIGN = [];
const agentsByTask = new Map();
let foreignLiveWriters = 0;

for (const agent of suspicious) {
  UNMAPPED.push({
    id: agent.id,
    name: agent.title ?? agent.id,
    reason: `活体流水线 agent 但无法归属到 ${change}（标题 ${JSON.stringify(agent.title)}）`,
  });
}
// Pod 分支领先但既无 task 身份也无冻结成员记录：无法恢复到任何任务，保守清空派发。
for (const b of unmappedPodBranches) {
  const ahead = sh("git", ["rev-list", "--count", `HEAD..${b}`]);
  if (ahead === null) {
    // git 调用失败 ≠ 不领先：失败被 `|| 0` 吞掉时，一条真实领先的分支会被当成
    // 「无内容」静默忽略，reconcile 还报一切正常。领先未知按 fail closed 进 UNMAPPED。
    UNMAPPED.push({
      id: b,
      name: b,
      reason: `Pod 分支缺少 task 映射且领先状态不可判定（git rev-list 失败）；先人工核对`,
    });
  } else if (Number(ahead) > 0) {
    UNMAPPED.push({
      id: b,
      name: b,
      reason: `Pod 分支领先但缺少 task 映射（需 openspec/changes/${change}/pod-members.json）`,
    });
  }
}

// 非本 change 的活体流水线写手：占用的是**同一个仓库**。
//
// 旧实现只报告不计 cap，理由是「不属于本 change 的任务图」。但 cap 保护的不是任务图，
// 是工作区与共享副作用：同仓两个 change 各派 3 个写手时，两边都以为自己只用到一半容量，
// worktree 只隔离路径，隔离不了共享文件、端口、DB 文件、迁移与测试账号。
// 因此本 change 的可用名额必须扣掉这些外部写手——只数写入角色，只读 Auditor 不占写容量。
for (const agent of state.agents) {
  if (!agent.live) continue;
  const inChange = members.some((m) => m.id === agent.id);
  if (inChange) continue;
  if (!hasPipelineMarker(agent)) continue;
  if (suspicious.some((s) => s.id === agent.id)) continue;
  FOREIGN.push({ id: agent.id, name: agent.title ?? agent.id, status: agent.status });
  const foreignRole = agent.labels?.['pipeline.role'];
  const isForeignWriter = WRITER_ROLES.has(foreignRole)
    || (!isControlRole(foreignRole) && !isReviewerRole(foreignRole));
  if (isForeignWriter) foreignLiveWriters += 1;
}

for (const agent of members) {
  if (agent.live) RUNNING.push({ id: agent.id, name: agent.title ?? agent.id, status: agent.status });
  const attributed = agent.attribution;
  const live = agent.live;

  // 标题通道只能证明「属于本 change」；role/task 不可信（真实标题会被截断到 60 字符，
  // 且格式自由：`[Pipeline] Auditor T-01 审查R3 <change>`）。
  const role = attributed.trusted ? attributed.role : null;
  // 两个通道的 task 都必须能在 tasks.md 中解析：标签写了 tasks.md 里不存在的 T-NN 同样是身份不可信。
  const taskId = resolveTaskToken(attributed.task);

  // 控制面角色（Lead、PM、预冻结架构师）不持任务身份，直接跳过。
  // 仲裁员虽用 hanlin profile，但持具体 task/attempt/phase，属于任务面只读仲裁者。
  if (isControlRole(role) && taskId === null) continue;

  const taskPlane = WRITER_ROLES.has(role) || isReviewerRole(role);
  // 标题通道：无法证明是只读，保守按写入者处理（持写范围、计入 cap）。
  const titleOnlyWriter = !attributed.trusted && taskId !== null;
  const writer = titleOnlyWriter || WRITER_ROLES.has(role);

  if (!taskPlane && !titleOnlyWriter) {
    if (live) {
      UNMAPPED.push({
        id: agent.id,
        name: agent.title ?? agent.id,
        reason: role === null
          ? `任务面身份不可信（无 pipeline.role 标签，标题通道无法解析角色）`
          : `pipeline.role 缺失或未知: ${role}`,
      });
    }
    continue;
  }

  const attemptRaw = attributed.trusted ? attributed.attempt : null;
  const attempt = attemptRaw === null || attemptRaw === undefined ? null : Number(attemptRaw);
  const phase = attributed.trusted ? normalizePhase(attributed.phase) : null;
  const hasPhaseLabel = attributed.trusted && typeof attributed.phase === "string" && attributed.phase !== "";

  if (taskId === null) {
    if (live) {
      UNMAPPED.push({
        id: agent.id,
        name: agent.title ?? agent.id,
        reason: `任务面 agent 缺 task 身份或 task 不在 tasks.md: ${attributed.task ?? "(missing)"}`,
      });
    }
    continue;
  }
  if (attributed.trusted && (attempt === null || !Number.isInteger(attempt) || attempt <= 0)) {
    if (live) {
      UNMAPPED.push({ id: agent.id, name: agent.title ?? agent.id, reason: `任务面 agent 的 pipeline.attempt 非法: ${attemptRaw}` });
    }
    continue;
  }
  if (attributed.trusted && (!hasPhaseLabel || phase === null)) {
    if (live) {
      UNMAPPED.push({ id: agent.id, name: agent.title ?? agent.id, reason: `任务面 agent 的 pipeline.phase 缺失或未知: ${attributed.phase ?? "(missing)"}` });
    }
    continue;
  }

  const disposition = attributed.trusted ? attributed.disposition : null;
  if (disposition !== null && !DISPOSITIONS.has(disposition)) {
    if (live) {
      UNMAPPED.push({ id: agent.id, name: agent.title ?? agent.id, reason: `pipeline.disposition 非法: ${disposition}` });
    }
    continue;
  }

  const member = {
    id: agent.id,
    status: agent.status,
    live,
    identitySource: attributed.source,
    pendingPermission: agent.pendingPermission === true,
    disposition,
    attempt,
    phaseRank: phase === null ? -1 : PHASE_ORDER[phase],
    phase,
    writer,
  };
  if (!agentsByTask.has(taskId)) agentsByTask.set(taskId, []);
  agentsByTask.get(taskId).push(member);
}

// --- 任务分类（INVALID → DONE → ACTIVE → UNRESOLVED → MERGE → BLOCKED → 资源/READY） ---
const out = { change, cap, runtime, ...emptyGroups(), UNMAPPED, RUNNING, FOREIGN, staleBranches: [] };
out.runtimeEvidence = state.runtimeEvidence;
const stateOf = new Map();
const held = []; // 占用集：ACTIVE(写入者) ∪ UNRESOLVED ∪ MERGE，随后追加已放行 READY
const candidates = [];
let liveWriterCount = 0;

for (const task of tasks) {
  const label = `${task.id} ${task.title}`.trim();
  const taskMembers = agentsByTask.get(task.id) ?? [];
  const live = taskMembers.filter((m) => m.live);

  if (invalidByParse.has(task.id)) {
    // 解析级 INVALID 也必须计入运行占用。旧实现在这里直接 continue，于是
    // `MISSING_SCOPE` 之类「scope 未知」的任务上正跑着的写手不进 cap、不占任何 scope——
    // 对账报告说 `cap=3` 还有空位，实际已经有人在写一个我们无法界定范围的任务。
    // scope 未知时按「与一切重叠」保守占位（与 badScopeOf 的 fail-closed 口径一致）。
    out.INVALID.push({ task: label, reason: invalidByParse.get(task.id) });
    stateOf.set(task.id, "INVALID");
    const liveWriters = live.filter((m) => m.writer);
    liveWriterCount += liveWriters.length;
    if (liveWriters.length) held.push({ id: task.id, label, scope: task.scope.length ? task.scope : [''] });
    continue;
  }
  // 非法 Write scope 先于一切状态分类判 INVALID（含 DONE/ACTIVE/UNRESOLVED/MERGE/BLOCKED），
  // 不进入 doneSet、不释放依赖者；但运行占用与分类分离——live 写入者仍计入 cap 并保守占位。
  const badScope = badScopeOf(task);
  if (badScope !== undefined) {
    out.INVALID.push({ task: label, reason: `BAD_SCOPE_PATH: Write scope 非法 ${JSON.stringify(badScope)}（须为仓库根内相对路径）` });
    stateOf.set(task.id, "INVALID");
    const liveWriters = live.filter((m) => m.writer);
    liveWriterCount += liveWriters.length;
    if (liveWriters.length) held.push({ id: task.id, label, scope: task.scope });
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
  const terminal = taskMembers.filter((m) => !m.live);
  // 打回预算：消耗预算的处置（rejected/abandoned）累加到本任务的审计历史。
  // 预算耗尽后不再重派，转 BLOCKED 交人类裁决——否则一个反复被打回的任务会无限自旋。
  // 前 MAX_REJECTIONS 次按原角色重派，其后一次升级改派 ESCALATION_ROLE（见 retryPolicy）。
  // 只数写入者：预算衡量的是「写手产出被拒几次」。审计员/仲裁员被打 rejected/abandoned
  // （例如审计员失联）不代表写手又被打回一轮；一并计数会让一次 R1 打回直接触发升级。
  const rejections = terminal.filter((m) => m.writer && consumesRetryBudget(m.disposition)).length;
  const policy = retryPolicy(rejections);
  // agent 自称 disposition=merged。自报不是验收：留到最后判定，先让「分支领先」这一
  // 可核验事实说话（分支仍在 → 其实没合流，进 MERGE；分支没了又没账本 → 才是矛盾）。
  let claimsMerged = false;
  let latest = null;
  if (terminal.length) {
    // 确定性排序：先比 attempt（未知 attempt 视为最早），再比 phase 序，最后比 agent id。
    const rank = (m) => [m.attempt === null ? -1 : m.attempt, m.phaseRank];
    latest = terminal.slice().sort((x, y) => {
      const rx = rank(x); const ry = rank(y);
      if (rx[0] !== ry[0]) return ry[0] - rx[0];
      if (rx[1] !== ry[1]) return ry[1] - rx[1];
      return String(x.id) < String(y.id) ? -1 : 1;
    })[0];
    // 待批权限不被「更新的一条」掩盖：只看 latest 会漏掉仍被人卡着的旧 attempt，
    // 一旦它的授权被拒绝，任务会被当成正常终态直接重派或合流。
    const blockedOnPermission = terminal.find((m) => m.pendingPermission) ?? null;
    if (blockedOnPermission !== null) {
      out.UNRESOLVED.push({
        task: label,
        agent: blockedOnPermission.id,
        reason: "等待权限，须人类处置",
      });
      stateOf.set(task.id, "UNRESOLVED");
      held.push({ id: task.id, label, scope: task.scope });
      continue;
    }
    if (!latest.disposition) {
      out.UNRESOLVED.push({
        task: label,
        agent: latest.id,
        reason: `最新 agent ${latest.status} 且无 disposition`,
      });
      stateOf.set(task.id, "UNRESOLVED");
      held.push({ id: task.id, label, scope: task.scope });
      continue;
    }
    claimsMerged = DISPOSITION_EFFECT[latest.disposition] === "verify";
  }
  // 分支必须绑定到 latest attempt：一个仍在领先的旧 attempt 分支是**被判回**的那一轮产物，
  // 合流它等于接受被拒绝的成果，而最新 attempt 的修复根本没进集成历史。
  // 裸分支 = attempt 1，`-aN` = attempt N；Pod 分支不带 attempt（null，按冻结成员处理）。
  //
  // 没有 agent 历史可依据时（例如对账先于任何派发记录），退化为按**数值**取最高 attempt：
  // 旧实现用 `branches.find(...)`，`git for-each-ref` 的字典序让 `-a10` 排在 `-a2` 之前，
  // 于是第 10 次尝试的成果被第 2 次的旧分支顶掉。
  // rev-list 失败（null）必须与「不领先」（"0"）分开：失败时按领先未知处理——
  // 分支保留在 leading（不丢弃可能存在的真实成果、不触发重派），同时进 UNMAPPED
  // 诊断（全局 hold，人工核对前不放行任何合流/派发）。静默当 0 会把一轮成果从
  // 合流候选里抹掉，还把任务错误地放回 READY 造成重复派发。
  const leading = [];
  for (const b of branches) {
    if (!branchTaskIds(b).includes(task.id)) continue;
    const ahead = sh("git", ["rev-list", "--count", `HEAD..${b}`]);
    if (ahead === null) {
      UNMAPPED.push({
        id: b,
        name: b,
        reason: `任务 ${task.id} 的分支领先状态不可判定（git rev-list 失败）；按领先处理，先人工核对`,
      });
      leading.push(b);
    } else if (Number(ahead) > 0) {
      leading.push(b);
    }
  }
  const latestAttempt = latest?.attempt ?? null;
  // 审计打回时 latest 是该 attempt 的 Auditor（audit 阶段序更高，处置 handed-off），
  // 被打 `rejected` 的是同一 attempt 的写手。只看 latest 的处置，会把这轮被判回的分支
  // 当成合流目标：对账给出 NEXT merge，而手上没有 pass 标签，任务既合不了也不回 READY。
  const latestRejected = latestAttempt !== null && terminal.some((m) =>
    m.writer && m.attempt === latestAttempt && consumesRetryBudget(m.disposition));
  const ranked = (list) => list.slice().sort((x, y) => {
    const ax = branchAttempt(x); const ay = branchAttempt(y);
    if (ax === null || ay === null) {
      if (ax === ay) return String(x) < String(y) ? -1 : 1; // 都是 Pod：稳定排序
      return ax === null ? 1 : -1;                          // Pod 排在其后
    }
    if (ax !== ay) return ay - ax;                          // 数值降序
    return String(x) < String(y) ? -1 : 1;
  });
  const exact = latestAttempt === null || latestRejected ? [] : leading.filter((b) => branchAttempt(b) === latestAttempt);
  const unknownAttempt = leading.filter((b) => branchAttempt(b) === null);
  const stale = latestAttempt === null ? [] : leading.filter((b) => {
    const attempt = branchAttempt(b);
    return attempt !== null && (attempt !== latestAttempt || latestRejected);
  });
  for (const b of stale) {
    out.staleBranches.push({ task: label, id: task.id, branch: b, attempt: branchAttempt(b), latestAttempt });
  }
  const branch = (latestAttempt === null
    ? ranked(leading).filter((b) => branchAttempt(b) !== null)
    : ranked(exact))[0] ?? ranked(unknownAttempt)[0] ?? null;
  if (branch) {
    out.MERGE.push({ task: label, id: task.id, branch });
    stateOf.set(task.id, "MERGE");
    held.push({ id: task.id, label, scope: task.scope });
    continue;
  }
  // 自称 merged 但既没有对应分支领先、也没有 first-parent 账本证明：自报与事实矛盾，挂起核对。
  // 放在 MERGE 之后：分支还在时「未合流」是更具体的结论，直接进 MERGE 即可。
  if (claimsMerged) {
    out.UNRESOLVED.push({
      task: label,
      agent: latest?.id ?? terminal[0].id,
      reason: `agent 自称 disposition=merged，但 first-parent 合流账本无记录且无领先分支；须核对`,
    });
    stateOf.set(task.id, "UNRESOLVED");
    held.push({ id: task.id, label, scope: task.scope });
    continue;
  }
  const waitFor = task.depends.filter((dep) => !doneSet.has(dep));
  if (waitFor.length) {
    out.BLOCKED.push({ task: label, waitFor });
    stateOf.set(task.id, "BLOCKED");
    continue;
  }
  // 打回预算耗尽：不再回流 READY 无预算重派，转 BLOCKED 交人类裁决。
  // 放在 MERGE 之后：分支已领先说明工作成果存在，合流仍走正常门禁（测试 + 非自审），
  // 预算只拦「什么都没交出去就再派一次」的空转。
  if (!policy.allowed) {
    out.BLOCKED.push({
      task: label,
      waitFor: [],
      reason: policy.reason,
    });
    stateOf.set(task.id, "BLOCKED");
    continue;
  }
  // 已有未回执的派发意图：在查清是否有真实 agent 并回执之前，绝不重派（L4-03）。
  // 放在依赖与预算之后：这两者已能从账本判定，且意图不改变「依赖未满足」这一事实。
  const intentEntry = intentBlockedTasks.get(task.id);
  if (intentEntry !== undefined) {
    // agents 一并带上：回执丢失时执行器要按 agent id 去 record/fail，只给 task 无从下手。
    out.INTENT_PENDING.push({
      task: label, key: intentEntry.key, kind: intentEntry.kind,
      agents: intentEntry.agents, reason: intentEntry.reason,
    });
    emittedIntentKeys.add(intentEntry.key);
    stateOf.set(task.id, "INTENT_PENDING");
    held.push({ id: task.id, label, scope: task.scope });
    continue;
  }
  candidates.push({
    id: task.id,
    label,
    scope: task.scope,
    // 升级重派：本次派发必须换角色，否则「打回 2 次后升级高工」没有任何执行载体。
    escalate: policy.escalate,
    role: policy.role,
    rejections: policy.rejections,
  });
}

// --- 资源串行（按文件顺序；路径段前缀重叠即冲突） ---
const overlaps = (a, b) => {
  const as = normalizeScope(a);
  const bs = normalizeScope(b);
  if (as === null || bs === null) return true;
  const shared = Math.min(as.length, bs.length);
  for (let i = 0; i < shared; i += 1) {
    if (as[i] !== bs[i]) return false;
  }
  return true;
};
for (const c of candidates) {
  const holder = held.find((h) => h.scope.some((s) => c.scope.some((t) => overlaps(s, t))));
  if (holder) {
    out.BLOCKED_RESOURCE.push({ task: c.label, conflict: holder.label });
    stateOf.set(c.id, "BLOCKED_RESOURCE");
  } else {
    out.READY.push({
      task: c.label,
      id: c.id,
      scope: c.scope,
      // 仅在升级重派时出现。字段缺省表示按常规角色派发；出现即要求执行器改派该角色。
      ...(c.escalate ? { escalate: true, role: c.role, rejections: c.rejections } : {}),
    });
    stateOf.set(c.id, "READY");
    held.push(c);
  }
}

// --- 派发放行（fail closed） ---
// 未与任何任务关联的意图（例如任务已 DONE、或意图的 task 不在账本里）也要报告，
// 否则它们会静默挂住派发却不被看见；已经逐任务输出过的按 key 去重。
for (const entry of pendingIntents) {
  if (emittedIntentKeys.has(entry.key)) continue;
  emittedIntentKeys.add(entry.key);
  out.INTENT_PENDING.push(entry);
}
out.ORPHAN_INTENT.push(...orphanIntents);
out.openIntentCount = pendingIntents.length + orphanIntents.length;
// 编排租约：只报告，不改变任务分类。租约过期意味着上一任编排者可能仍存活，
// 执行器必须先 begin 领取新代际才能提交动作；这是执行侧门禁，不是对账侧的判定依据。
out.lease = lease;

// 本 change 的可用名额必须同时扣掉外部写手：cap 保护的是共享工作区容量，不是任务图。
const room = Math.max(0, cap - liveWriterCount - foreignLiveWriters);
if (runtime !== "ok") out.holdReasons.push(`runtime=${runtime}（非 ok 一律不放行）`);
if (UNMAPPED.length > 0) out.holdReasons.push(`存在 ${UNMAPPED.length} 个 UNMAPPED 运行中 agent`);
if (out.openIntentCount > 0) {
  out.holdReasons.push(`有 ${out.openIntentCount} 项派发意图尚无回执；在排除重复之前不放行新派发`);
}
if (room === 0) {
  out.holdReasons.push(
    `cap=${cap} 已被 ${liveWriterCount} 个本 change 写入者`
    + (foreignLiveWriters > 0 ? ` + ${foreignLiveWriters} 个同仓外部写手` : '')
    + ' 占满'
  );
}
out.canDispatchNow = out.holdReasons.length === 0
  ? out.READY.slice(0, room).map((r) => r.task)
  : [];
out.liveWriterCount = liveWriterCount;
out.foreignLiveWriters = foreignLiveWriters;
out.integrationHead = sh("git", ["rev-parse", "--short", "HEAD"]);
out.behindMain = Number(sh("git", ["rev-list", "--count", "HEAD..main"]) || 0);
out.nextAction = nextAction(out, { tasks, cap });

/**
 * 确定的下一动作（L4-02）：只读决策内核输出「该做什么、为什么」，由执行器（Lead）落地。
 * 本函数不产生副作用。
 *
 * 只有两类阻塞是**全局**的——观测不可信（runtime 非 ok）与身份无法归属（UNMAPPED），
 * 它们让任何结论都失去依据，此时不给出任何动作。
 *
 * 其余阻塞都是**逐任务**的：一条被打回等待人类裁决的任务，不该冻结另一条已经跑完、
 * 分支领先可以合流的任务，也不该冻结与它写范围无关、可以立即派发的任务。
 * 因此返回 `actions` 有序列表（仲裁在前，合流次之，派发最后），`kind`/`reason`/`tasks`
 * 仍取第一项，`canDispatchNow` 与 `actions` 中的 dispatch 始终一致。
 */
function nextAction(out, { tasks, cap }) {
  if (out.runtime !== "ok") {
    const reason = `运行态 ${out.runtime}：状态观测不可信，禁止任何派发与合流`;
    return { kind: "hold", reason, actions: [{ kind: "hold", reason }] };
  }
  if (out.UNMAPPED.length > 0) {
    const reason = `存在 ${out.UNMAPPED.length} 个 UNMAPPED 运行中 agent；先归属或终止，再继续`;
    return { kind: "hold", reason, actions: [{ kind: "hold", reason }] };
  }
  // BLOCKED 却无未满足依赖：账本自相矛盾，无从判断该推进什么，属全局 hold。
  const blockedNoDep = out.BLOCKED.filter((e) => e.reason === undefined && e.waitFor.length === 0);
  if (blockedNoDep.length > 0) {
    const reason = `有 ${blockedNoDep.length} 项 BLOCKED 但无未满足依赖；账本自相矛盾`;
    return { kind: "hold", reason, tasks: blockedNoDep.map((e) => e.task), actions: [{ kind: "hold", reason, tasks: blockedNoDep.map((e) => e.task) }] };
  }

  const actions = [];
  // --- 逐任务仲裁：合并成一条动作，但只点名这些任务，不影响其余任务 ---
  const arbitration = [];
  // 超期孤儿意图：派发请求已发出但事后查无 agent，只能由执行器核对后决定重派或标记失败。
  // 自动化不得自行重派——那正是重复派发的来源。
  if (out.ORPHAN_INTENT.length > 0) {
    arbitration.push({
      tasks: out.ORPHAN_INTENT.map((e) => e.task),
      reason: `${out.ORPHAN_INTENT.length} 项派发意图超期仍无对应 agent；须核对后显式 fail 或 record`,
    });
  }
  // 未回执的派发意图（agent 已终态但回执丢失）：执行器必须先 record/fail 收口。
  const lostReceipts = out.INTENT_PENDING.filter((e) => e.kind === 'receipt-lost');
  const inFlight = out.INTENT_PENDING.filter((e) => e.kind !== 'receipt-lost');
  if (lostReceipts.length > 0) {
    arbitration.push({
      tasks: lostReceipts.map((e) => e.task),
      reason: `${lostReceipts.length} 项派发意图的 agent 已终态但回执丢失；须 record 登记 agent 或 fail 作废意图`,
    });
  }
  if (out.INVALID.length > 0) {
    arbitration.push({
      tasks: out.INVALID.map((e) => e.task),
      reason: `账本/任务图非法 ${out.INVALID.length} 项；须人类或 Lead 修正 tasks.md 后重跑`,
    });
  }
  if (out.UNRESOLVED.length > 0) {
    arbitration.push({
      tasks: out.UNRESOLVED.map((e) => e.task),
      reason: `有 ${out.UNRESOLVED.length} 项终态待人类处置（权限暂停或缺失 disposition）；不得自动重派`,
    });
  }
  const exhausted = out.BLOCKED.filter((e) => e.reason !== undefined);
  if (exhausted.length > 0) {
    arbitration.push({
      tasks: exhausted.map((e) => e.task),
      reason: `打回预算耗尽 ${exhausted.length} 项；须人类裁决是否继续`,
    });
  }
  if (arbitration.length > 0) {
    actions.push({
      kind: "arbitrate",
      reason: arbitration.map((a) => a.reason).join("；"),
      tasks: [...new Set(arbitration.flatMap((a) => a.tasks))],
    });
  }
  if (out.MERGE.length > 0) {
    actions.push({
      kind: "merge",
      reason: `有 ${out.MERGE.length} 个任务分支领先待合流`,
      tasks: out.MERGE.map((e) => ({ task: e.id, branch: e.branch })),
    });
  }
  if (out.canDispatchNow.length > 0) {
    // 任务列表必须与 canDispatchNow 同一口径（room 已扣除外部写手），
    // 否则执行器按这里的列表派发就会超出 cap。
    //
    // 但 `canDispatchNow` 存的是**人读的 label**（`<task-id> <title>`，公开 JSON 契约），
    // 而动作里的 `tasks` 是给执行器打标签用的**机器标识**。早先这里用
    // `/\bT-\d+\b/` 从 label 里抠 ID——`lib/tasks.mjs` 明明接受 `<前缀>-<数字>`
    // （`TASK-01`、`BUG-3` 都合法），非 `T-` 前缀就抠不出来，整条 label 会被当成任务 ID
    // 塞进 `pipeline.task` 标签。改为回查 READY（label 的产出点，同时带 id）。
    // 升级重派：任务列表保持「机器标识」形状不变（执行器按键取值），
    // 另开 `escalations` 只在确有升级时出现，说明该任务这次必须改派哪个角色。
    // 不把 tasks 改成对象：那是既有公开契约，改形状会打断所有已写好的执行器。
    const escalations = out.READY
      .filter((r) => r.escalate && out.canDispatchNow.includes(r.task))
      .map((r) => ({ task: r.id, role: r.role, rejections: r.rejections }));
    actions.push({
      kind: "dispatch",
      reason: `cap=${cap}，当前 ${out.liveWriterCount} 个本 change 写入者`
        + (out.foreignLiveWriters > 0 ? ` + ${out.foreignLiveWriters} 个同仓外部写手` : '') + ' 在跑',
      tasks: out.canDispatchNow.map(
        (label) => out.READY.find((r) => r.task === label)?.id ?? label
      ),
      ...(escalations.length > 0 ? { escalations } : {}),
    });
  }
  if (actions.length === 0) {
    const waitingOnDeps = out.BLOCKED.filter((e) => e.reason === undefined && e.waitFor.length > 0);
    if (waitingOnDeps.length > 0) {
      actions.push({ kind: "wait", reason: `仅剩依赖未满足的任务 ${waitingOnDeps.length} 项；等待上游合流` });
    } else if (out.ACTIVE.length > 0) {
      actions.push({ kind: "wait", reason: `${out.ACTIVE.length} 项在跑且无空余容量；等待完成` });
    } else if (tasks.length > 0 && out.DONE.length === tasks.length) {
      actions.push({ kind: "finalize", reason: "全部任务已 DONE；进入收尾（业务验收 + 人类确认点 2）" });
    } else if (inFlight.length > 0) {
      actions.push({ kind: "wait", reason: `${inFlight.length} 项派发意图在途（尚无对应 agent）；等其落地后 record，不得重派`, tasks: inFlight.map((e) => e.task) });
    } else if (out.INTENT_PENDING.length > 0) {
      actions.push({ kind: "arbitrate", reason: `${out.INTENT_PENDING.length} 项派发意图未与账本任务对应；须核对后 fail 作废`, tasks: out.INTENT_PENDING.map((e) => e.task) });
    } else {
      actions.push({ kind: "hold", reason: "无可派发、无待合流、无在跑任务；状态无法解释，须人工核对" });
    }
  }
  const [primary] = actions;
  return { kind: primary.kind, reason: primary.reason, ...(primary.tasks ? { tasks: primary.tasks } : {}), actions };
}

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`[reconcile] ${change} head=${out.integrationHead} behindMain=${out.behindMain} cap=${cap} runtime=${runtime} activeWriters=${liveWriterCount} foreign=${foreignLiveWriters}`);
  console.log(`DONE ${out.DONE.length}/${tasks.length}`);
  for (const e of out.runtimeEvidence) console.log(`  runtime: ${e}`);
  for (const e of out.INVALID) console.log(`INVALID  ${e.task}  (${e.reason})`);
  for (const e of out.ACTIVE) console.log(`ACTIVE   ${e.task}  (${e.agents.join(",")})`);
  for (const e of out.UNRESOLVED) console.log(`UNRESOLVED ${e.task}  (${e.reason})`);
  for (const e of out.MERGE) console.log(`MERGE    ${e.task}  <- ${e.branch}`);
  // 旧 attempt 的领先分支不合流，但必须被看见：它是被判回的那一轮产物，留在仓库里会被下一次对账
  // 重新误当成可合流目标，或被人手工合掉。
  for (const e of out.staleBranches) {
    const why = e.attempt === e.latestAttempt ? `attempt ${e.attempt} 已被打回` : `attempt ${e.attempt} < latest ${e.latestAttempt}`;
    console.log(`STALE_BRANCH ${e.task}  <- ${e.branch}（${why}；不合流，按需清理）`);
  }
  for (const e of out.BLOCKED) console.log(`BLOCKED  ${e.task}  ${e.reason ? `(${e.reason})` : `(等 ${e.waitFor.join(",")})`}`);
  for (const e of out.BLOCKED_RESOURCE) console.log(`BLOCKED_RESOURCE ${e.task}  (冲突 ${e.conflict})`);
  for (const e of out.INTENT_PENDING) console.log(`INTENT_PENDING ${e.task}  (${e.reason})`);
  for (const e of out.READY) {
    // 升级重派必须在文本通道也看得见：执行器读的是 stdout，不是 JSON。
    console.log(e.escalate
      ? `READY    ${e.task}  [升级重派 -> ${e.role}，已打回 ${e.rejections} 次]`
      : `READY    ${e.task}`);
  }
  for (const e of out.UNMAPPED) console.log(`UNMAPPED ${String(e.id).slice(0, 8)}  (${e.reason})`);
  for (const e of out.ORPHAN_INTENT) console.log(`ORPHAN_INTENT ${e.key}  (${e.reason})`);
  for (const e of out.FOREIGN) console.log(`FOREIGN  ${String(e.id).slice(0, 8)} ${e.status}  ${e.name}`);
  for (const r of out.RUNNING) console.log(`RUNNING  ${String(r.id).slice(0, 8)} ${r.name}`);
  console.log(out.lease
    ? `LEASE    owner=${out.lease.owner} gen=${out.lease.generation} ${out.lease.valid ? "有效" : "已过期"} 到期=${out.lease.expiresAt}`
    : "LEASE    (未启用)");
  for (const r of out.holdReasons) console.log(`HOLD     ${r}`);
  console.log(`canDispatchNow: ${out.canDispatchNow.join(", ") || "(空)"}`);
  console.log(`NEXT ${out.nextAction.kind}: ${out.nextAction.reason}`);
  if (out.nextAction.tasks) {
    for (const t of out.nextAction.tasks) {
      console.log(`  - ${typeof t === "string" ? t : `${t.task} <- ${t.branch}`}`);
    }
  }
  // 本轮同时可做的全部动作：逐任务阻塞只压住被点名的任务，不冻结无关任务。
  for (const action of out.nextAction.actions ?? []) {
    if (action === out.nextAction || action.kind === out.nextAction.kind) continue;
    console.log(`ALSO ${action.kind}: ${action.reason}`);
  }
  if (out.DONE.length === tasks.length && tasks.length > 0) console.log("ALL-DONE: 可进入收尾。");
}
