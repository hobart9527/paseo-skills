import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hooks = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'git');
const ME = '9f1492a6-aaaa-bbbb-cccc-000000000001';
const OTHER = '11111111-1111-1111-1111-111111111111';
const UUIDGEN = 'A3BAF750-1111-2222-3333-444444444444';

function repo(context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'author-hook-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sh = (args, env = {}) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, PASEO_AGENT_ID: ME, ...env } });
  sh(['init', '-q', '.']); sh(['config', 'user.email', 'a@b.c']); sh(['config', 'user.name', 't']);
  sh(['config', 'core.hooksPath', hooks]);
  let n = 0;
  const commit = (msg, env) => { fs.writeFileSync(path.join(dir, `f${n++}`), 'x'); sh(['add', '-A']); return sh(['commit', '-q', '-m', msg], env); };
  const trailer = (key) => sh(['log', '-1', `--format=%(trailers:key=${key},valueonly,separator=%x2C)`]).stdout.trim();
  return { sh, commit, trailer };
}

test('writer commit with a self-invented Pipeline-Author is rewritten to PASEO_AGENT_ID', (t) => {
  const r = repo(t);
  assert.equal(r.commit(`red\n\nPipeline-Role: ceshi\nPipeline-Author: ${UUIDGEN}`).status, 0);
  assert.equal(r.trailer('Pipeline-Author'), ME);
});

test('writer commit with no Pipeline-Author gets one', (t) => {
  const r = repo(t);
  assert.equal(r.commit('impl\n\nPipeline-Role: gaogong').status, 0);
  assert.equal(r.trailer('Pipeline-Author'), ME);
  assert.equal(r.trailer('Pipeline-Role'), 'gaogong');
});

test('Co-Authored-By after the trailer block is accepted', (t) => {
  const r = repo(t);
  assert.equal(r.commit('red\n\nPipeline-Role: ceshi\nPipeline-Author: x\nCo-Authored-By: x <x@y>').status, 0);
  assert.equal(r.trailer('Pipeline-Author'), ME);
  assert.equal(r.trailer('Pipeline-Role'), 'ceshi');
});

test('blank line splitting the trailer block is rejected (the exit-31 trap)', (t) => {
  const r = repo(t);
  const res = r.commit('red\n\nPipeline-Role: ceshi\n\nCo-Authored-By: x <x@y>');
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /contiguous block/);
});

test('writer commit without PASEO_AGENT_ID is refused, not guessed', (t) => {
  const r = repo(t);
  const res = r.commit('red\n\nPipeline-Role: ceshi', { PASEO_AGENT_ID: '' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /PASEO_AGENT_ID is unset/);
});

test('merge-task style commit with several authors and a reviewer role is untouched', (t) => {
  const r = repo(t);
  const msg = `merge(T-01): b\n\nPipeline-Task: T-01\nPipeline-Author: ${OTHER}\nPipeline-Author: ${UUIDGEN}\nPipeline-Role: anchasi\nPipeline-Reviewer: r`;
  assert.equal(r.commit(msg).status, 0);
  assert.equal(r.trailer('Pipeline-Author'), `${OTHER},${UUIDGEN}`);
});

test('mechanical and plain commits are untouched, even without PASEO_AGENT_ID', (t) => {
  const r = repo(t);
  assert.equal(r.commit('merge\n\nPipeline-Role: mechanical', { PASEO_AGENT_ID: '' }).status, 0);
  assert.equal(r.trailer('Pipeline-Author'), '');
  assert.equal(r.commit('plain', { PASEO_AGENT_ID: '' }).status, 0);
});

test('mixed writer and non-writer roles are left to merge-task, not rewritten', (t) => {
  const r = repo(t);
  assert.equal(r.commit(`x\n\nPipeline-Role: ceshi\nPipeline-Role: anchasi\nPipeline-Author: ${OTHER}`).status, 0);
  assert.equal(r.trailer('Pipeline-Author'), OTHER);
});

test('cherry-pick keeps the original author (the -aN handoff path)', (t) => {
  const r = repo(t);
  r.commit('base');
  r.sh(['checkout', '-q', '-b', 'other']);
  assert.equal(r.commit('impl\n\nPipeline-Role: gaogong', { PASEO_AGENT_ID: OTHER }).status, 0);
  const sha = r.sh(['rev-parse', 'HEAD']).stdout.trim();
  r.sh(['checkout', '-q', '-']);
  assert.equal(r.sh(['cherry-pick', sha]).status, 0);
  assert.equal(r.trailer('Pipeline-Author'), OTHER);
});
