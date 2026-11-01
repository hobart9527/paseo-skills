#!/usr/bin/env node
// 开工前环境自检：把「配置漂移到跑起来才暴露」前移成一条命令。
//
// 实测过的返工来源（2026-10-31 沙盒端到端演练）：
//   - claude provider 没有 `auto-review` 模式，profile 写了它，派发才报错；
//   - 目标仓库里没有 `skills/paseo-pipeline/`，相对路径命令全部 Cannot find module。
// 它只读，不改任何配置；每一项独立判定，全部跑完再汇总，退出码非 0 即有阻断。
//
// 用法:
//   node pipeline-doctor.mjs [--config <paseo config.json>] [--settings <claude settings.json>] [--home <HOME>] [--json]
// 退出码: 0 全通过 · 1 有 FAIL
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// 上限的默认值只有一份（判据在 lib/tier-gate.mjs）。这里 import 而不是抄一个 3：
// 抄一份就会在有人改默认值时让 doctor 报告的上限与真实拦截阈值分家。
import { DEFAULT_LIMIT as TIER_DEFAULT_LIMIT } from './lib/tier-gate.mjs';

// 一律比较真实路径：用户常把 skill 目录软链到 ~/.claude/skills/，而 install.sh 写入的是
// 解析后的真实目录；拿未解析的 SKILL_DIR 去比会把正常安装判成「指向别处」（实测）。
// 不存在的路径退回 path.resolve：比较的是「指向哪里」，不是「存在与否」。
function realOrResolve(target) {
  try { return fs.realpathSync(target); } catch { return path.resolve(target); }
}
const SKILL_DIR = realOrResolve(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const json = argv.includes('--json');
function opt(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}
const homeDir = opt('--home', os.homedir());
const configPath = opt('--config', path.join(homeDir, '.paseo', 'config.json'));
const settingsPath = opt('--settings', path.join(homeDir, '.claude', 'settings.json'));

const REQUIRED_PROFILES = [
  'shangshu', 'chanpin', 'hanlin', 'ceshi', 'gongbu', 'gaogong', 'anchasi', 'jiangzuo',
].map((name) => `agent_profile_${name}`);
// `paseo provider ls` 只给展示名，不给模式 ID，所以这里固定一张表；provider 升级加模式时更新这里。
const MODES = {
  claude: ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'],
  codex: ['auto', 'auto-review', 'full-access'],
};
const OPENSPEC_VERSION = '1.8.0';

const results = [];
function record(status, name, detail) { results.push({ status, name, detail }); }
const pass = (name, detail = '') => record('PASS', name, detail);
const fail = (name, detail) => record('FAIL', name, detail);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return { __error: error.message }; }
}

// 1. PIPELINE_HOME（当前进程）
const home = process.env.PIPELINE_HOME;
const installHint = `运行 bash ${path.join(SKILL_DIR, 'install.sh')}`;
if (!home) {
  fail('PIPELINE_HOME', `未设置。${installHint}（装进 ~/.zshenv，不要只写 ~/.zshrc：非交互 shell 读不到）`);
} else if (realOrResolve(home) !== SKILL_DIR) {
  fail('PIPELINE_HOME', `指向 ${home}，但本脚本位于 ${SKILL_DIR}`);
} else {
  pass('PIPELINE_HOME', home);
}

// 1b. 非交互环境可读 PIPELINE_HOME
// 上面一项只看当前进程，而 Paseo daemon 起的 agent 不继承交互终端的变量：`~/.zshrc` 只对
// 交互 shell 生效。装好的落点是 `~/.zshenv`，所以必须在干净的 zsh 里真读一次，而不是相信
// 当前 shell 或文件里「看起来有」的那一行。env -i 清空继承，HOME 指到 --home。
const shellHome = (() => {
  try {
    return execFileSync('zsh', ['-c', 'print -r -- "${PIPELINE_HOME-}"'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { HOME: homeDir, PATH: process.env.PATH ?? '/usr/bin:/bin' },
    }).trim();
  } catch { return null; }
})();
if (shellHome === null) {
  fail('非交互 PIPELINE_HOME', '无法启动 zsh 读取（zsh 是否在 PATH）');
} else if (shellHome === '') {
  fail('非交互 PIPELINE_HOME', `非交互 shell 里为空：${installHint}（装进 ~/.zshenv）`);
} else if (realOrResolve(shellHome) !== SKILL_DIR) {
  fail('非交互 PIPELINE_HOME', `~/.zshenv 指向 ${shellHome}，但本脚本位于 ${SKILL_DIR}；${installHint}`);
} else {
  pass('非交互 PIPELINE_HOME', `~/.zshenv → ${shellHome}`);
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

// 3. 两个 hook 已按 install.sh 的形状注册
//
// 注册值可以是 `$HOME/...`、`${HOME}/...`、`~/...` 或绝对路径——它们由 shell 展开后指向同一个
// 文件，判据要比较**展开后的路径**，不能比较字面量。按字面量比对会把可移植写法误判成漂移，
// 逼着人去把 `$HOME` 换成硬编码用户名，那是往反方向修。
//
// 两条 hook 分开判：漏装 scope-guard 是「写入无人守护」，漏装 tier-reminder 是「分级提醒
// 不会出现在决策点」，两种故障的修法不同，合成一行会丢掉是哪一个没装。
const settings = readJson(settingsPath);

/** 展开 hook 命令里的家目录写法，供路径比对；不识别其它变量（不认识就是原样）。 */
function expandHome(text) {
  return text
    .replace(/\$\{HOME\}/g, os.homedir())
    .replace(/\$HOME(?![A-Za-z0-9_])/g, os.homedir())
    // `~` 只在词首展开（命令开头、空白后、引号后）；词中的 `~` 是普通字符。
    .replace(/(^|[\s"'])~(?=\/)/g, (_, before) => `${before}${os.homedir()}`);
}

/**
 * 按 shell 词法切 token（与 install.sh 同一套规则，缺了它两边判定会分家）：
 * 支持单/双引号、反斜杠转义、空白折叠；引号只影响分词，不进 token。
 */
function shellTokens(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null; else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < command.length && '"\\$`'.includes(command[i + 1])) { current += command[i + 1]; i += 1; }
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (ch === '\\' && i + 1 < command.length) { current += command[i + 1]; i += 1; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started) { tokens.push(current); current = ''; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * 命令是否真的在「用 node 跑目标脚本」：返回 'match' / 'mismatch'（跑了别的文件）/ 'not-node'。
 *
 * 为什么不能按子串判：`echo "<script>"`、`# node "<script>"` 里都有那个路径，但一个脚本都不会跑；
 * `node "<script>.bak"` 更是差之毫厘。字符串包含判定把这三种都放行，于是 hook 实际没装却报绿。
 * 尾随参数不影响判定（hook 支持 `--install-help`）；比较永远是 realpath 后的路径，软链与
 * `$HOME`/`~/` 写法不会被误判成漂移。
 */
function hookCommandVerdict(command, script) {
  const tokens = shellTokens(command);
  if (tokens.length < 2 || !/(^|\/)node(js)?$/.test(tokens[0])) return 'not-node';
  return realOrResolve(expandHome(tokens[1])) === realOrResolve(script) ? 'match' : 'mismatch';
}

/** 某个事件下所有登记项，归一成 {matchers, command}；matchers 为 null 表示 entry 没写 matcher。 */
function hookEntries(event) {
  const groups = settings.hooks?.[event];
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) return [];
    const matchers = entry.matcher === undefined ? null : String(entry.matcher).split('|');
    return entry.hooks
      .filter((hook) => typeof hook?.command === 'string')
      .map((hook) => ({ matchers, command: hook.command }));
  });
}

/**
 * 判一个 hook 是否按 install.sh 的形状注册在指定事件上。
 *
 * `requiredMatchers` 非空时，还要求**同一个 entry** 的 matcher 覆盖全部工具：同一条 command
 * 挂到 matcher=Bash 上时，Write/Edit 实际没人守护（实测过）。
 */
function checkHook(name, { event, script, requiredMatchers = [] }) {
  const hookName = path.basename(script);
  const entries = hookEntries(event);
  // 「提到了这个脚本」与「真的在跑它」分开：前者只用来区分「没装」与「装了但写错」，
  // 后者才是 PASS 的判据。.bak 兄弟文件也算提到（于是报「路径不对」而不是「没装」）。
  const mentioned = entries.filter((entry) => shellTokens(entry.command)
    .some((token) => path.basename(token.replace(/^["']|["']$/g, '')).startsWith(hookName)));
  const guarded = requiredMatchers.length === 0
    ? mentioned
    : mentioned.filter((entry) => requiredMatchers.every((tool) => entry.matchers?.includes(tool)));
  const verdicts = guarded.map((entry) => ({ entry, verdict: hookCommandVerdict(entry.command, script) }));
  const correct = verdicts.filter((item) => item.verdict === 'match');
  const where = `${settingsPath} 的 hooks.${event}`;
  if (mentioned.length === 0) {
    fail(name, `${where} 里没有 ${hookName}（${installHint}）`);
  } else if (guarded.length === 0) {
    fail(name, `已注册但 matcher 未覆盖 ${requiredMatchers.join(' 与 ')}（当前 ${mentioned.map((e) => e.matchers?.join('|') || '(无)').join(', ')}）`);
  } else if (correct.length === 0) {
    // 把「为什么不算」说清：不是 node <路径> 形态，或跑的是同目录的另一个文件。
    const detail = verdicts.map(({ entry, verdict }) => (verdict === 'not-node'
      ? `命令不是 \`node <路径>\` 形态：${entry.command}`
      : `路径不是 ${script}：${entry.command}`)).join('；');
    fail(name, `已注册但不会执行本脚本（${detail}）；${installHint}`);
  } else {
    pass(name, `${event} 已注册${requiredMatchers.length > 0 ? `，matcher 覆盖 ${requiredMatchers.join('/')}` : ''}`);
  }
}

if (settings.__error) {
  // settings.json 读不到时两条 hook 都无法判断：分别记失败，别让其中一个看起来还行。
  fail('scope-guard hook', `${settingsPath} 无法读取：${settings.__error}`);
  fail('tier-reminder hook', `${settingsPath} 无法读取：${settings.__error}`);
} else {
  checkHook('scope-guard hook', {
    event: 'PreToolUse',
    script: path.join(SKILL_DIR, 'hooks', 'scope-guard-hook.mjs'),
    requiredMatchers: ['Write', 'Edit'],
  });
  checkHook('tier-reminder hook', {
    event: 'UserPromptSubmit',
    script: path.join(SKILL_DIR, 'hooks', 'tier-reminder-hook.mjs'),
  });
}

// 3b. tier-gate 的生效状态
//
// tier-gate 默认开：主 checkout 的 main/master 上，单会话写第 limit+1 个不同业务文件即拒绝。
// 它默认生效却零输出，等于「装了、也可能被一条环境变量静默关掉」——doctor 不替用户改环境，
// 只把当前到底拦不拦、拦在第几个文件说出来，让 `PIPELINE_TIER_GATE=off` 这类排障残留可见。
const tierGateOff = process.env.PIPELINE_TIER_GATE === 'off';
const rawTierLimit = process.env.PIPELINE_TIER_GATE_LIMIT;
// 与 lib/tier-gate.mjs 完全同一条解析（parseInt，基 10）：前导十进制整数生效，尾巴被忽略
// （`7abc`→7、`1.5`→1、`" 4 "`→4）；没有前导整数（`abc`）或结果 <1（`0`）才回落到默认值。
// 判据必须与真实拦截阈值同源，否则 doctor 报的上限和实际拦的位置分家。
const parsedTierLimit = Number.parseInt(rawTierLimit ?? '', 10);
const tierLimitValid = Number.isInteger(parsedTierLimit) && parsedTierLimit >= 1;
const effectiveTierLimit = tierLimitValid ? parsedTierLimit : TIER_DEFAULT_LIMIT;
if (tierGateOff) {
  pass('tier-gate', `PIPELINE_TIER_GATE=off — 已整体关闭（排障态）：主 checkout 的 main 上不再按 Tier 1 上限拦截；不需要时取消该变量`);
} else if (!tierLimitValid && rawTierLimit !== undefined && rawTierLimit !== '') {
  // 被忽略的那些值：说清「按哪个上限在拦」，并指出变量当前没起到调上限的作用。
  fail('tier-gate', `PIPELINE_TIER_GATE_LIMIT=${JSON.stringify(rawTierLimit)} 没有前导十进制整数或小于 1，实际按默认上限 ${TIER_DEFAULT_LIMIT} 拦截（第 ${TIER_DEFAULT_LIMIT + 1} 个文件即拒绝）；写成前导 ≥1 的十进制整数（如 7 或 7abc）才能改上限`);
} else {
  const source = tierLimitValid ? `，由 PIPELINE_TIER_GATE_LIMIT=${rawTierLimit} 覆盖` : '（默认上限）';
  pass('tier-gate', `生效：主 checkout 的 main/master 上写第 ${effectiveTierLimit + 1} 个不同业务文件即拒绝${source}`);
}

// 4. 外部命令
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
