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

function run(profiles, { settings, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
  const config = path.join(dir, 'config.json');
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(config, JSON.stringify({ daemon: { agentProfiles: profiles } }));
  fs.writeFileSync(settingsFile, JSON.stringify(settings ?? {
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `node ${path.join(SKILL_DIR, 'hooks', 'scope-guard-hook.mjs')}` }] }] },
  }));
  const result = spawnSync(process.execPath, [DOCTOR, '--config', config, '--settings', settingsFile], {
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
  for (const name of ['profile 齐全', 'modeId 合法', 'scope-guard hook', 'PIPELINE_HOME']) {
    assert.match(line(out, name), /^PASS/, `${name}\n${out}`);
  }
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

test('unset or wrong PIPELINE_HOME is rejected', () => {
  const wrong = run(healthy(), { env: { PIPELINE_HOME: '/nonexistent' } });
  assert.equal(wrong.code, 1);
  assert.match(line(wrong.out, 'PIPELINE_HOME'), /^FAIL/);
});
