// pipeline-doctor 回归：配置漂移必须在开工前被一条命令拦下，而不是派发或合流时才报错。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

function run(profiles, { settings, env = {}, zshenv = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
  const config = path.join(dir, 'config.json');
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(config, JSON.stringify({ daemon: { agentProfiles: profiles } }));
  // 健康基线 = install.sh 实际写出的形状（含 matcher）。不是任意「hooks 里有这个脚本」就算装好：
  // 少了 matcher，Write/Edit 根本不会被守护。
  fs.writeFileSync(settingsFile, JSON.stringify(settings ?? {
    hooks: {
      PreToolUse: [{
        matcher: 'Write|Edit|MultiEdit|NotebookEdit',
        hooks: [{ type: 'command', command: `node ${path.join(SKILL_DIR, 'hooks', 'scope-guard-hook.mjs')}` }],
      }],
    },
  }));
  // 非交互检查读的是 `zsh -c` 下的 $HOME/.zshenv；用临时 HOME 才能既正反两向断言，
  // 又不去碰真实 home。`--home` 同时把这个 HOME 交给 config/settings 的默认路径。
  if (zshenv) {
    fs.writeFileSync(path.join(dir, '.zshenv'), `export PIPELINE_HOME=${JSON.stringify(SKILL_DIR)}\n`);
  }
  const result = spawnSync(process.execPath, [DOCTOR, '--config', config, '--settings', settingsFile, '--home', dir], {
    encoding: 'utf8',
    env: { ...process.env, PIPELINE_HOME: SKILL_DIR, ...env },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

// 外部命令（openspec/codex/paseo）取决于运行机器，断言只看与配置相关的行，不看总退出码。
const line = (out, name) => out.split('\n').find((l) => l.includes(name)) ?? '';

test('healthy profile set passes every config-derived check', () => {
  const { out } = run(healthy());
  for (const name of ['profile 齐全', 'modeId 合法', 'scope-guard hook', 'PIPELINE_HOME', '非交互 PIPELINE_HOME']) {
    assert.match(line(out, name), /^PASS/, `${name}\n${out}`);
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
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${path.join(SKILL_DIR, 'hooks', 'scope-guard-hook.mjs')}` }] }] },
  };
  const { code, out } = run(healthy(), { settings });
  assert.equal(code, 1);
  assert.match(line(out, 'scope-guard hook'), /^FAIL.*matcher/);
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
    hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: `node ${path.join(SKILL_DIR, 'hooks', 'scope-guard-hook.mjs')}` }] }] },
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
