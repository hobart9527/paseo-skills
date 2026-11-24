import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanChanges, scanRepo } from '../lib/risk-scan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const RISK_SCAN_CLI = path.join(here, '..', 'risk-scan.mjs');
const PIPELINE_RUN_CLI = path.join(here, '..', 'pipeline-run.mjs');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function makeRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'risk-scan-')));
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 't@t');
  sh(root, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export const greet = () => "hi";\n');
  fs.writeFileSync(path.join(root, 'test', 'app.test.js'), 'import assert from "node:assert/strict";\nassert.equal(1, 1);\n');
  sh(root, 'add', '.');
  sh(root, 'commit', '-q', '-m', 'seed');
  return root;
}

test('clean single-scope non-risky change reports tierRequired=1 and reviewRequired=false', () => {
  const result = scanChanges({
    entries: [
      { status: 'M', file: 'src/view.tsx' },
      { status: 'A', file: 'test/view.test.tsx' },
      { status: 'M', file: 'docs/notes.md' },
    ],
    diffText: [
      'diff --git a/src/view.tsx b/src/view.tsx',
      '--- a/src/view.tsx',
      '+++ b/src/view.tsx',
      '@@ -1 +1 @@',
      '-return <div>old</div>;',
      '+return <div>new</div>;',
    ].join('\n'),
  });
  assert.equal(result.tierRequired, 1);
  assert.equal(result.reviewRequired, false);
  assert.deepEqual(result.classes, []);
  assert.deepEqual(result.testMutations, []);
  assert.deepEqual(result.sourceFiles, ['src/view.tsx']);
});

test('exceeding Tier 1 file limit or crossing scopes bumps tierRequired to 2', () => {
  const many = scanChanges({
    entries: ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js'].map((file) => ({ status: 'M', file })),
  });
  assert.equal(many.tierRequired, 2);

  const cross = scanChanges({
    entries: [
      { status: 'M', file: 'packages/web/src/a.tsx' },
      { status: 'M', file: 'packages/server/src/b.ts' },
    ],
  });
  assert.equal(cross.tierRequired, 2);
  assert.deepEqual(cross.scopes, ['packages/server', 'packages/web']);
});

test('detects all 5 risk classes via paths and diff hunks while ignoring docs/openspec prose', () => {
  const cases = [
    ['auth', 'src/auth/login.ts', '+const ok = true;'],
    ['auth', 'src/handler.ts', '+if (!verifySignature(req)) return 401;'],
    ['concurrency', 'src/lease/store.ts', '+const x = 1;'],
    ['concurrency', 'src/runner.ts', '+await acquireLock(key);'],
    ['persistence', 'db/migrations/001.sql', '+CREATE TABLE items (id TEXT);'],
    ['persistence', 'src/repo.ts', '+db.exec("ALTER TABLE users ADD COLUMN role TEXT");'],
    ['money', 'src/billing/calc.ts', '+return 100;'],
    ['money', 'src/form.ts', '+const total = invoiceAmount + taxAmount;'],
    ['external-write', 'src/webhook/sender.ts', '+return true;'],
    ['external-write', 'src/client.ts', "+await fetch(url, { method: 'POST', body });"],
  ];
  for (const [expectedClass, file, line] of cases) {
    const diffText = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-const prev = 0;\n${line}`;
    const res = scanChanges({ entries: [{ status: 'M', file }], diffText });
    assert.equal(res.reviewRequired, true, `${expectedClass} (${file})`);
    assert.ok(res.classes.includes(expectedClass), `${expectedClass} missing in ${res.classes}`);
  }

  // Docs and openspec files mentioning auth/money do not trigger source risk classes.
  const docsOnly = scanChanges({
    entries: [
      { status: 'M', file: 'openspec/changes/x/proposal.md' },
      { status: 'M', file: 'docs/guide.md' },
    ],
    diffText: 'diff --git a/docs/guide.md b/docs/guide.md\n--- a/docs/guide.md\n+++ b/docs/guide.md\n@@ -1 +1 @@\n-old\n+verifySignature invoiceAmount CREATE TABLE',
  });
  assert.equal(docsOnly.reviewRequired, false);
});

test('detects test-oracle weakening on existing test files while allowing newly added tests', () => {
  const weakened = scanChanges({
    entries: [{ status: 'M', file: 'test/app.test.js' }],
    diffText: [
      'diff --git a/test/app.test.js b/test/app.test.js',
      '--- a/test/app.test.js',
      '+++ b/test/app.test.js',
      '@@ -2 +2 @@',
      '-assert.equal(result.code, "EXACT");',
      '+assert.ok(result);',
    ].join('\n'),
  });
  assert.equal(weakened.reviewRequired, true);
  assert.equal(weakened.testMutations.length, 1);

  const skipped = scanChanges({
    entries: [{ status: 'M', file: 'test/app.test.js' }],
    diffText: [
      'diff --git a/test/app.test.js b/test/app.test.js',
      '--- a/test/app.test.js',
      '+++ b/test/app.test.js',
      '@@ -1 +1 @@',
      '-test("works", () => {});',
      '+test.skip("works", () => {});',
    ].join('\n'),
  });
  assert.equal(skipped.reviewRequired, true);

  const deleted = scanChanges({ entries: [{ status: 'D', file: 'test/old.test.js' }] });
  assert.equal(deleted.reviewRequired, true);
  assert.match(deleted.testMutations[0].reason, /deleted/);

  const brandNew = scanChanges({
    entries: [{ status: 'A', file: 'test/new.test.js' }],
    diffText: 'diff --git a/test/new.test.js b/test/new.test.js\nnew file mode 100644\n--- /dev/null\n+++ b/test/new.test.js\n@@ -0,0 +1 @@\n+assert.equal(1, 1);',
  });
  assert.equal(brandNew.reviewRequired, false);
});

test('CLI scans committed ranges, working-tree untracked files, and supports --require-clean via pipeline-run', (t) => {
  const root = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = sh(root, 'rev-parse', 'HEAD');

  // Clean commit
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export const greet = () => "hello";\n');
  sh(root, 'add', '.');
  sh(root, 'commit', '-q', '-m', 'clean change');
  const cleanTip = sh(root, 'rev-parse', 'HEAD');

  const okCli = spawnSync('node', [RISK_SCAN_CLI, base, cleanTip, '--cwd', root, '--require-clean', '--json'], { encoding: 'utf8' });
  assert.equal(okCli.status, 0, okCli.stderr);
  assert.equal(JSON.parse(okCli.stdout).reviewRequired, false);

  // Untracked risky file in working tree (Tier 2 self-work in worktree before commit)
  fs.mkdirSync(path.join(root, 'src', 'billing'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'billing', 'settlement.js'), 'export const taxAmount = 1;\n');
  const wtReport = scanRepo({ cwd: root, base, workingTree: true });
  assert.equal(wtReport.reviewRequired, true);
  assert.ok(wtReport.classes.includes('money'));

  const gatedCli = spawnSync('node', [PIPELINE_RUN_CLI, 'risk-scan', base, '--cwd', root, '--working-tree', '--require-clean'], { encoding: 'utf8' });
  assert.equal(gatedCli.status, 1);
  assert.match(gatedCli.stdout, /RISK \[money\]/);
  assert.match(gatedCli.stdout, /RESULT review-required/);
});

test('deleting a source file still triggers content-based risk detection (B1 regression)', () => {
  const deleted = scanChanges({
    entries: [{ status: 'D', file: 'src/handler.ts' }],
    diffText: [
      'diff --git a/src/handler.ts b/src/handler.ts',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/src/handler.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-export function handle(request) {',
      '-  authorize(request);',
      '-}',
    ].join('\n'),
  });
  assert.equal(deleted.reviewRequired, true);
  assert.ok(deleted.classes.includes('auth'));
  assert.ok(deleted.hits.some((h) => h.file === 'src/handler.ts' && h.class === 'auth'));
});

test('detects removal of safety or prohibition caveats from docs and prompts (T-03 regression)', () => {
  const dropped = scanChanges({
    entries: [{ status: 'M', file: 'skills/paseo-pipeline/SKILL.md' }],
    diffText: [
      'diff --git a/skills/paseo-pipeline/SKILL.md b/skills/paseo-pipeline/SKILL.md',
      '--- a/skills/paseo-pipeline/SKILL.md',
      '+++ b/skills/paseo-pipeline/SKILL.md',
      '@@ -45 +45 @@',
      '-| `profiles-check.mjs` | Read-only lint; not independence/sandbox proof. |',
      '+| `profiles-check.mjs` | Read-only lint. |',
    ].join('\n'),
  });
  assert.equal(dropped.reviewRequired, true);
  assert.equal(dropped.caveatRemovals.length, 1);
  assert.match(dropped.caveatRemovals[0].reason, /safety\/prohibition qualifier removed/);

  const preserved = scanChanges({
    entries: [{ status: 'M', file: 'skills/paseo-pipeline/SKILL.md' }],
    diffText: [
      'diff --git a/skills/paseo-pipeline/SKILL.md b/skills/paseo-pipeline/SKILL.md',
      '--- a/skills/paseo-pipeline/SKILL.md',
      '+++ b/skills/paseo-pipeline/SKILL.md',
      '@@ -45 +45 @@',
      '-| `profiles-check.mjs` | Read-only lint; not independence proof. |',
      '+| `profiles-check.mjs` | Read-only check; not independence proof. |',
    ].join('\n'),
  });
  assert.equal(preserved.reviewRequired, false);
  assert.equal(preserved.caveatRemovals.length, 0);
});

test('risk-scan supports --files, --tracked-only, and marks untracked-only residue hits (M2)', (t) => {
  const root = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = sh(root, 'rev-parse', 'HEAD');

  // Benign tracked edit (Tier 1 UI fix) while unrelated untracked auth residue sits in workspace
  fs.mkdirSync(path.join(root, 'src', 'ui'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'ui', 'picker.js'), 'export const picker = () => "ok";\n');
  sh(root, 'add', 'src/ui/picker.js');
  sh(root, 'commit', '-qm', 'add clean picker');

  fs.mkdirSync(path.join(root, 'design', 'auth'), { recursive: true });
  fs.writeFileSync(path.join(root, 'design', 'auth', 'probe.js'), 'export const token = true;\n');

  // Default working-tree scan detects the untracked auth file and flags untrackedOnlyRisk
  const defaultRes = spawnSync('node', [RISK_SCAN_CLI, base, '--cwd', root, '--working-tree'], { encoding: 'utf8' });
  assert.equal(defaultRes.status, 0);
  assert.match(defaultRes.stdout, /RISK \[auth\] \(untracked\) design\/auth\/probe\.js/);
  assert.match(defaultRes.stdout, /NOTE hits came only from untracked files/);

  // Scoped with --files or --tracked-only avoids false escalation from unrelated residue
  const scopedRes = spawnSync('node', [RISK_SCAN_CLI, base, '--cwd', root, '--working-tree', '--files', 'src/ui/picker.js', '--require-clean', '--json'], { encoding: 'utf8' });
  assert.equal(scopedRes.status, 0, scopedRes.stderr + scopedRes.stdout);
  assert.equal(JSON.parse(scopedRes.stdout).reviewRequired, false);

  const trackedRes = spawnSync('node', [RISK_SCAN_CLI, base, '--cwd', root, '--working-tree', '--tracked-only', '--require-clean', '--json'], { encoding: 'utf8' });
  assert.equal(trackedRes.status, 0, trackedRes.stderr + trackedRes.stdout);
  assert.equal(JSON.parse(trackedRes.stdout).reviewRequired, false);

  // If --files explicitly includes a risky untracked file, risk is still detected!
  const targetedUntracked = spawnSync('node', [RISK_SCAN_CLI, base, '--cwd', root, '--working-tree', '--files', 'src/ui/picker.js,design/auth/probe.js', '--require-clean', '--json'], { encoding: 'utf8' });
  assert.equal(targetedUntracked.status, 1);
  const targetedJson = JSON.parse(targetedUntracked.stdout);
  assert.equal(targetedJson.reviewRequired, true);
  assert.ok(targetedJson.classes.includes('auth'));
  assert.equal(targetedJson.hits[0].untracked, true);
});

test('risk-scan uses merge-base so main drift after branch cut is never blamed on the branch (P0-3)', (t) => {
  const root = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const forkSha = sh(root, 'rev-parse', 'HEAD');

  // Create feature branch with a benign UI change only
  const wt = `${root}-branch`;
  sh(root, 'worktree', 'add', '-q', '-b', 'feat/ui-only', wt);
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  fs.mkdirSync(path.join(wt, 'src/ui'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'src/ui/button.js'), 'export const btn = () => "ok";\n');
  sh(wt, 'add', 'src/ui/button.js');
  sh(wt, 'commit', '-qm', 'branch benign ui');

  // Main drifts forward with an unrelated auth change
  fs.mkdirSync(path.join(root, 'src/auth'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/auth/main-only.js'), 'export const token = true;\n');
  sh(root, 'add', 'src/auth/main-only.js');
  sh(root, 'commit', '-qm', 'main auth drift');

  const scan = scanRepo({ cwd: wt, base: 'main', head: 'HEAD' });
  assert.equal(scan.mergeBase, forkSha);
  assert.equal(scan.reviewRequired, false, `drifted main auth file must not taint branch: ${JSON.stringify(scan.hits)}`);
  assert.equal(scan.hits.length, 0);

  const cliRes = spawnSync('node', [RISK_SCAN_CLI, 'main', 'HEAD', '--cwd', wt, '--json'], { encoding: 'utf8' });
  assert.equal(cliRes.status, 0, cliRes.stderr);
  assert.equal(JSON.parse(cliRes.stdout).reviewRequired, false);
});

test('skips path-only money/persistence/external-write for UI files and ignores comment-only lines while keeping real money math flagged', () => {
  const uiDebounceOnly = scanChanges({
    entries: [{ status: 'M', file: 'packages/web/src/components/invoices/InvoicePoolPage.tsx' }],
    diffText: [
      'diff --git a/packages/web/src/components/invoices/InvoicePoolPage.tsx b/packages/web/src/components/invoices/InvoicePoolPage.tsx',
      '--- a/packages/web/src/components/invoices/InvoicePoolPage.tsx',
      '+++ b/packages/web/src/components/invoices/InvoicePoolPage.tsx',
      '@@ -1 +1 @@',
      '-const delay = 100;',
      '+const delay = 300;',
    ].join('\n'),
  });
  assert.equal(uiDebounceOnly.reviewRequired, false);
  assert.deepEqual(uiDebounceOnly.classes, []);

  const uiRealMoneyMath = scanChanges({
    entries: [{ status: 'M', file: 'packages/web/src/components/invoices/InvoiceSplitViewer.tsx' }],
    diffText: [
      'diff --git a/packages/web/src/components/invoices/InvoiceSplitViewer.tsx b/packages/web/src/components/invoices/InvoiceSplitViewer.tsx',
      '--- a/packages/web/src/components/invoices/InvoiceSplitViewer.tsx',
      '+++ b/packages/web/src/components/invoices/InvoiceSplitViewer.tsx',
      '@@ -1 +1 @@',
      '-const total = 0;',
      '+const total = taxAmount + netAmount;',
    ].join('\n'),
  });
  assert.equal(uiRealMoneyMath.reviewRequired, true);
  assert.deepEqual(uiRealMoneyMath.classes, ['money']);

  const commentOnly = scanChanges({
    entries: [{ status: 'M', file: 'src/view.ts' }],
    diffText: [
      'diff --git a/src/view.ts b/src/view.ts',
      '--- a/src/view.ts',
      '+++ b/src/view.ts',
      '@@ -1 +1 @@',
      '-// old comment',
      '+// note: verifySignature and ledger happen upstream',
    ].join('\n'),
  });
  assert.equal(commentOnly.reviewRequired, false);
  assert.deepEqual(commentOnly.classes, []);
});
