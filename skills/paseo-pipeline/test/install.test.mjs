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
