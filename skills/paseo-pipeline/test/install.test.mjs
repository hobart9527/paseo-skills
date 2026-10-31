// install.sh 回归：装是「一次配好、之后可重入」，不是「跑一次改一次」。
//
// 每个用例都用 mktemp 出来的临时 HOME：这个脚本会写 ~/.zshenv 和 ~/.claude/settings.json，
// 拿真实 HOME 跑测试等于拿用户的凭据和登录环境做夹具。settings.json 里放一个假 token，
// 断言任何输出都不含它——该文件真实内容含凭据，脚本不得回显。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INSTALL = path.join(SKILL_DIR, 'install.sh');
const SCOPEGUARD = path.join(SKILL_DIR, 'hooks', 'scope-guard-hook.mjs');
const TIER = path.join(SKILL_DIR, 'hooks', 'tier-reminder-hook.mjs');
const FAKE_TOKEN = 'sk-test-CANARY-6f1d2c-do-not-print';

function home(context, { zshenv, settings } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (zshenv !== undefined) fs.writeFileSync(path.join(dir, '.zshenv'), zshenv);
  if (settings !== undefined) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), settings);
  }
  return dir;
}

function install(homeDir, ...args) {
  const result = spawnSync('bash', [INSTALL, ...args], {
    encoding: 'utf8',
    // 显式清掉外层可能已有的 PIPELINE_HOME：默认模式结尾会提示「新开终端」，与用例无关。
    env: { ...process.env, HOME: homeDir, PIPELINE_HOME: undefined },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const read = (file) => fs.readFileSync(file, 'utf8');
const zshenvOf = (dir) => read(path.join(dir, '.zshenv'));
const settingsOf = (dir) => JSON.parse(read(path.join(dir, '.claude', 'settings.json')));
const backups = (dir, name) => fs.readdirSync(dir).filter((f) => f.startsWith(`${name}.bak-`));

function commands(settings, event) {
  return (settings.hooks?.[event] ?? []).flatMap((entry) => entry.hooks ?? []).map((hook) => hook.command);
}

function matchers(settings, event) {
  return (settings.hooks?.[event] ?? []).map((entry) => entry.matcher ?? null);
}

const START = '# >>> paseo-pipeline >>>';
const END = '# <<< paseo-pipeline <<<';

test('首次安装创建 zshenv 标记块与两条 hook', (context) => {
  const dir = home(context);
  const { code, out } = install(dir);
  // 自检依赖外部命令（openspec/codex/paseo），退出码不在这里断言；装没装对看文件。
  assert.ok(code === 0 || code === 1, out);

  const zshenv = zshenvOf(dir);
  assert.match(zshenv, /^# >>> paseo-pipeline >>>$/m);
  assert.match(zshenv, /^# <<< paseo-pipeline <<<$/m);
  // 导出值必须是解析出的真实 skill 目录（这里是从 BASH_SOURCE 推导的同一处）。
  assert.ok(zshenv.includes(`export PIPELINE_HOME=${JSON.stringify(SKILL_DIR)}`), zshenv);

  const settings = settingsOf(dir);
  assert.deepEqual(commands(settings, 'PreToolUse'), [`node ${JSON.stringify(SCOPEGUARD)}`]);
  assert.deepEqual(commands(settings, 'UserPromptSubmit'), [`node ${JSON.stringify(TIER)}`]);
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Write|Edit|MultiEdit|NotebookEdit');
});

test('重复运行第二次零差异（字节级），且不再产生备份', (context) => {
  const dir = home(context);
  install(dir);
  const firstZshenv = zshenvOf(dir);
  const firstSettings = read(path.join(dir, '.claude', 'settings.json'));
  const firstBackups = backups(dir, '.zshenv').length
    + backups(path.join(dir, '.claude'), 'settings.json').length;

  const { out } = install(dir);
  assert.equal(zshenvOf(dir), firstZshenv);
  assert.equal(read(path.join(dir, '.claude', 'settings.json')), firstSettings);
  assert.equal(backups(dir, '.zshenv').length + backups(path.join(dir, '.claude'), 'settings.json').length,
    firstBackups, '无变化时不得产生新备份');
  assert.match(out, /已是目标状态/);
});

test('zshenv 块外已有内容原样保留', (context) => {
  const before = 'export EDITOR=vim\nalias ll="ls -l"\nexport PIPELINE_HOME=/old/place\n';
  const dir = home(context, { zshenv: before });
  install(dir);
  const after = zshenvOf(dir);
  assert.ok(after.startsWith(before), `块外内容必须原样保留：\n${after}`);
  // 旧的无标记导出不自动删（可能是别处的配置），脚本只维护自己那一块。
  assert.equal(after.match(/export PIPELINE_HOME=/g).length, 2);
  assert.match(after, /^export PIPELINE_HOME=\/old\/place$/m);
  assert.match(after, /# >>> paseo-pipeline >>>\nexport PIPELINE_HOME=/);
  // 再跑一次：旧块被替换而不是叠加。
  install(dir);
  assert.equal(zshenvOf(dir), after);
});

test('settings.json 里 env 与其他 hook 原样保留', (context) => {
  const existing = {
    env: { ANTHROPIC_AUTH_TOKEN: FAKE_TOKEN },
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node /opt/other-hook.mjs' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
    },
  };
  const dir = home(context, { settings: `${JSON.stringify(existing, null, 2)}\n` });
  const { out } = install(dir);

  const settings = settingsOf(dir);
  assert.deepEqual(settings.env, existing.env);
  assert.deepEqual(settings.permissions, existing.permissions);
  assert.deepEqual(settings.hooks.Stop, existing.hooks.Stop);
  assert.deepEqual(settings.hooks.PreToolUse[0], existing.hooks.PreToolUse[0], '已有 hook 条目不得改动');
  assert.deepEqual(commands(settings, 'PreToolUse'), ['node /opt/other-hook.mjs', `node ${JSON.stringify(SCOPEGUARD)}`]);
  // 该文件含凭据：脚本的任何输出都不得带上 env 值。
  assert.ok(!out.includes(FAKE_TOKEN), 'install.sh 不得打印 settings.json 里的 env 值');
});

test('--dry-run 不产生任何文件改动', (context) => {
  const dir = home(context, { zshenv: 'export EDITOR=vim\n', settings: `${JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: FAKE_TOKEN } }, null, 2)}\n` });
  const zshenvBefore = zshenvOf(dir);
  const settingsBefore = read(path.join(dir, '.claude', 'settings.json'));
  const { code, out } = install(dir, '--dry-run');

  assert.equal(code, 0);
  assert.equal(zshenvOf(dir), zshenvBefore);
  assert.equal(read(path.join(dir, '.claude', 'settings.json')), settingsBefore);
  assert.equal(backups(dir, '.zshenv').length, 0);
  assert.equal(backups(path.join(dir, '.claude'), 'settings.json').length, 0);
  // 只打印将要发生的变化：zshenv 的块与将新增的 hook，都带上绝对路径。
  assert.match(out, /将写入/);
  assert.match(out, /paseo-pipeline/);
  assert.match(out, /scope-guard-hook\.mjs/);
  assert.match(out, /tier-reminder-hook\.mjs/);
  assert.ok(!out.includes(FAKE_TOKEN), 'dry-run 也不得泄露 env 值');
});

test('--check 按目标状态给出退出码', (context) => {
  const dir = home(context, { zshenv: 'export EDITOR=vim\n' });
  const before = install(dir, '--check');
  assert.equal(before.code, 1, before.out);
  assert.match(before.out, /尚未达到目标状态/);
  assert.equal(backups(dir, '.zshenv').length, 0, '--check 不写文件');

  install(dir);
  const after = install(dir, '--check');
  assert.equal(after.code, 0, after.out);
  assert.match(after.out, /已是目标状态/);
  // --check 不写文件：备份仍只有 install 那一次产生的。
  assert.equal(backups(dir, '.zshenv').length, 1);
});

test('settings.json 非法 JSON 时 exit 3 且文件未改', (context) => {
  const broken = '{ "env": { "ANTHROPIC_AUTH_TOKEN": "' + FAKE_TOKEN + '" }, oops }\n';
  const dir = home(context, { zshenv: 'export EDITOR=vim\n', settings: broken });
  const { code, out } = install(dir);

  assert.equal(code, 3, out);
  assert.equal(read(path.join(dir, '.claude', 'settings.json')), broken);
  assert.equal(backups(path.join(dir, '.claude'), 'settings.json').length, 0);
  assert.ok(!out.includes(FAKE_TOKEN), '解析失败也不得回显原文片段');
  // 两个文件的写入在解析之后：拒绝写入时一个都不动，不会留下「zshenv 装了、hook 没装」的半成品。
  assert.equal(zshenvOf(dir), 'export EDITOR=vim\n');
  assert.equal(backups(dir, '.zshenv').length, 0);
});

test('软链调用时解析到真实目录', (context) => {
  const dir = home(context);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const link = path.join(bin, 'install');
  fs.symlinkSync(INSTALL, link);
  const result = spawnSync('bash', [link], {
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, PIPELINE_HOME: undefined },
  });
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  assert.ok(zshenvOf(dir).includes(`export PIPELINE_HOME=${JSON.stringify(SKILL_DIR)}`),
    '必须解到 skill 的真实目录，而不是软链所在的 bin/');
});

test('变更前产生备份，无变化时不再产生', (context) => {
  const dir = home(context, { zshenv: 'export EDITOR=vim\n' });
  install(dir);
  const zshenvBackups = backups(dir, '.zshenv');
  assert.equal(zshenvBackups.length, 1, '首次安装改动了 zshenv，必须备份');
  assert.equal(read(path.join(dir, zshenvBackups[0])), 'export EDITOR=vim\n', '备份是改动前的内容');

  // settings.json 原本不存在：新建不备份（没有可丢的内容），再跑也不产生。
  const settingsBackups = backups(path.join(dir, '.claude'), 'settings.json');
  install(dir);
  assert.equal(backups(dir, '.zshenv').length, 1);
  assert.equal(backups(path.join(dir, '.claude'), 'settings.json').length, settingsBackups.length);
});

test('基础用法错误 exit 2', (context) => {
  const dir = home(context);
  assert.equal(install(dir, '--nope').code, 2);
  assert.equal(install(dir, '--dry-run', '--check').code, 2);
  assert.equal(fs.existsSync(path.join(dir, '.zshenv')), false, '用法错误不得写文件');
});

// --- 标记块损坏：一律 exit 4 且不动文件 ---
//
// 旧实现找不到结尾标记时把 end 设成文件长度，等于把块后用户的所有导出删掉（实测：
// `export B=2`、`export C=3` 消失而 --check 仍 exit 0）。重复块只替换第一块，第二块留着旧
// 路径，--check 也报已就绪。两种都选择拒绝：猜着合并会静默写坏用户配置。
const CORRUPT = {
  '缺结尾标记（且块后有内容）': `export A=1\n${START}\nexport B=2\nexport C=3\n`,
  '重复块': `${START}\nexport PIPELINE_HOME=/old/one\n${END}\n${START}\nexport PIPELINE_HOME=/old/two\n${END}\n`,
  '只有结尾标记': `export A=1\n${END}\nexport B=2\n`,
  '结尾在开头之前': `${END}\nexport A=1\n${START}\n`,
};

for (const [name, content] of Object.entries(CORRUPT)) {
  test(`zshenv 标记块损坏（${name}）时 exit 4 且不动任何文件`, (context) => {
    const settingsText = `${JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: FAKE_TOKEN } }, null, 2)}\n`;
    const dir = home(context, { zshenv: content, settings: settingsText });
    const { code, out } = install(dir);

    assert.equal(code, 4, out);
    assert.match(out, /标记块损坏/);
    assert.match(out, /exit 4/);
    assert.equal(zshenvOf(dir), content, '损坏的 zshenv 必须字节级不变');
    assert.equal(read(path.join(dir, '.claude', 'settings.json')), settingsText, '拒绝写入时 settings.json 也不得改动');
    assert.equal(backups(dir, '.zshenv').length, 0, '拒绝写入时不产生备份');
    assert.equal(backups(path.join(dir, '.claude'), 'settings.json').length, 0);
    assert.ok(!out.includes(FAKE_TOKEN));
  });

  test(`--check 与 --dry-run 遇${name}同样 exit 4 且不写`, (context) => {
    const dir = home(context, { zshenv: content });
    for (const flag of ['--check', '--dry-run']) {
      const { code, out } = install(dir, flag);
      assert.equal(code, 4, `${flag}\n${out}`);
      assert.equal(zshenvOf(dir), content, `${flag} 不得改动 zshenv`);
      assert.equal(fs.existsSync(path.join(dir, '.claude', 'settings.json')), false, `${flag} 不得新建 settings.json`);
    }
  });
}

// --- matcher 必须与 command 一起判 ---
//
// 同一条 command 挂在 matcher=Bash 上，Write/Edit 实际上没人守护；只比 command 会不追加、
// 不提示、--check exit 0（实测），doctor 若只看字符串包含也会 PASS。这里要求：追加正确条目、
// 旧条目保留并提示、check 由 1 变 0。
test('同 command 但 matcher 不同的旧条目：追加正确条目、保留旧条目并提示', (context) => {
  const stale = {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${JSON.stringify(SCOPEGUARD)}` }] }] },
  };
  const dir = home(context, { settings: `${JSON.stringify(stale, null, 2)}\n` });

  const before = install(dir, '--check');
  assert.equal(before.code, 1, 'matcher 不覆盖 Write/Edit 时不得报已就绪');

  const { out } = install(dir);
  assert.match(out, /matcher=Bash 的同名 hook，未删除/);
  const settings = settingsOf(dir);
  assert.deepEqual(matchers(settings, 'PreToolUse'), ['Bash', 'Write|Edit|MultiEdit|NotebookEdit']);
  assert.equal(commands(settings, 'PreToolUse')[0], `node ${JSON.stringify(SCOPEGUARD)}`, '旧条目保留');

  assert.equal(install(dir, '--check').code, 0, '装好正确的 matcher 后 --check 必须 exit 0');
});

test('matcher 完全相同时不重复追加', (context) => {
  const correct = {
    hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: `node ${JSON.stringify(SCOPEGUARD)}` }] }] },
  };
  const dir = home(context, { settings: `${JSON.stringify(correct, null, 2)}\n` });
  install(dir);
  assert.deepEqual(matchers(settingsOf(dir), 'PreToolUse'), ['Write|Edit|MultiEdit|NotebookEdit']);
});

// --- 原子写与权限 ---
test('写入用临时文件 + rename，不残留 .tmp，且不截断原文件内容', (context) => {
  const dir = home(context, { zshenv: 'export A=1\n' });
  const target = path.join(dir, '.zshenv');
  const before = fs.statSync(target).ino;
  install(dir);
  const leftover = [...fs.readdirSync(dir), ...fs.readdirSync(path.join(dir, '.claude'))]
    .filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftover, [], '临时文件必须被 rename 掉，不得残留');
  // rename 换的是目录项：inode 必须变。原地 writeFileSync 覆盖会保留同一个 inode，
  // 那正是「写到一半被杀就留下截断文件」的写法。这一条把两种实现区分开。
  assert.notEqual(fs.statSync(target).ino, before, '必须是替换而非原地覆盖');
});

test('软链：写入真实目标、链接仍是链接、备份是原目标内容', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-link-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, 'real');
  const homeDir = path.join(root, 'home');
  fs.mkdirSync(real);
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(real, 'zshenv'), 'export A=1\n');
  fs.writeFileSync(path.join(real, 'settings.json'), `${JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: FAKE_TOKEN } })}\n`);
  fs.symlinkSync(path.join(real, 'zshenv'), path.join(homeDir, '.zshenv'));
  fs.symlinkSync(path.join(real, 'settings.json'), path.join(homeDir, '.claude', 'settings.json'));

  install(homeDir);

  assert.ok(fs.lstatSync(path.join(homeDir, '.zshenv')).isSymbolicLink(), '.zshenv 链接不得被替换成普通文件');
  assert.ok(fs.lstatSync(path.join(homeDir, '.claude', 'settings.json')).isSymbolicLink(), 'settings.json 链接不得被替换');
  assert.match(read(path.join(real, 'zshenv')), new RegExp(`export PIPELINE_HOME=`), '内容写进真实目标');
  assert.ok(Object.keys(JSON.parse(read(path.join(real, 'settings.json')))).includes('hooks'));

  const zshenvBackups = fs.readdirSync(homeDir).filter((f) => f.startsWith('.zshenv.bak-'));
  assert.equal(zshenvBackups.length, 1);
  assert.equal(read(path.join(homeDir, zshenvBackups[0])), 'export A=1\n', '备份是改动前的目标内容');
});

test('新建文件权限：settings.json 600、zshenv 644；已存在文件保持原 mode', (context) => {
  const dir = home(context);
  install(dir);
  assert.equal(fs.statSync(path.join(dir, '.claude', 'settings.json')).mode & 0o777, 0o600,
    'settings.json 随后会装 token，新建时必须 600');
  assert.equal(fs.statSync(path.join(dir, '.zshenv')).mode & 0o777, 0o644);

  const existing = home(context, { zshenv: 'export A=1\n' });
  fs.writeFileSync(path.join(existing, '.zshenv'), 'export A=1\n', { mode: 0o640 });
  fs.chmodSync(path.join(existing, '.zshenv'), 0o640);
  install(existing);
  assert.equal(fs.statSync(path.join(existing, '.zshenv')).mode & 0o777, 0o640, '已有文件的 mode 必须原样保持');
});
