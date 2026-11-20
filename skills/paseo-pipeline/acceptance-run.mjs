#!/usr/bin/env node
// Operator-invoked execution record, not a sandbox or a CP-2 authorization.
import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './lib/git.mjs';
import { parseOptions } from './lib/cli.mjs';
import { runShell } from './lib/verify-runner.mjs';

function fail(message) { throw new Error(message); }
function git(cwd, args) {
  const result = runGit(cwd, args);
  if (result.status !== 0) fail(`git ${args[0]} failed: ${(result.stderr || '').trim()}`);
  return result.stdout.trim();
}
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
function snapshot(root, sha, branch) {
  if (git(root, ['rev-parse', 'HEAD']) !== sha) fail('HEAD changed');
  if (git(root, ['symbolic-ref', '--short', 'HEAD']) !== branch) fail('integration branch changed');
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])) fail('worktree is dirty');
}
function rowsOf(text) {
  const lines = text.split(/\r?\n/);
  const cells = (line) => line.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim().replace(/\\\|/g, '|').replace(/^`|`$/g, ''));
  const header = lines.find((line) => /^\s*\|.*\|\s*$/.test(line) && /\bScenario\b/i.test(line));
  if (!header || cells(header).join('|').toLowerCase() !== 'scenario|entry|tasks|verify|required|result|evidence') fail('invalid acceptance header');
  const rows = [];
  for (const [index, line] of lines.entries()) {
    if (!/^\s*\|\s*SCEN-/i.test(line)) continue;
    const row = cells(line);
    if (!/^\s*\|.*\|\s*$/.test(line) || row.length !== 7 || !/^SCEN-[A-Za-z0-9-]+$/i.test(row[0])) fail(`malformed acceptance row at line ${index + 1}`);
    if (!/^(yes|no)$/i.test(row[4])) fail(`invalid Required at line ${index + 1}`);
    if (/^yes$/i.test(row[4])) {
      if (row[5] !== 'PENDING') fail(`required result is not frozen at line ${index + 1}`);
      if (!row[3] || /^(?:!|manual|手工|自然语言)/i.test(row[3])) fail(`invalid Verify at line ${index + 1}`);
      rows.push({ line: index + 1, scenario: row[0], command: row[3] });
    }
  }
  if (!rows.length) fail('no required acceptance rows');
  return rows;
}
function run(command, cwd, timeout) {
  return runShell(command, { cwd, timeout, capture: true });
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!['run', 'check'].includes(action)) fail('usage: acceptance run|check <change-dir> --evidence <new-external-file> [--source <full-sha> --execute --timeout <ms>]; timeout per command defaults to 120000 ms (range 1..3600000)');
  const { positional, options } = parseOptions(args, { evidence: 'value', source: 'value', execute: 'boolean', timeout: 'value' });
  if (positional.length !== 1 || !options.evidence) fail('expected <change-dir> and --evidence');
  if (action === 'run' && (!options.execute || !options.source)) fail('run requires --execute and --source <full-sha>; commands are arbitrary repository-controlled code');
  if (action === 'check' && (options.execute || options.source || options.timeout)) fail('check accepts only --evidence');
  const timeout = Number(options.timeout ?? 120000);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600000) fail('timeout must be 1..3600000 ms');
  const root = fs.realpathSync(git(process.cwd(), ['rev-parse', '--show-toplevel']));
  const dir = fs.realpathSync(path.resolve(positional[0]));
  if (!inside(root, dir)) fail('change must be in current worktree');
  const matrix = path.join(dir, 'acceptance.md');
  if (!inside(root, fs.realpathSync(matrix))) fail('matrix must be in current worktree');
  const relative = path.relative(root, matrix);
  git(root, ['ls-files', '--error-unmatch', '--', relative]);
  const text = fs.readFileSync(matrix, 'utf8');
  const committedMatrix = runGit(root, ['show', `HEAD:${relative}`]);
  if (committedMatrix.status !== 0 || committedMatrix.stdout !== text) fail('matrix differs from HEAD');
  const rows = rowsOf(text);
  const changeName = path.basename(dir).replace(/^\d{4}-\d{2}-\d{2}-/, '');
  const branch = `integration/${changeName}`;
  const currentBranch = git(root, ['symbolic-ref', '--short', 'HEAD']);
  const sha = git(root, ['rev-parse', 'HEAD']);
  if (action === 'run' && (!/^[a-f0-9]{40,64}$/.test(options.source) || options.source !== sha)) fail('source must equal full current HEAD SHA');
  if (action === 'run') snapshot(root, sha, branch);
  const evidence = path.resolve(options.evidence);
  const parent = fs.realpathSync(path.dirname(evidence));
  const target = path.join(parent, path.basename(evidence));
  const trees = git(root, ['worktree', 'list', '--porcelain']).split('\n').filter((line) => line.startsWith('worktree ')).map((line) => fs.realpathSync(line.slice(9)));
  const gitDir = fs.realpathSync(path.resolve(root, git(root, ['rev-parse', '--git-common-dir'])));
  const changeEvidenceDir = path.join(dir, 'evidence');
  const archivedEvidenceDir = path.join(root, 'openspec', 'changes', 'archive');
  const allowedInRepoCheck = action === 'check' && (
    inside(changeEvidenceDir, target) || inside(archivedEvidenceDir, target)
  );
  if (!allowedInRepoCheck && [...trees, gitDir].some((tree) => inside(tree, target))) {
    fail('evidence must be outside all repository worktrees and git directory');
  }
  if (action === 'check') {
    if (!fs.lstatSync(target).isFile()) fail('evidence must be a regular file');
    const record = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (record.version !== 1 || record.branch !== branch || record.valid !== true || !Array.isArray(record.rows) || record.rows.length !== rows.length) {
      fail('record does not match clean source');
    }
    const cleanTree = git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']) === '';
    if (!cleanTree) fail('worktree is dirty');
    let sourceValid = record.sourceSha === sha && currentBranch === branch && record.matrixPath === relative && record.matrix === text;
    if (!sourceValid && /^[a-f0-9]{40,64}$/.test(record.sourceSha)) {
      const ancestor = runGit(root, ['merge-base', '--is-ancestor', record.sourceSha, sha]);
      if (ancestor.status === 0) {
        const histMatrix = runGit(root, ['show', `${record.sourceSha}:${record.matrixPath}`]);
        if (histMatrix.status === 0 && histMatrix.stdout === record.matrix) {
          if (currentBranch === branch) {
            const diffFiles = git(root, ['diff', '--name-only', record.sourceSha, sha]).split(/\r?\n/).filter(Boolean);
            const signoffOnly = new RegExp(`^openspec/changes/(?:archive/\\d{4}-\\d{2}-\\d{2}-)?${changeName}/(?:review\\.md|run-log\\.md|evidence/.*)$`);
            if (diffFiles.length > 0 && diffFiles.every((f) => signoffOnly.test(f))) sourceValid = true;
          } else if (currentBranch === 'main' || currentBranch === 'master') {
            sourceValid = record.matrix === text;
          }
        }
      }
    }
    if (!sourceValid) fail('record does not match clean source');
    for (let i = 0; i < rows.length; i++) {
      const r = record.rows[i], expected = rows[i];
      if (!r || r.line !== expected.line || r.scenario !== expected.scenario || r.command !== expected.command || r.result !== 'PASS' || r.status !== 0 || r.signal !== null || r.timedOut !== false || r.overflow !== false || r.error !== null || typeof r.stdout !== 'string' || typeof r.stderr !== 'string') fail('record contains incomplete or failed rows');
    }
    console.log('Record matches current source and reports passing rows; this does not establish trust or authorize CP-2.');
    return;
  }
  console.error('WARNING: executing repository-controlled commands as your user; not sandboxed. Output may contain secrets.');
  const fd = fs.openSync(target, 'wx', 0o600);
  const stat = fs.fstatSync(fd);
  const record = { version: 1, sourceSha: sha, branch, matrixPath: relative, matrix: text, timeoutMs: timeout, startedAt: new Date().toISOString(), valid: false, rows: [] };
  try {
    for (const row of rows) {
      try { snapshot(root, sha, branch); } catch (error) { record.invalidReason = error.message; break; }
      const result = await run(row.command, root, timeout);
      const pass = result.status === 0 && !result.signal && !result.timedOut && !result.overflow && !result.error;
      record.rows.push({ ...row, ...result, result: pass ? 'PASS' : 'FAIL' });
      try { snapshot(root, sha, branch); } catch (error) { record.invalidReason = error.message; break; }
      if (!pass) break;
    }
    record.valid = !record.invalidReason && record.rows.length === rows.length && record.rows.every((row) => row.result === 'PASS');
    record.finishedAt = new Date().toISOString();
    const current = fs.lstatSync(target);
    if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino) fail('evidence file was replaced during execution');
    fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
  } finally { fs.closeSync(fd); }
  console.log(`Evidence: ${target}; ${record.valid ? 'all rows report PASS' : 'not valid for CP-2'}. Human review required.`);
  if (!record.valid) process.exitCode = 1;
}
main().catch((error) => { console.error(`[acceptance] ${error.message}`); process.exitCode = 1; });
