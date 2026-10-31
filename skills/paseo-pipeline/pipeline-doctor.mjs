#!/usr/bin/env node
// 开工前环境自检：把「配置漂移到跑起来才暴露」前移成一条命令。
//
// 实测过的返工来源（2026-10-31 沙盒端到端演练）：
//   - claude provider 没有 `auto-review` 模式，profile 写了它，派发才报错；
//   - 写手与审计同为 claude provider，merge-task 因异构闸门 exit 38；
//   - 目标仓库里没有 `skills/paseo-pipeline/`，相对路径命令全部 Cannot find module。
// 它只读，不改任何配置；每一项独立判定，全部跑完再汇总，退出码非 0 即有阻断。
//
// 用法:
//   node pipeline-doctor.mjs [--config <paseo config.json>] [--settings <claude settings.json>] [--json]
// 退出码: 0 全通过（可有 WARN） · 1 有 FAIL
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const json = argv.includes('--json');
function opt(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}
const configPath = opt('--config', path.join(os.homedir(), '.paseo', 'config.json'));
const settingsPath = opt('--settings', path.join(os.homedir(), '.claude', 'settings.json'));

const REQUIRED_PROFILES = [
  'shangshu', 'chanpin', 'hanlin', 'ceshi', 'gongbu', 'gaogong', 'anchasi', 'jiangzuo',
].map((name) => `agent_profile_${name}`);
// 写代码/写测试的角色：异构闸门拿它们的 provider 与审计员的 provider 比较。
const WRITER_PROFILES = ['agent_profile_gongbu', 'agent_profile_gaogong', 'agent_profile_ceshi'];
const DEFAULT_WRITER = 'agent_profile_gongbu';
const AUDITOR_PROFILE = 'agent_profile_anchasi';
// `paseo provider ls` 只给展示名，不给模式 ID，所以这里固定一张表；provider 升级加模式时更新这里。
const MODES = {
  claude: ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'],
  codex: ['auto', 'auto-review', 'full-access'],
};
const OPENSPEC_VERSION = '1.8.0';

const results = [];
function record(status, name, detail) { results.push({ status, name, detail }); }
const pass = (name, detail = '') => record('PASS', name, detail);
const warn = (name, detail) => record('WARN', name, detail);
const fail = (name, detail) => record('FAIL', name, detail);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return { __error: error.message }; }
}

// 1. PIPELINE_HOME
const home = process.env.PIPELINE_HOME;
if (!home) {
  fail('PIPELINE_HOME', `未设置。在 ~/.zshrc 导出：export PIPELINE_HOME="${SKILL_DIR}"`);
} else if (path.resolve(home) !== SKILL_DIR) {
  fail('PIPELINE_HOME', `指向 ${home}，但本脚本位于 ${SKILL_DIR}`);
} else {
  pass('PIPELINE_HOME', home);
}

// 2. profile 完整性、provider/mode 合法性
const config = readJson(configPath);
let profiles = new Map();
if (config.__error) {
  fail('paseo config', `${configPath} 无法读取：${config.__error}`);
} else {
  const list = config?.daemon?.agentProfiles;
  if (!Array.isArray(list)) {
    fail('agentProfiles', `${configPath} 缺少 daemon.agentProfiles 数组`);
  } else {
    profiles = new Map(list.map((entry) => [entry.id, entry]));
    const missing = REQUIRED_PROFILES.filter((id) => !profiles.has(id));
    if (missing.length > 0) fail('profile 齐全', `缺少：${missing.join(', ')}`);
    else pass('profile 齐全', `${REQUIRED_PROFILES.length} 个`);

    const badModes = [];
    for (const id of REQUIRED_PROFILES) {
      const entry = profiles.get(id);
      if (!entry) continue;
      const allowed = MODES[entry.provider];
      if (!allowed) {
        badModes.push(`${id}: 未知 provider「${entry.provider}」`);
      } else if (entry.modeId !== undefined && !allowed.includes(entry.modeId)) {
        badModes.push(`${id}: ${entry.provider} 不支持 modeId「${entry.modeId}」（可选 ${allowed.join('/')}）`);
      }
    }
    if (badModes.length > 0) fail('modeId 合法', badModes.join('；'));
    else pass('modeId 合法');
  }
}

// 3. 异构：审计员 provider 必须异于每个写手（merge-task 因子 3c 只比 provider，同族 exit 38）
const auditor = profiles.get(AUDITOR_PROFILE);
if (auditor) {
  const clash = WRITER_PROFILES
    .map((id) => profiles.get(id))
    .filter((entry) => entry && entry.provider === auditor.provider)
    .map((entry) => entry.id);
  const note = `审计员 provider=${auditor.provider}，与 ${clash.join(', ')} 相同：`
    + '这些角色写的任务合流时会被 merge-task 以 exit 38 拒绝';
  if (clash.includes(DEFAULT_WRITER)) {
    // 默认写手冲突：几乎每个任务都会撞闸门，阻断。
    fail('审计异构', note);
  } else if (clash.length > 0) {
    // 升级（gaogong）与严格档测试（ceshi）路径：只在派这些角色时才撞，提示不阻断。
    warn('审计异构', `${note}；派这些角色前须改用异构审计员`);
  } else {
    pass('审计异构', `审计 ${auditor.provider}，写手均不同`);
  }
}

// 4. scope-guard hook 已装
const settings = readJson(settingsPath);
if (settings.__error) {
  fail('scope-guard hook', `${settingsPath} 无法读取：${settings.__error}`);
} else {
  const hooks = JSON.stringify(settings.hooks ?? {});
  const hookScript = path.join(SKILL_DIR, 'hooks', 'scope-guard-hook.mjs');
  if (!hooks.includes('scope-guard-hook.mjs')) {
    fail('scope-guard hook', `${settingsPath} 的 hooks 里没有 scope-guard-hook.mjs`);
  } else if (!hooks.includes(hookScript)) {
    fail('scope-guard hook', `已注册但路径不是 ${hookScript}`);
  } else {
    pass('scope-guard hook', 'PreToolUse 已注册');
  }
}

// 5. 外部命令
function version(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}
const openspec = version('openspec', ['--version']);
if (openspec === null) fail('openspec', '不在 PATH（~/.local/opt/node/bin 是否已加入 PATH）');
else if (openspec !== OPENSPEC_VERSION) fail('openspec', `版本 ${openspec}，schema 副本基于 ${OPENSPEC_VERSION}`);
else pass('openspec', openspec);

for (const cmd of ['codex', 'paseo', 'git']) {
  if (version(cmd, ['--version']) === null) fail(cmd, '不在 PATH');
  else pass(cmd);
}

// --- 输出 ---
const failed = results.filter((r) => r.status === 'FAIL').length;
if (json) {
  console.log(JSON.stringify({ ok: failed === 0, results }, null, 2));
} else {
  for (const r of results) console.log(`${r.status.padEnd(4)} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(failed === 0 ? 'RESULT 环境就绪' : `RESULT ${failed} 项失败，修复后重跑`);
}
process.exit(failed === 0 ? 0 : 1);
