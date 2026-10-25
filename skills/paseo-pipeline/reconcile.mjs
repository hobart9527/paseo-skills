#!/usr/bin/env node
// 无状态对账：只读。以 tasks.md Done 行 + git 分支 + `paseo ls` 为真源，算出下一步，
// 不依赖任何编排者的存活或完成通知。Lead 挂了、通知丢了，谁再调一次结果都一样。
//
// Usage: node reconcile.mjs <change> [--cap 3] [--json]
// 在集成 workspace（integration/<change>）内运行。
// 输出分组：
//   READY    依赖已满足、未完成、无在跑 agent、无待合流分支 → 可派发
//   MERGE    已有 task/<change>/<id>[-aN] 或 pod/<change> 分支领先集成分支、任务未勾选 → 先走 merge-task
//   RUNNING  带 pipeline.change=<change> 标签且 status=running 的 agent
//   DONE     已勾选
//   BLOCKED  依赖未满足
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const capIdx = args.indexOf("--cap");
const cap = capIdx >= 0 ? Number(args[capIdx + 1]) : 3;
const change = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--cap");
if (!change) {
  console.error("Usage: node reconcile.mjs <change> [--cap 3] [--json]");
  process.exit(1);
}

const tasksFile = path.join("openspec", "changes", change, "tasks.md");
if (!fs.existsSync(tasksFile)) {
  console.error(`[reconcile] 找不到 ${tasksFile}（请在集成 workspace 根目录运行）`);
  process.exit(1);
}

// --- 解析 tasks.md ---
const lines = fs.readFileSync(tasksFile, "utf8").split("\n");
const tasks = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\s*-\s*\[([ xX])\]\s*(\d+(?:\.\d+)*)\s+(T[\w-]+)?\s*(.*)$/);
  if (!m) continue;
  const t = { num: m[2], tid: m[3] || null, title: m[4].trim(), done: m[1] !== " ", depends: "", scope: "" };
  for (let j = i + 1; j < lines.length && !/^\s*-\s*\[/.test(lines[j]) && !/^##/.test(lines[j]); j++) {
    const d = lines[j].match(/^\s*-\s*Depends on:\s*(.*)$/);
    if (d) t.depends = d[1];
    const w = lines[j].match(/^\s*-\s*Write scope:\s*(.*)$/);
    if (w) t.scope = w[1];
  }
  tasks.push(t);
}
const ids = (t) => [t.num, t.tid].filter(Boolean);
const doneIds = new Set(tasks.filter((t) => t.done).flatMap(ids));
const depsOf = (t) => {
  if (!t.depends || /^none\b/i.test(t.depends.trim())) return [];
  return [...t.depends.matchAll(/\b(T[\w-]+|\d+(?:\.\d+)+)\b/g)].map((m) => m[1]);
};
// 一个依赖项只要命中某任务的任一编号，就看该任务是否完成
const taskOf = (ref) => tasks.find((t) => ids(t).includes(ref));
const depOk = (ref) => {
  const t = taskOf(ref);
  return t ? t.done : doneIds.has(ref);
};

// --- 待合流分支 ---
const sh = (cmd, a) => {
  try { return execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; }
};
const branches = sh("git", ["for-each-ref", "--format=%(refname:short)", `refs/heads/task/${change}/`, `refs/heads/pod/${change}`])
  .split("\n").filter(Boolean);
const unmerged = branches.filter((b) => Number(sh("git", ["rev-list", "--count", `HEAD..${b}`]) || 0) > 0);
const branchTask = (b) => {
  const seg = b.split("/")[2] || "";
  return seg.replace(/-a\d+$/, "");
};

// --- 在跑 agent ---
let running = [];
try {
  const raw = execFileSync("paseo", ["ls", "--json", "--label", `pipeline.change=${change}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  running = JSON.parse(raw).filter((a) => a.status === "running").map((a) => ({ id: a.id, name: a.name }));
} catch { /* paseo 不可用时，只依据 git 与 tasks.md 对账 */ }

const mergeTasks = new Set(unmerged.map(branchTask));
const out = { change, cap, DONE: [], MERGE: [], RUNNING: running, READY: [], BLOCKED: [] };
for (const t of tasks) {
  const label = `${t.tid || t.num} ${t.title}`;
  if (t.done) { out.DONE.push(label); continue; }
  const br = unmerged.find((b) => ids(t).some((id) => branchTask(b) === id || branchTask(b) === id.replace(/^T/, "T-")));
  if (br) { out.MERGE.push({ task: label, branch: br }); continue; }
  const blockedBy = depsOf(t).filter((r) => !depOk(r));
  if (blockedBy.length) { out.BLOCKED.push({ task: label, waitFor: blockedBy }); continue; }
  out.READY.push({ task: label, scope: t.scope });
}
const room = Math.max(0, cap - running.length);
out.canDispatchNow = out.READY.slice(0, room).map((r) => r.task);
out.integrationHead = sh("git", ["rev-parse", "--short", "HEAD"]);
out.behindMain = Number(sh("git", ["rev-list", "--count", "HEAD..main"]) || 0);

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`[reconcile] ${change} head=${out.integrationHead} behindMain=${out.behindMain} cap=${cap} running=${running.length}`);
  console.log(`DONE ${out.DONE.length}/${tasks.length}`);
  for (const m of out.MERGE) console.log(`MERGE   ${m.task}  <- ${m.branch}`);
  for (const r of out.RUNNING) console.log(`RUNNING ${r.id.slice(0, 8)} ${r.name}`);
  for (const r of out.READY) console.log(`READY   ${r.task}`);
  for (const b of out.BLOCKED) console.log(`BLOCKED ${b.task}  (等 ${b.waitFor.join(",")})`);
  if (!out.MERGE.length && !out.READY.length && !running.length && out.BLOCKED.length === 0 && out.DONE.length === tasks.length)
    console.log("ALL-DONE: 可进入收尾。");
}
