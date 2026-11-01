// pipeline-doctor 回归：配置漂移必须在开工前被一条命令拦下，而不是派发或合流时才报错。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DOCTOR = path.join(SKILL_DIR, 'pipeline-doctor.mjs');

const IDS = ['shangshu', 'chanpin', 'hanlin', 'ceshi', 'gongbu', 'gaogong', 'anchasi', 'jiangzuo'];

function profile(name, provider, modeId = 'auto') {
  return { id: `agent_profile_${name}`, provider, model: 'x', modeId };
}

/** 健康基线：写手 claude，审计 codex。 */
function healthy() {
  return IDS.map((name) => profile(name, name === 'anchasi' ? 'codex' : 'claude'));
}

const HOOK = path.join(SKILL_DIR, 'hooks', 'scope-guard-hook.mjs');
const TIER_HOOK = path.join(SKILL_DIR, 'hooks', 'tier-reminder-hook.mjs');

/** 把绝对 HOOK 路径换成真实 settings.json 里常见的可移植写法。 */
function portableHook(style, hook = HOOK) {
  const home = os.homedir();
  if (!hook.startsWith(home)) return hook;
  const prefixes = { dollar: '$HOME', brace: '${HOME}', tilde: '~', absolute: home };
  return `${prefixes[style]}${hook.slice(home.length)}`;
}

function hookSettings(command) {
  return { hooks: { PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command }] }] } };
}

/**
 * 健康基线 = install.sh 实际写出的两条 hook（含 matcher）。
 * 只装 scope-guard 不算健康：tier-reminder 缺失时，分级提醒不会出现在决策点上。
 */
function installedHooks() {
  return {
    hooks: {
      PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: `node ${HOOK}` }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node ${TIER_HOOK}` }] }],
    },
  };
}

/** 健康基线，但把某一条 hook 的 command 换成待测写法（每次返回新对象，不互相污染）。 */
function withCommand({ scopeGuard, tier }) {
  const settings = installedHooks();
  if (scopeGuard !== undefined) settings.hooks.PreToolUse[0].hooks[0].command = scopeGuard;
  if (tier !== undefined) settings.hooks.UserPromptSubmit[0].hooks[0].command = tier;
  return settings;
}

/** 从 settings 里删掉指向某个 hook 脚本的条目（模拟「只装了一条」）。 */
function withoutHook(settings, script) {
  const name = path.basename(script);
  const next = { hooks: {} };
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = groups
      .map((entry) => ({ ...entry, hooks: (entry.hooks ?? []).filter((hook) => !String(hook.command).includes(name)) }))
      .filter((entry) => entry.hooks.length > 0);
    next.hooks[event] = kept;
  }
  return next;
}

// tier-gate 的开关与上限来自环境变量：先清掉调用者 shell 里可能有的残留，用例里再显式给，
// 否则 doctor 报的「生效/关闭」取决于跑测试的人机器上碰巧设了什么。
const TIER_ENV = ['PIPELINE_TIER_GATE', 'PIPELINE_TIER_GATE_LIMIT', 'PIPELINE_TIER_GATE_STATE'];

function run(profiles, { settings, env = {}, zshenv = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
  const config = path.join(dir, 'config.json');
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(config, JSON.stringify({ daemon: { agentProfiles: profiles } }));
  fs.writeFileSync(settingsFile, JSON.stringify(settings ?? installedHooks()));
  // 非交互检查读的是 `zsh -c` 下的 $HOME/.zshenv；用临时 HOME 才能既正反两向断言，
  // 又不去碰真实 home。`--home` 同时把这个 HOME 交给 config/settings 的默认路径。
  if (zshenv) {
    fs.writeFileSync(path.join(dir, '.zshenv'), `export PIPELINE_HOME=${JSON.stringify(SKILL_DIR)}\n`);
  }
  const base = { ...process.env, PIPELINE_HOME: SKILL_DIR };
  for (const key of TIER_ENV) delete base[key];
  const result = spawnSync(process.execPath, [DOCTOR, '--config', config, '--settings', settingsFile, '--home', dir], {
    encoding: 'utf8',
    env: { ...base, ...env },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

// 外部命令（openspec/codex/paseo）取决于运行机器，断言只看与配置相关的行，不看总退出码。
const line = (out, name) => out.split('\n').find((l) => l.includes(name)) ?? '';

test('healthy profile set passes every config-derived check', () => {
  const { out } = run(healthy());
  for (const name of ['profile 齐全', 'modeId 合法', 'scope-guard hook', 'tier-reminder hook', 'tier-gate', 'PIPELINE_HOME', '非交互 PIPELINE_HOME']) {
    assert.match(line(out, name), /^PASS/, `${name}\n${out}`);
  }
});

// tier-reminder 漏装时，分级提醒不会出现在「该不该动手」的决策点上，而 scope-guard 那行照样 PASS。
// 两条 hook 是两种故障，必须分别可见；合成一行会让人以为装好了。
test('missing tier-reminder hook registration is rejected while scope-guard still passes', () => {
  const { code, out } = run(healthy(), { settings: withoutHook(installedHooks(), TIER_HOOK) });
  assert.equal(code, 1);
  assert.match(line(out, 'tier-reminder hook'), /^FAIL.*tier-reminder-hook\.mjs.*install\.sh/);
  assert.match(line(out, 'scope-guard hook'), /^PASS/);
});

test('tier-reminder hook registered under the wrong event is rejected', () => {
  // 挂到 PreToolUse 上不会报错，但 UserPromptSubmit 永远不会触发它。
  const settings = { hooks: { ...installedHooks().hooks, UserPromptSubmit: [], PreToolUse: [
    ...installedHooks().hooks.PreToolUse,
    { matcher: 'Write|Edit', hooks: [{ type: 'command', command: `node ${TIER_HOOK}` }] },
  ] } };
  const { code, out } = run(healthy(), { settings });
  assert.equal(code, 1);
  assert.match(line(out, 'tier-reminder hook'), /^FAIL.*hooks\.UserPromptSubmit/);
});

// tier-gate 默认开，并且默认生效这件事本身要看得见：否则用户不知道它拦在哪里，
// 也不知道一条 `PIPELINE_TIER_GATE=off` 把它关掉了（排障残留）。
test('tier-gate reports effective default-on state with the shared default limit', async () => {
  const { DEFAULT_LIMIT } = await import('../lib/tier-gate.mjs');
  const { out } = run(healthy());
  const row = line(out, 'tier-gate');
  assert.match(row, /^PASS/);
  assert.match(row, /生效/);
  assert.match(row, new RegExp(`第 ${DEFAULT_LIMIT + 1} 个`), `上限必须来自 lib/tier-gate.mjs 的默认值\n${row}`);
  assert.doesNotMatch(row, /关闭/);
});

test('tier-gate off is reported as a deliberate opt-out, not a silent pass', () => {
  const { out } = run(healthy(), { env: { PIPELINE_TIER_GATE: 'off' } });
  const row = line(out, 'tier-gate');
  assert.match(row, /^PASS/);
  assert.match(row, /PIPELINE_TIER_GATE=off/);
  assert.match(row, /关闭/);
});

// 上限不是静默忽略，也不是「只认纯整数」：真实解析是 `Number.parseInt(raw, 10)`，所以前导
// 十进制整数生效、尾巴被忽略，没有前导整数或 <1 才回落默认值。doctor 与拦截必须同一条口径，
// 所以这里不是断言「报了什么文案」，而是把 doctor 报出的阈值与访问器真实判定的阈值逐一对齐。
test('tier-gate limit parsing matches the gate for every documented input', async () => {
  const { DEFAULT_LIMIT } = await import('../lib/tier-gate.mjs');
  const cases = [
    // [输入, 期望生效上限, 说明]
    ['7abc', 7, '前导整数生效，尾巴忽略'],
    ['1.5', 1, '小数被截断成前导整数'],
    ['abc', DEFAULT_LIMIT, '没有前导整数 → 回落默认值'],
    ['0', DEFAULT_LIMIT, '小于 1 → 回落默认值'],
    [' 4 ', 4, '两侧空白由 parseInt 吃掉'],
  ];
  for (const [raw, expected, why] of cases) {
    const { out } = run(healthy(), { env: { PIPELINE_TIER_GATE_LIMIT: raw } });
    const row = line(out, 'tier-gate');
    assert.match(row, new RegExp(`第 ${expected + 1} 个`), `LIMIT=${JSON.stringify(raw)}（${why}）应生效为 ${expected}\n${row}`);
  }
  // 有意义的值正常报 PASS；落回默认值的两种要 FAIL，让「设了但没生效」可见。
  assert.match(line(run(healthy(), { env: { PIPELINE_TIER_GATE_LIMIT: '7abc' } }).out, 'tier-gate'), /^PASS/);
  assert.match(line(run(healthy(), { env: { PIPELINE_TIER_GATE_LIMIT: '1.5' } }).out, 'tier-gate'), /^PASS/);
  assert.match(line(run(healthy(), { env: { PIPELINE_TIER_GATE_LIMIT: ' 4 ' } }).out, 'tier-gate'), /^PASS/);
  for (const raw of ['abc', '0']) {
    const { code, out } = run(healthy(), { env: { PIPELINE_TIER_GATE_LIMIT: raw } });
    assert.equal(code, 1, out);
    assert.match(line(out, 'tier-gate'), /^FAIL/, `LIMIT=${JSON.stringify(raw)} 应报 FAIL\n${out}`);
  }
});

// 同一组输入也要对得上真实拦截：访问器在同一个上限下只放行 limit 个文件。
test('the limit doctor reports is the limit the gate actually enforces', async () => {
  const { assessTierGate } = await import('../lib/tier-gate.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-gate-enforce-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'seed'), 'seed');
  git('add', '.');
  git('commit', '-q', '-m', 'seed');

  const prev = { limit: process.env.PIPELINE_TIER_GATE_LIMIT, state: process.env.PIPELINE_TIER_GATE_STATE, off: process.env.PIPELINE_TIER_GATE };
  try {
    process.env.PIPELINE_TIER_GATE_STATE = path.join(dir, 'state');
    delete process.env.PIPELINE_TIER_GATE;
    for (const [raw, expected] of [['7abc', 7], ['1.5', 1], ['abc', 3], ['0', 3], [' 4 ', 4]]) {
      fs.rmSync(process.env.PIPELINE_TIER_GATE_STATE, { recursive: true, force: true });
      process.env.PIPELINE_TIER_GATE_LIMIT = raw;
      // doctor 报出来的阈值。
      const reported = Number(new RegExp(`第 (\\d+) 个`).exec(line(run(healthy(), { env: { PIPELINE_TIER_GATE_LIMIT: raw } }).out, 'tier-gate'))[1]) - 1;
      assert.equal(reported, expected, `LIMIT=${JSON.stringify(raw)} 的报告中阈值`);
      // 真实拦截阈值：第 expected 个放行，第 expected+1 个拒绝。
      for (let i = 0; i < expected; i += 1) {
        assert.equal(assessTierGate({ target: path.join(repo, `f${i}`), sessionId: `s-${raw}` }).verdict, 'allow', `${raw} 第 ${i + 1} 个应放行`);
      }
      assert.equal(assessTierGate({ target: path.join(repo, `f${expected}`), sessionId: `s-${raw}` }).verdict, 'deny', `${raw} 第 ${expected + 1} 个应拒绝`);
    }
  } finally {
    for (const [key, value] of [['PIPELINE_TIER_GATE_LIMIT', prev.limit], ['PIPELINE_TIER_GATE_STATE', prev.state], ['PIPELINE_TIER_GATE', prev.off]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 这一项判的是「daemon 起的 agent 能不能读到」：只看当前进程的 PIPELINE_HOME 不够，
// ~/.zshrc 的导出让交互终端通过、却让非交互 agent 全挂（2026-10-31 实测）。
test('non-interactive zsh without PIPELINE_HOME fails with the install.sh hint', () => {
  const { code, out } = run(healthy(), { zshenv: false });
  assert.equal(code, 1);
  const row = line(out, '非交互 PIPELINE_HOME');
  assert.match(row, /^FAIL/);
  assert.match(row, /install\.sh/);
  // 当前进程那一项仍然是 PASS：两项分别回答「这个进程」与「新起的 shell」。
  assert.match(out, /^PASS PIPELINE_HOME/m);
});

test('non-interactive zsh pointing at another checkout is rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-wrong-'));
  fs.writeFileSync(path.join(dir, '.zshenv'), 'export PIPELINE_HOME="/nonexistent/paseo-pipeline"\n');
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ daemon: { agentProfiles: healthy() } }));
  const result = spawnSync(process.execPath, [DOCTOR, '--config', config, '--settings', path.join(dir, 'nope.json'), '--home', dir], {
    encoding: 'utf8',
    env: { ...process.env, PIPELINE_HOME: SKILL_DIR },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  const row = (result.stdout + result.stderr).split('\n').find((l) => l.includes('非交互 PIPELINE_HOME'));
  assert.match(row, /^FAIL.*\/nonexistent\/paseo-pipeline.*install\.sh/);
});

test('claude profile with codex-only modeId auto-review is rejected', () => {
  const profiles = healthy().map((p) => (p.id.endsWith('gongbu') ? { ...p, modeId: 'auto-review' } : p));
  const { code, out } = run(profiles);
  assert.equal(code, 1);
  assert.match(line(out, 'modeId 合法'), /^FAIL.*gongbu.*auto-review/);
});

test('missing profile is rejected', () => {
  const { code, out } = run(healthy().filter((p) => !p.id.endsWith('jiangzuo')));
  assert.equal(code, 1);
  assert.match(line(out, 'profile 齐全'), /^FAIL.*agent_profile_jiangzuo/);
});

test('missing scope-guard hook registration is rejected', () => {
  const { code, out } = run(healthy(), { settings: { hooks: {} } });
  assert.equal(code, 1);
  assert.match(line(out, 'scope-guard hook'), /^FAIL/);
});

// 同一条 command 挂在 matcher=Bash 上时，Write/Edit 没人守护。旧实现只在 hooks 的 JSON 文本
// 里找字符串，于是这种情况 PASS——门禁假绿比没装更糟，因为它会让人停手不再检查。
test('scope-guard registered under a non-matching matcher is rejected', () => {
  const settings = {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${HOOK}` }] }] },
  };
  const { code, out } = run(healthy(), { settings });
  assert.equal(code, 1);
  assert.match(line(out, 'scope-guard hook'), /^FAIL.*matcher/);
});

// 命令是 shell 语句，不是一段文本：判据必须按 token 解析到「哪个解释器跑哪个脚本」。
// 旧实现按子串判，`echo "<script>"`、`# node "<script>"` 这类根本没跑脚本的写法照样 PASS，
// 而 `node "<script>.bak"` 这种「差不多」的写法也会被同一条子串规则放过——门禁假绿比没装更糟。
for (const [label, script, key] of [
  ['scope-guard', HOOK, 'scopeGuard'],
  ['tier-reminder', TIER_HOOK, 'tier'],
]) {
  // 正例：install.sh 写出的形状、用户手装的等价写法（引号/无引号/四种家目录写法）、尾随参数。
  const positive = [
    ['bare', `node ${script}`],
    ['quoted', `node ${JSON.stringify(script)}`],
    ...['dollar', 'brace', 'tilde', 'absolute'].map((style) => [style, `node ${JSON.stringify(portableHook(style, script))}`]),
    ['trailing args', `node ${JSON.stringify(script)} --install-help`],
  ];
  for (const [shape, command] of positive) {
    test(`${label} hook: ${shape} command is accepted`, () => {
      const { out } = run(healthy(), { settings: withCommand({ [key]: command }) });
      assert.match(line(out, `${label} hook`), /^PASS/, `command=${command}\n${out}`);
    });
  }

  // 反例：这些 command 一个脚本都不会跑，或者跑的是别的文件——必须是 FAIL。
  const negative = [
    ['echo', `echo ${JSON.stringify(script)}`],
    ['commented out', `# node ${JSON.stringify(script)}`],
    ['.bak sibling', `node ${JSON.stringify(`${script}.bak`)}`],
  ];
  for (const [shape, command] of negative) {
    test(`${label} hook: ${shape} command is rejected`, () => {
      const { code, out } = run(healthy(), { settings: withCommand({ [key]: command }) });
      assert.equal(code, 1, out);
      assert.match(line(out, `${label} hook`), /^FAIL/, `command=${command}\n${out}`);
    });
  }
}

// 上面那组四种家目录写法借了真实 home：checkout 不在 HOME 下时 portableHook 会退化成四条
// 相同的绝对路径，「$HOME 能展开」这件事就没人测了。这里把 HOME 换成受控目录，在其下软链
// skill 目录，于是四种写法在**任何 checkout 位置**都是真正的家目录形态，并且由 realpath
// 落到同一个脚本。同时断言受控 HOME ≠ 进程 HOME：否则夹具又变成同一条绝对路径。
test('the four home forms are accepted under a controlled HOME, not only when the checkout lives in the real home', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-home-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fakeHome = path.join(dir, 'home');
  fs.mkdirSync(path.join(fakeHome, 'skills'), { recursive: true });
  fs.symlinkSync(SKILL_DIR, path.join(fakeHome, 'skills', 'paseo-pipeline'), 'dir');
  assert.notEqual(path.resolve(fakeHome), path.resolve(os.homedir()), '受控 HOME 必须与进程 HOME 不同，否则这组用例退化成绝对路径');

  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ daemon: { agentProfiles: healthy() } }));
  fs.writeFileSync(path.join(dir, '.zshenv'), `export PIPELINE_HOME=${JSON.stringify(SKILL_DIR)}\n`);

  const forms = {
    '$HOME': '$HOME/skills/paseo-pipeline/hooks/scope-guard-hook.mjs',
    '${HOME}': '${HOME}/skills/paseo-pipeline/hooks/scope-guard-hook.mjs',
    '~/': '~/skills/paseo-pipeline/hooks/scope-guard-hook.mjs',
    'tier ~/': '~/skills/paseo-pipeline/hooks/tier-reminder-hook.mjs',
  };
  for (const [label, target] of Object.entries(forms)) {
    test(`hook under ${label} expands against HOME and passes`, () => {
      const isTier = label.startsWith('tier');
      const settingsFile = path.join(dir, `settings-${label.replace(/\W/g, '')}.json`);
      fs.writeFileSync(settingsFile, JSON.stringify(isTier
        ? withCommand({ tier: `node ${JSON.stringify(target)}` })
        : withCommand({ scopeGuard: `node ${JSON.stringify(target)}` })));
      // HOME 只作用于 doctor 进程：expandHome 用它展开，--home 仍指临时目录读 config/zshenv。
      const result = spawnSync(process.execPath, [DOCTOR, '--config', config, '--settings', settingsFile, '--home', dir], {
        encoding: 'utf8',
        env: { ...process.env, HOME: fakeHome, PIPELINE_HOME: SKILL_DIR },
      });
      const out = `${result.stdout}${result.stderr}`;
      const row = line(out, isTier ? 'tier-reminder hook' : 'scope-guard hook');
      assert.match(row, /^PASS/, `command=node ${target}\n${out}`);
    });
  }
});

// 软链仍是正例：注册的是 ~/.claude/skills/<link>/hooks/x.mjs，realpath 后与目标同源。
test('hook registered through a symlinked path is accepted', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-hook-link-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'paseo-pipeline');
  fs.symlinkSync(SKILL_DIR, link, 'dir');
  const linked = path.join(link, 'hooks', 'scope-guard-hook.mjs');
  const { out } = run(healthy(), { settings: withCommand({ scopeGuard: `node ${JSON.stringify(linked)}` }) });
  assert.match(line(out, 'scope-guard hook'), /^PASS/, `linked=${linked}\n${out}`);
});

test('scope-guard hook pointing at another directory is rejected', () => {
  const elsewhere = `node "${path.join(os.homedir(), 'elsewhere', 'scope-guard-hook.mjs')}"`;
  const { code, out } = run(healthy(), { settings: hookSettings(elsewhere) });
  assert.equal(code, 1);
  assert.match(line(out, 'scope-guard hook'), /^FAIL/);
});

// 用户把 skill 目录软链进 ~/.claude/skills/ 是常态，而 install.sh 写的是解析后的真实目录。
// 拿未 realpath 的 SKILL_DIR 去比会把正常安装判成「指向别处」（实测）。
test('doctor invoked through a symlinked skill directory still passes', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-link-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'paseo-pipeline');
  fs.symlinkSync(SKILL_DIR, link, 'dir');
  fs.writeFileSync(path.join(dir, '.zshenv'), `export PIPELINE_HOME=${JSON.stringify(SKILL_DIR)}\n`);
  const config = path.join(dir, 'config.json');
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(config, JSON.stringify({ daemon: { agentProfiles: healthy() } }));
  fs.writeFileSync(settingsFile, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: `node ${HOOK}` }] }] },
  }));
  const result = spawnSync(process.execPath, [path.join(link, 'pipeline-doctor.mjs'), '--config', config, '--settings', settingsFile, '--home', dir], {
    encoding: 'utf8',
    env: { ...process.env, PIPELINE_HOME: link },
  });
  const out = `${result.stdout}${result.stderr}`;
  for (const name of ['PIPELINE_HOME', '非交互 PIPELINE_HOME', 'scope-guard hook']) {
    assert.match(line(out, name), /^PASS/, `${name}\n${out}`);
  }
});

test('unset or wrong PIPELINE_HOME is rejected', () => {
  const wrong = run(healthy(), { env: { PIPELINE_HOME: '/nonexistent' } });
  assert.equal(wrong.code, 1);
  assert.match(line(wrong.out, 'PIPELINE_HOME'), /^FAIL/);
});
