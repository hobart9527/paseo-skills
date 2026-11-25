#!/usr/bin/env node
// Cross-tier end-to-end sandbox benchmark: Tier 0 (Q&A), Tier 1 (primary fix),
// Tier 2 (linked worktree + tier2-verify), and Tier 3 (scheduling reference).
// Measures hook wall-clock latency, false-positive friction, and 8 delivery-rigor gates.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const pipelineDir = path.join(root, 'skills', 'paseo-pipeline');
const args = process.argv.slice(2);
const json = args.includes('--json');
const withTier3 = args.includes('--with-tier3');
const withReadHook = args.includes('--with-read-hook');

const HOOKS = {
  session: path.join(pipelineDir, 'hooks', 'tier-session-hook.mjs'),
  reminder: path.join(pipelineDir, 'hooks', 'tier-reminder-hook.mjs'),
  write: path.join(pipelineDir, 'hooks', 'tier-write-hook.mjs'),
  guard: path.join(pipelineDir, 'hooks', 'tool-guard-hook.mjs'),
  stop: path.join(pipelineDir, 'hooks', 'tier-stop-hook.mjs'),
  verify: path.join(pipelineDir, 'tier2-verify.mjs'),
};

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'sandbox',
  GIT_AUTHOR_EMAIL: 'sandbox@test.local',
  GIT_COMMITTER_NAME: 'sandbox',
  GIT_COMMITTER_EMAIL: 'sandbox@test.local',
};
delete gitEnv.NODE_TEST_CONTEXT;

function sh(cwd, ...argv) {
  return execFileSync('git', argv, { cwd, encoding: 'utf8', env: gitEnv }).trim();
}

function invokeJson(script, payload, env) {
  const t0 = performance.now();
  const res = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  });
  const ms = performance.now() - t0;
  let parsed = null;
  try {
    const out = res.stdout.trim();
    if (out) parsed = JSON.parse(out);
  } catch {
    parsed = res.stdout.trim();
  }
  return { ms, status: res.status, out: parsed };
}

function runCli(script, argv, cwd, env) {
  const t0 = performance.now();
  const res = spawnSync(process.execPath, [script, ...argv], { cwd, encoding: 'utf8', env });
  const ms = performance.now() - t0;
  let parsed = null;
  try {
    const raw = (res.stdout || '').trim();
    const idx = raw.indexOf('{');
    if (idx >= 0) parsed = JSON.parse(raw.slice(idx));
  } catch {}
  return { ms, status: res.status, stdout: res.stdout, stderr: res.stderr, json: parsed };
}

function recordMetric(stats, key, res) {
  stats.ms += res.ms;
  stats.byHook[key] = (stats.byHook[key] || 0) + res.ms;
  const h = res.out?.hookSpecificOutput;
  if (h?.additionalContext) stats.injects += 1;
  if (h?.permissionDecision === 'ask') {
    stats.asks += 1;
    stats.events.push(`${key}:ask`);
  }
  if (h?.permissionDecision === 'deny' || res.out?.decision === 'block') {
    stats.blocks += 1;
    stats.events.push(`${key}:${h?.permissionDecision === 'deny' ? 'deny' : 'block'}`);
  }
}

function roundMap(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Number(v.toFixed(1))]));
}

function setupFixture(tmp) {
  const stateDir = path.join(tmp, 'state');
  const paseoHome = path.join(tmp, 'paseo');
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'repo-')));
  const wt = path.join(tmp, 'wt-feat');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(paseoHome, { recursive: true });
  fs.writeFileSync(path.join(paseoHome, 'config.json'), JSON.stringify({
    daemon: {
      agentProfiles: [
        { id: 'agent_profile_gongbu', name: '开发（工部）', provider: 'claude', model: 'flash', modeId: 'auto', thinkingOptionId: 'medium' },
        { id: 'agent_profile_anchasi', name: '审查（按察司）', provider: 'codex', model: 'gpt', modeId: 'auto-review', thinkingOptionId: 'high' },
      ],
    },
  }));

  sh(repo, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(repo, 'src', 'core'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'ui'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'auth'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
  for (let i = 1; i <= 4; i += 1) {
    fs.writeFileSync(path.join(repo, 'src', 'core', `f${i}.mjs`), `export const f${i} = ${i};\n`);
  }
  fs.writeFileSync(path.join(repo, 'src', 'core', 'retry.mjs'), 'export const retry = 0;\n');
  fs.writeFileSync(path.join(repo, 'src', 'ui', 'view.mjs'), 'export const v = 1;\n');
  fs.writeFileSync(
    path.join(repo, 'src', 'core', 'big.mjs'),
    Array.from({ length: 850 }, (_, i) => `export const l${i} = ${i};`).join('\n') + '\n',
  );
  fs.writeFileSync(
    path.join(repo, 'test', 'core.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.equal(1, 1));\n",
  );
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'init');

  const env = {
    ...gitEnv,
    PASEO_HOME: paseoHome,
    PIPELINE_TIER_GATE_STATE: stateDir,
    PIPELINE_TELEMETRY: 'off',
  };
  return { stateDir, paseoHome, repo, wt, env };
}

function runSuite() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-tier-sandbox-'));
  try {
    const { repo, wt, env } = setupFixture(tmp);

    // ---- Tier 0: Read-only Q&A & diagnostics ----
    const t0 = { ms: 0, byHook: {}, injects: 0, asks: 0, blocks: 0, events: [] };
    recordMetric(t0, 'session', invokeJson(HOOKS.session, { source: 'startup', cwd: repo, session_id: 't0' }, env));
    for (let i = 0; i < 10; i += 1) {
      recordMetric(t0, 'reminder', invokeJson(HOOKS.reminder, { prompt: '分析一下为什么 merge 慢？', cwd: repo, session_id: 't0' }, env));
      if (withReadHook) {
        for (let r = 0; r < 3; r += 1) {
          const fp = path.join(repo, 'src', 'core', `f${(r % 4) + 1}.mjs`);
          recordMetric(t0, 'guard_read', invokeJson(HOOKS.guard, { tool_name: 'Read', tool_input: { file_path: fp }, cwd: repo, session_id: 't0' }, env));
        }
      }
      recordMetric(t0, 'guard_bash', invokeJson(HOOKS.guard, { tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: repo, session_id: 't0' }, env));
      recordMetric(t0, 'stop', invokeJson(HOOKS.stop, { cwd: repo, session_id: 't0' }, env));
    }
    for (let i = 0; i < 5; i += 1) {
      recordMetric(t0, 'reminder_sys', invokeJson(HOOKS.reminder, { prompt: '<task-notification>done</task-notification>', cwd: repo, session_id: 't0' }, env));
      recordMetric(t0, 'stop_sys', invokeJson(HOOKS.stop, { cwd: repo, session_id: 't0' }, env));
    }
    t0.passed = t0.injects === 0 && t0.asks === 0 && t0.blocks === 0;

    // ---- Tier 1: Small single-scope primary fix ----
    const t1 = { ms: 0, byHook: {}, injects: 0, asks: 0, blocks: 0, events: [] };
    for (let turn = 1; turn <= 3; turn += 1) {
      const prompt = turn === 1 ? '修复 src/core 的 f1..f3 逻辑' : '继续改下一个文件';
      recordMetric(t1, 'reminder', invokeJson(HOOKS.reminder, { prompt, cwd: repo, session_id: 't1' }, env));
      if (withReadHook) {
        for (let r = 0; r < 3; r += 1) {
          const fp = path.join(repo, 'src', 'core', `f${turn}.mjs`);
          recordMetric(t1, 'guard_read', invokeJson(HOOKS.guard, { tool_name: 'Read', tool_input: { file_path: fp }, cwd: repo, session_id: 't1' }, env));
        }
      }
      const target = path.join(repo, 'src', 'core', `f${turn}.mjs`);
      recordMetric(t1, 'write', invokeJson(HOOKS.write, { tool_name: 'Edit', tool_input: { file_path: target }, cwd: repo, session_id: 't1' }, env));
      fs.appendFileSync(target, `// edit ${turn}a\n`);
      recordMetric(t1, 'write', invokeJson(HOOKS.write, { tool_name: 'Edit', tool_input: { file_path: target }, cwd: repo, session_id: 't1' }, env));
      fs.appendFileSync(target, `// edit ${turn}b\n`);
      if (turn === 3) {
        const testFile = path.join(repo, 'test', 'core.test.mjs');
        recordMetric(t1, 'write', invokeJson(HOOKS.write, { tool_name: 'Edit', tool_input: { file_path: testFile }, cwd: repo, session_id: 't1' }, env));
        fs.appendFileSync(testFile, `test('t1', () => {});\n`);
      }
      recordMetric(t1, 'guard_bash', invokeJson(HOOKS.guard, { tool_name: 'Bash', tool_input: { command: 'node --test test/core.test.mjs' }, cwd: repo, session_id: 't1' }, env));
      recordMetric(t1, 'stop', invokeJson(HOOKS.stop, { cwd: repo, session_id: 't1' }, env));
    }
    t1.passed = t1.injects === 1 && t1.asks === 0 && t1.blocks === 0;

    // ---- Rigor checks 1..3 & 5 on Tier 1 ----
    const rigor = [];
    const r4 = invokeJson(HOOKS.write, { tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src/core/f4.mjs') }, cwd: repo, session_id: 't1' }, env);
    rigor.push({ id: 'tier1_file4_ask', passed: r4.out?.hookSpecificOutput?.permissionDecision === 'ask', actual: r4.out?.hookSpecificOutput?.permissionDecision });

    const rScope = invokeJson(HOOKS.write, { tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src/ui/view.mjs') }, cwd: repo, session_id: 't1' }, env);
    rigor.push({ id: 'tier1_scope2_ask', passed: rScope.out?.hookSpecificOutput?.permissionDecision === 'ask', actual: rScope.out?.hookSpecificOutput?.permissionDecision });

    const rLarge = invokeJson(HOOKS.write, { tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src/core/big.mjs') }, cwd: repo, session_id: 't1-large' }, env);
    rigor.push({ id: 'tier1_large800_ask', passed: rLarge.out?.hookSpecificOutput?.permissionDecision === 'ask', actual: rLarge.out?.hookSpecificOutput?.permissionDecision });

    sh(repo, 'checkout', '--', '.');

    // Rigor check 4: Tier 1 risky auth file triggers Stop block
    invokeJson(HOOKS.reminder, { prompt: '修复 src/auth/token.mjs 问题', cwd: repo, session_id: 't1-risk' }, env);
    const authFile = path.join(repo, 'src', 'auth', 'token.mjs');
    invokeJson(HOOKS.write, { tool_name: 'Write', tool_input: { file_path: authFile }, cwd: repo, session_id: 't1-risk' }, env);
    fs.writeFileSync(authFile, 'export const verifyToken = () => true;\n');
    const rRisk = invokeJson(HOOKS.stop, { cwd: repo, session_id: 't1-risk' }, env);
    rigor.push({
      id: 'tier1_risk_auth_block',
      passed: rRisk.out?.decision === 'block' && /(?:risk-scan|auth)/i.test(rRisk.out?.reason || ''),
      actual: rRisk.out?.decision || 'ok',
    });
    fs.rmSync(authFile, { force: true });

    // Rigor check 5: Tier 1 genuine 3-turn same-file thrashing triggers Stop block
    let rChurn = null;
    for (let round = 1; round <= 3; round += 1) {
      invokeJson(HOOKS.reminder, { prompt: round === 1 ? '修改 retry.mjs' : '再试一次修改 retry.mjs', cwd: repo, session_id: 't1-churn' }, env);
      const retryFile = path.join(repo, 'src', 'core', 'retry.mjs');
      invokeJson(HOOKS.write, { tool_name: 'Edit', tool_input: { file_path: retryFile }, cwd: repo, session_id: 't1-churn' }, env);
      fs.appendFileSync(retryFile, `// retry ${round}\n`);
      rChurn = invokeJson(HOOKS.stop, { cwd: repo, session_id: 't1-churn' }, env);
    }
    rigor.push({
      id: 'tier1_same_file_churn_block',
      passed: rChurn?.out?.decision === 'block' && /连续 3 轮/.test(rChurn?.out?.reason || ''),
      actual: rChurn?.out?.decision || 'ok',
    });
    sh(repo, 'checkout', '--', '.');

    // ---- Tier 2: Linked worktree medium delivery + tier2-verify ----
    sh(repo, 'worktree', 'add', '-q', '-b', 'feat/t2', wt, 'main');
    const wtReal = fs.realpathSync(wt);
    const t2 = { ms: 0, byHook: {}, injects: 0, asks: 0, blocks: 0, events: [] };
    const wtTurnWrites = [
      ['src/core/f1.mjs', 'src/core/f2.mjs', 'src/core/f3.mjs'],
      ['src/core/f4.mjs', 'src/ui/view.mjs', 'src/core/big.mjs'],
      ['src/core/f2.mjs', 'src/core/f3.mjs', 'src/core/f4.mjs'],
      ['test/core.test.mjs', 'test/core.test.mjs', 'test/core.test.mjs'],
    ];
    for (let turn = 0; turn < wtTurnWrites.length; turn += 1) {
      const prompt = turn === 0 ? '在 worktree 里完成跨模块改造' : '继续';
      recordMetric(t2, 'reminder', invokeJson(HOOKS.reminder, { prompt, cwd: wtReal, session_id: 't2' }, env));
      if (withReadHook) {
        for (let r = 0; r < 3; r += 1) {
          const fp = path.join(wtReal, wtTurnWrites[turn][r]);
          recordMetric(t2, 'guard_read', invokeJson(HOOKS.guard, { tool_name: 'Read', tool_input: { file_path: fp }, cwd: wtReal, session_id: 't2' }, env));
        }
      }
      for (const rel of wtTurnWrites[turn]) {
        const fp = path.join(wtReal, rel);
        recordMetric(t2, 'write', invokeJson(HOOKS.write, { tool_name: 'Edit', tool_input: { file_path: fp }, cwd: wtReal, session_id: 't2' }, env));
        fs.appendFileSync(fp, rel.endsWith('.test.mjs') ? `\ntest('t2', () => {});\n` : `\n// wt turn ${turn}\n`);
      }
      recordMetric(t2, 'guard_bash', invokeJson(HOOKS.guard, { tool_name: 'Bash', tool_input: { command: 'node --test test/core.test.mjs' }, cwd: wtReal, session_id: 't2' }, env));
      recordMetric(t2, 'stop', invokeJson(HOOKS.stop, { cwd: wtReal, session_id: 't2' }, env));
    }

    // Rigor check 6: dirty worktree fails tier2-verify
    const vDirty = runCli(HOOKS.verify, ['main', '--verify', 'node --test test/core.test.mjs', '--cwd', wtReal, '--json'], wtReal, env);
    rigor.push({
      id: 'tier2_dirty_verify_fail',
      passed: vDirty.status === 1 && vDirty.json?.verdict === 'FAIL',
      actual: `status=${vDirty.status} verdict=${vDirty.json?.verdict}`,
    });

    sh(wtReal, 'add', '-A');
    sh(wtReal, 'commit', '-qm', 'feat: tier2 change');
    const vClean = runCli(HOOKS.verify, ['main', '--verify', 'node --test test/core.test.mjs', '--cwd', wtReal, '--json'], wtReal, env);
    const vCached = runCli(HOOKS.verify, ['main', '--verify', 'node --test test/core.test.mjs', '--cwd', wtReal, '--json'], wtReal, env);
    t2.verifyDirtyMs = Number(vDirty.ms.toFixed(1));
    t2.verifyCleanMs = Number(vClean.ms.toFixed(1));
    t2.verifyCachedMs = Number(vCached.ms.toFixed(1));
    t2.verifyVerdict = vClean.json?.verdict || 'UNKNOWN';
    t2.passed = t2.injects === 0 && t2.asks === 0 && t2.blocks === 0 && vClean.status === 0 && t2.verifyVerdict === 'PASS';

    rigor.push({
      id: 'tier2_verify_receipt_cached',
      passed: vCached.status === 0 && vCached.json?.verifyCached === true && vCached.json?.verdict === 'PASS',
      actual: `status=${vCached.status} cached=${vCached.json?.verifyCached} verdict=${vCached.json?.verdict}`,
    });

    // Rigor check 7: tool-guard create_agent role late binding
    const rAgent = invokeJson(HOOKS.guard, {
      tool_name: 'mcp__paseo__create_agent',
      tool_input: { provider: 'gongbu', title: 'T-1', initialPrompt: 'p' },
      cwd: repo,
      session_id: 't-agent',
    }, env);
    const hg = rAgent.out?.hookSpecificOutput;
    rigor.push({
      id: 'tool_guard_role_late_bind',
      passed: hg?.permissionDecision === 'allow' && hg?.updatedInput?.provider === 'claude/flash',
      actual: `${hg?.permissionDecision}:${hg?.updatedInput?.provider}`,
    });

    // Rigor check 8: worktree Bash cd <primary> warns ExitWorktree
    const rCd = invokeJson(HOOKS.guard, {
      tool_name: 'Bash',
      tool_input: { command: `cd ${JSON.stringify(repo)} && git status` },
      cwd: wtReal,
      session_id: 't-cd',
    }, env);
    rigor.push({
      id: 'worktree_cd_primary_advise',
      passed: /ExitWorktree/.test(rCd.out?.hookSpecificOutput?.additionalContext || ''),
      actual: rCd.out?.hookSpecificOutput?.additionalContext ? 'advised' : 'none',
    });

    // Rigor check 10: light domain path touch stays PASS while real money math escalates to REVIEW_REQUIRED
    const wtRisk = path.join(tmp, 'wt-risk');
    sh(repo, 'worktree', 'add', '-q', '-b', 'feat/t2-risk', wtRisk, 'main');
    const wtRiskReal = fs.realpathSync(wtRisk);
    fs.mkdirSync(path.join(wtRiskReal, 'src', 'invoices'), { recursive: true });
    fs.writeFileSync(path.join(wtRiskReal, 'src', 'invoices', 'view.mjs'), 'export const label = "Invoice";\n');
    sh(wtRiskReal, 'add', '.');
    sh(wtRiskReal, 'commit', '-qm', 'light invoice label');
    const vLight = runCli(HOOKS.verify, ['main', '--verify', 'node --test test/core.test.mjs', '--cwd', wtRiskReal, '--json'], wtRiskReal, env);
    fs.writeFileSync(path.join(wtRiskReal, 'src', 'invoices', 'view.mjs'), 'export const total = (invoiceAmount, taxAmount) => invoiceAmount + taxAmount;\n');
    sh(wtRiskReal, 'add', '.');
    sh(wtRiskReal, 'commit', '-qm', 'hard money math');
    const vHard = runCli(HOOKS.verify, ['main', '--verify', 'node --test test/core.test.mjs', '--cwd', wtRiskReal, '--json'], wtRiskReal, env);
    rigor.push({
      id: 'risk_scan_light_vs_hard',
      passed: vLight.json?.verdict === 'PASS' && (vLight.json?.risk?.advisoryClasses || []).includes('money') && vHard.json?.verdict === 'REVIEW_REQUIRED',
      actual: `light=${vLight.json?.verdict}(adv=${(vLight.json?.risk?.advisoryClasses || []).join(',')})/hard=${vHard.json?.verdict}`,
    });

    // ---- Tier 3 reference ----
    const t3Bench = runCli(path.join(here, 'benchmark.mjs'), ['--json'], root, env);
    const tier3 = {
      benchmark: t3Bench.json || null,
    };
    if (withTier3) {
      const t3Matrix = runCli(path.join(here, 'sandbox-matrix.mjs'), ['--json'], root, env);
      tier3.sandboxMatrix = t3Matrix.json?.summary || null;
    }

    const ok = t0.passed && t1.passed && t2.passed && rigor.every((item) => item.passed);
    return {
      ok,
      tiers: {
        tier0: {
          passed: t0.passed,
          totalMs: Number(t0.ms.toFixed(1)),
          injects: t0.injects,
          asks: t0.asks,
          blocks: t0.blocks,
          events: t0.events,
          byHookMs: roundMap(t0.byHook),
        },
        tier1: {
          passed: t1.passed,
          totalMs: Number(t1.ms.toFixed(1)),
          injects: t1.injects,
          asks: t1.asks,
          blocks: t1.blocks,
          events: t1.events,
          byHookMs: roundMap(t1.byHook),
        },
        tier2: {
          passed: t2.passed,
          totalMs: Number(t2.ms.toFixed(1)),
          verifyDirtyMs: t2.verifyDirtyMs,
          verifyCleanMs: t2.verifyCleanMs,
          verifyCachedMs: t2.verifyCachedMs,
          verifyVerdict: t2.verifyVerdict,
          injects: t2.injects,
          asks: t2.asks,
          blocks: t2.blocks,
          events: t2.events,
          byHookMs: roundMap(t2.byHook),
        },
        tier3,
      },
      rigor,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const report = runSuite();
if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const { tier0, tier1, tier2, tier3 } = report.tiers;
  console.log('Cross-tier end-to-end sandbox summary');
  console.log('');
  for (const [name, row] of [['Tier 0 (Q&A/diag)', tier0], ['Tier 1 (Primary fix)', tier1], ['Tier 2 (Worktree)', tier2]]) {
    const breakdown = Object.entries(row.byHookMs).map(([k, v]) => `${k}=${v}ms`).join(' ');
    const extra = row.verifyCleanMs !== undefined ? ` verify(dirty/clean/cached)=${row.verifyDirtyMs}/${row.verifyCleanMs}/${row.verifyCachedMs}ms (${row.verifyVerdict})` : '';
    console.log(`${name.padEnd(22)} ${row.passed ? 'PASS' : 'FAIL'} total=${row.totalMs}ms injects=${row.injects} asks=${row.asks} blocks=${row.blocks}${extra}`);
    console.log(`  hooks: ${breakdown}`);
    if (row.events.length) console.log(`  events: ${row.events.join(', ')}`);
  }
  if (tier3.benchmark?.improvement) {
    const { baseline, converged, improvement, contractHeld } = tier3.benchmark;
    console.log(`${'Tier 3 (Benchmark)'.padEnd(22)} PASS exec=${improvement.execPct}% (${baseline.execMin}->${converged.execMin}m) e2e=${improvement.totalPct}% (held=${contractHeld.totalPct}%)`);
  }
  if (tier3.sandboxMatrix) {
    const s = tier3.sandboxMatrix;
    console.log(`${'Tier 3 (10-Matrix)'.padEnd(22)} PASS wall=${s.wallMs.legacy}->${s.wallMs.converged}ms makespan=${s.modelPct}% e2e=${s.endToEndPct}% (held=${s.contractHeldPct}%)`);
  }
  console.log('');
  console.log(`Rigor gates (${report.rigor.filter((r) => r.passed).length}/${report.rigor.length} passed):`);
  for (const r of report.rigor) {
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.id.padEnd(28)} actual=${r.actual}`);
  }
  console.log(`\nOVERALL: ${report.ok ? 'PASS' : 'FAIL'}`);
}
process.exit(report.ok ? 0 : 1);
