#!/usr/bin/env node
// LEGACY 兜底路径：原生 MCP 派发为默认（见 SKILL.md），本脚本仅在 MCP 不可用时使用。
// LEGACY: completion callback not verified for this path（paseo run --no-wait 未绑定父 agent 通知）。
// 派发入口：从 ~/.paseo/config.json 的 daemon.agentProfiles 机械复制 provider/model/mode/thinking，
// 自动生成 title(≤60)，经 `paseo run` 创建 agent，并把 agentId/起始时间追加进 run-log。
// 目的：模型只传「角色 + 任务 + brief 文件」，参数拼写错误从结构上消失。
//
// Usage: node dispatch.mjs <role|agent_profile_id> <action> <change> <brief-file> [--workspace <id>] [--run-log <path>] [--task <id>] [--attempt <n>] [--phase <phase>] [--dry-run] [--wait]
// Example: node dispatch.mjs anchasi "T4 审查" session-lifecycle brief.md --workspace wks_xxx
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ALIAS = {
  lead: "shangshu", shangshu: "shangshu", pm: "chanpin", chanpin: "chanpin",
  runner: "gongbu", gongbu: "gongbu", tester: "ceshi", ceshi: "ceshi",
  auditor: "anchasi", anchasi: "anchasi", senior: "gaogong", gaogong: "gaogong",
  scout: "mige", mige: "mige", critic: "yushi", yushi: "yushi", architect: "hanlin", hanlin: "hanlin",
  arbiter: "dalisi", dalisi: "dalisi", light: "qingqibing", qingqibing: "qingqibing",
  sentry: "xunjian", xunjian: "xunjian",
};
const ROLE_LABEL = {
  shangshu: "总控", chanpin: "产品", gongbu: "Runner", ceshi: "Tester", anchasi: "Auditor",
  gaogong: "Senior", mige: "Scout", yushi: "Critic", hanlin: "Architect", dalisi: "Arbiter",
  qingqibing: "Runner", xunjian: "巡检", dalisi_gemini: "Arbiter",
};
const READ_ONLY = new Set(["anchasi", "yushi", "dalisi", "dalisi_gemini", "mige"]);
const SILENT = "Do not call memory/MCP knowledge tools; read only files under cwd; no network.";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const bool = (n) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
const workspace = flag("--workspace");
const runLog = flag("--run-log");
const task = flag("--task");
const attempt = flag("--attempt");
const phase = flag("--phase");
const dry = bool("--dry-run");
const wait = bool("--wait");
const [roleArg, action, change, briefFile] = args;

if (!roleArg || !action || !change || !briefFile) {
  console.error("Usage: node dispatch.mjs <role> <action> <change> <brief-file> [--workspace <id>] [--run-log <path>] [--task <id>] [--attempt <n>] [--phase <phase>] [--dry-run] [--wait]");
  process.exit(1);
}

const key = (ALIAS[roleArg] || roleArg.replace(/^agent_profile_/, ""));
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".paseo", "config.json"), "utf8"));
const profiles = cfg?.daemon?.agentProfiles || [];
const p = profiles.find((x) => x.id === `agent_profile_${key}`);
if (!p) {
  console.error(`[dispatch] 未知角色 '${roleArg}'。可用: ${profiles.map((x) => x.id.replace("agent_profile_", "")).join(", ")}`);
  process.exit(1);
}
if (!fs.existsSync(briefFile)) {
  console.error(`[dispatch] brief 文件不存在: ${briefFile}`);
  process.exit(1);
}

const title = `[Pipeline] ${ROLE_LABEL[key] || key} ${action} ${change}`.slice(0, 60);
let brief = fs.readFileSync(briefFile, "utf8");
if (READ_ONLY.has(key) && !brief.includes(SILENT)) brief += `\n\nConstraints: ${SILENT}\n`;

// profile 的 featureValues 仅适用原生 create_agent，CLI 无法逐字复制，忽略并在 notice 说明。
const NOTICE = "LEGACY: completion callback not verified for this path (paseo run --no-wait); profile featureValues not applicable to CLI dispatch, ignored.";
console.error(`[dispatch] ${NOTICE}`);

const cli = ["run", "--no-wait", "--title", title, "--provider", `${p.provider}/${p.model}`];
if (p.modeId && p.provider !== "pi") cli.push("--mode", p.modeId);
if (p.thinkingOptionId) cli.push("--thinking", p.thinkingOptionId);
if (workspace) cli.push("--workspace", workspace);
cli.push("--label", `pipeline.change=${change}`, "--label", `pipeline.role=${key}`);
if (task) cli.push("--label", `pipeline.task=${task}`);
if (attempt) cli.push("--label", `pipeline.attempt=${attempt}`);
if (phase) cli.push("--label", `pipeline.phase=${phase}`);
cli.push("-q", brief);

if (dry) {
  console.log(JSON.stringify({ profile: p.id, title, legacy: true, notice: NOTICE, argv: cli.slice(0, -1), briefBytes: brief.length }, null, 2));
  process.exit(0);
}

const started = new Date().toISOString();
let out;
try {
  out = execFileSync("paseo", cli, { encoding: "utf8" }).trim();
} catch (e) {
  console.error(`[dispatch] paseo run 失败: ${(e.stderr || e.message || "").toString().trim()}`);
  process.exit(2);
}
const agentId = out.split(/\s+/).pop();

const logPath = runLog || path.join("openspec", "changes", change, "run-log.md");
if (fs.existsSync(path.dirname(logPath))) {
  fs.appendFileSync(logPath, `- ${started} 派发 ${key}(${p.id}, ${p.provider}/${p.model}, ${p.modeId}, ${p.thinkingOptionId || "-"}) agent=${agentId} title="${title}"\n`);
}
console.log(`[dispatch] ok role=${key} agent=${agentId} title="${title}" started=${started}`);

if (wait) {
  try { execFileSync("paseo", ["wait", agentId], { stdio: "inherit" }); } catch { process.exit(3); }
}
