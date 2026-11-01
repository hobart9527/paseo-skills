import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const install = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'install.sh');
test('writes PIPELINE_HOME idempotently', (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'install-')); context.after(() => fs.rmSync(home, {recursive:true,force:true}));
  const env = { ...process.env, HOME: home };
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ hooks: [{ command: `node ${path.dirname(install)}/hooks/tier-write-hook.mjs` }] }],
    UserPromptSubmit: [{ hooks: [{ command: `node ${path.dirname(install)}/hooks/tier-reminder-hook.mjs` }] }],
  } }));
  const first = spawnSync('bash', [install], { env, encoding: 'utf8' }); assert.equal(first.status, 0, first.stderr);
  const text = fs.readFileSync(path.join(home, '.zshenv'), 'utf8'); assert.match(text, /export PIPELINE_HOME=/);
  const before = fs.statSync(path.join(home, '.zshenv')).mtimeMs;
  const second = spawnSync('bash', [install], { env, encoding: 'utf8' }); assert.equal(second.status, 0);
  assert.equal(fs.statSync(path.join(home, '.zshenv')).mtimeMs, before);
  const check = spawnSync('bash', [install, '--check'], { env, encoding: 'utf8' }); assert.equal(check.status, 0, check.stderr);
  fs.writeFileSync(path.join(home, '.claude/settings.json'), '{}');
  const missingHook = spawnSync('bash', [install, '--check'], { env, encoding: 'utf8' }); assert.equal(missingHook.status, 1);
});
