import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const scorecardPath = path.join(repoRoot, 'benchmarks/pipeline/scorecard-5d.mjs');
const { evaluateTask, compareReports, renderMarkdown, renderComparisonMarkdown } = await import(scorecardPath);

function git(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim();
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('evaluateTask collects git, openspec, telemetry, and claude transcript across 5 dimensions', () => {
  const tmp = makeTempDir('scorecard-5d-');
  try {
    const repo = path.join(tmp, 'repo');
    const paseoHome = path.join(tmp, 'paseo-home');
    const claudeProjects = path.join(tmp, 'claude-projects');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(path.join(paseoHome, 'agents', 'repo'), { recursive: true });
    fs.mkdirSync(path.join(claudeProjects, 'proj-a'), { recursive: true });

    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.name', 'Test User']);
    git(repo, ['config', 'user.email', 'test@example.com']);

    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src/a.js'), 'export const a = 1;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'init'], {
      GIT_AUTHOR_DATE: '2026-11-22T10:00:00Z',
      GIT_COMMITTER_DATE: '2026-11-22T10:00:00Z',
    });
    const baseSha = git(repo, ['rev-parse', 'HEAD']);

    // Feature work across 4 source files + 1 test + openspec change
    for (const name of ['a.js', 'b.js', 'c.js', 'd.js']) {
      fs.writeFileSync(path.join(repo, 'src', name), `export const ${name[0]} = 2;\nexport const extra = 3;\n`);
    }
    fs.writeFileSync(path.join(repo, 'test/a.test.js'), 'import assert from "node:assert"; assert.ok(true);\n');
    const changeDir = path.join(repo, 'openspec/changes/demo-change');
    fs.mkdirSync(path.join(changeDir, 'specs/core'), { recursive: true });
    fs.writeFileSync(path.join(changeDir, 'specs/core/spec.md'), [
      '# Core Spec',
      '### Requirement: R1',
      '#### Scenario: SCEN-CORE-01',
      '- WHEN called THEN returns 2',
    ].join('\n'));
    fs.writeFileSync(path.join(changeDir, 'tasks.md'), [
      '## Tasks',
      '- [x] 1.1 T-01: implement core',
      '  - Write scope: src/a.js, src/b.js, src/c.js, src/d.js, test/a.test.js',
      '  - Scenarios: SCEN-CORE-01',
      '  - Verify with: `node --test test/a.test.js`',
      '  - Entry: a()',
      '  - Required: yes',
    ].join('\n'));
    fs.writeFileSync(path.join(changeDir, 'review.md'), 'FINAL: pass(anchasi@abc123)\n');

    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'feat: demo change\n\nPipeline-Role: gongbu\nPipeline-Author: agent-1'], {
      GIT_AUTHOR_DATE: '2026-11-22T10:30:00Z',
      GIT_COMMITTER_DATE: '2026-11-22T10:30:00Z',
    });

    const metricsFile = path.join(paseoHome, 'harness-metrics.jsonl');
    const t0 = Date.parse('2026-11-22T10:05:00Z');
    const events = [
      { ts: t0, event: 'tool_guard', action: 'rewrite', reasonCode: 'sanitize_paseo' },
      { ts: t0 + 1000, event: 'tier_write', action: 'ask', reasonCode: 'file_limit', tier: '1' },
      { ts: t0 + 2000, event: 'tier_write', action: 'ask', reasonCode: 'file_limit', tier: '1' },
      { ts: t0 + 3000, event: 'tier2_verify', verdict: 'FAIL', reasonCode: 'dirty_worktree', ok: false, unprovableCount: 0 },
      { ts: t0 + 4000, event: 'tier2_verify', verdict: 'PASS', ok: true, unprovableCount: 0 },
      { ts: t0 + 5000, event: 'review_verdict', verdict: 'pass', tier: '2', role: 'tier2' },
    ];
    fs.writeFileSync(metricsFile, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);

    const sessionId = 'sess-123';
    fs.writeFileSync(path.join(paseoHome, 'agents', 'repo', 'agent-1.json'), JSON.stringify({
      id: 'agent-1',
      provider: 'claude',
      cwd: repo,
      createdAt: '2026-11-22T10:05:00.000Z',
      lastActivityAt: '2026-11-22T10:25:00.000Z',
      labels: { 'pipeline.change': 'demo-change' },
      runtimeInfo: { provider: 'claude', sessionId },
    }));
    fs.writeFileSync(path.join(claudeProjects, 'proj-a', `${sessionId}.jsonl`), [
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-22T10:06:00.000Z',
        message: {
          content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }],
          usage: { input_tokens: 1000, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } },
        },
      }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-11-22T10:12:00.000Z', compactMetadata: { preTokens: 170000 } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-22T10:21:00.000Z',
        message: {
          content: [{ type: 'tool_use', id: 'tu2', name: 'Edit', input: {} }, { type: 'tool_use', id: 'tu3', name: 'Bash', input: {} }],
          usage: { input_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 400, output_tokens: 50 },
        },
      }),
    ].join('\n'));

    const report = evaluateTask({
      repo,
      base: baseSha,
      head: 'HEAD',
      change: 'demo-change',
      'metrics-file': metricsFile,
      'paseo-home': paseoHome,
      'claude-projects': claudeProjects,
      'tier-initial': '1',
      'tier-final': '2',
      'mutations-caught': '4/5',
      'post-merge-fixes': '0',
    });

    assert.equal(report.dimensions.d1.output.sourceFiles, 4);
    assert.equal(report.dimensions.d1.output.testFiles, 1);
    assert.equal(report.dimensions.d1.output.scenarios, 1);
    assert.equal(report.dimensions.d1.transcripts.assistantTurns, 2);
    assert.equal(report.dimensions.d1.transcripts.toolCalls, 3);
    assert.equal(report.dimensions.d1.transcripts.compactions, 1);
    assert.equal(report.dimensions.d1.transcripts.totalTokens, 2550);
    assert.equal(report.dimensions.d1.telemetry.frictionTotal, 4);
    assert.equal(report.dimensions.d1.telemetry.tierWrite.fileLimit, 2);
    assert.equal(report.dimensions.d1.humanInterventions, 'NOT_COLLECTED');
    assert.equal(report.dimensions.d2.mutationProbe.ratePct, 80);
    assert.equal(report.dimensions.d3.transcriptSpanMinutes, 15);
    assert.equal(report.dimensions.d4.objectiveTierRequired, 2);
    assert.equal(report.dimensions.d4.misrouted, true);
    assert.equal(report.dimensions.d5.openSpecReview.finalMarkers, 1);
    assert.equal(report.dimensions.d5.postMergeFixes, 0);
    assert.ok(report.healthFlags.includes('YELLOW:compaction=1'));
    assert.ok(report.healthFlags.includes('YELLOW:dirty_worktree'));
    assert.ok(report.healthFlags.includes('YELLOW:tier_overflow'));

    const md = renderMarkdown(report);
    assert.match(md, /# 5D Task Scorecard: demo-change/);
    assert.match(md, /4\/5 \(80%\)/);

    const comparison = compareReports([report, report]);
    assert.equal(comparison.count, 2);
    const compMd = renderComparisonMarkdown(comparison);
    assert.match(compMd, /5D Scorecard Comparison \(2 tasks\)/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scorecard-5d CLI leaves missing signals as NOT_COLLECTED and supports --compare', () => {
  const tmp = makeTempDir('scorecard-5d-cli-');
  try {
    const out1 = path.join(tmp, 'r1.json');
    const res1 = spawnSync(process.execPath, [
      scorecardPath,
      '--repo', repoRoot,
      '--base', 'HEAD~1',
      '--head', 'HEAD',
      '--metrics-file', path.join(tmp, 'missing.jsonl'),
      '--paseo-home', path.join(tmp, 'missing-paseo'),
      '--claude-projects', path.join(tmp, 'missing-claude'),
      '--json',
      '--out', out1,
    ], { encoding: 'utf8' });
    assert.equal(res1.status, 0, res1.stderr);
    const parsed = JSON.parse(fs.readFileSync(out1, 'utf8'));
    assert.equal(parsed.dimensions.d1.transcripts, 'NOT_COLLECTED');
    assert.equal(parsed.dimensions.d1.telemetry, 'NOT_COLLECTED');
    assert.equal(parsed.dimensions.d5.postMergeFixes, 'NOT_COLLECTED');

    const cmp = spawnSync(process.execPath, [
      scorecardPath,
      '--compare', out1,
      '--markdown',
    ], { encoding: 'utf8' });
    assert.equal(cmp.status, 0, cmp.stderr);
    assert.match(cmp.stdout, /5D Scorecard Comparison \(1 tasks\)/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scorecard-5d deduplicates multi-block assistant message.id usage, computes latency breakdown, and tracks read thrash', () => {
  const tmp = makeTempDir('scorecard-5d-dedup-');
  try {
    const metricsFile = path.join(tmp, 'metrics.jsonl');
    const transcript = path.join(tmp, 'sess.jsonl');
    const t0 = Date.parse('2026-11-24T01:00:00.000Z');
    fs.writeFileSync(metricsFile, [
      { ts: t0 + 1000, event: 'tool_guard', action: 'advise', reasonCode: 'recon_stall' },
      { ts: t0 + 2000, event: 'tool_guard', action: 'advise', reasonCode: 'worktree_read_stall' },
      { ts: t0 + 3000, event: 'author_guard', action: 'advise', reasonCode: 'author_repeat_read' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');

    const usage1 = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 500, output_tokens: 200 };
    const lines = [
      { type: 'api-request', timestamp: '2026-11-24T01:00:00.000Z' },
      // Same message.id across thinking + 2 Read blocks -> 1 turn, usage counted once, 2 toolCalls
      { type: 'assistant', timestamp: '2026-11-24T01:01:00.000Z', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'abcde' }], usage: usage1 } },
      { type: 'assistant', timestamp: '2026-11-24T01:01:01.000Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/repo/a.ts' } }], usage: usage1 } },
      { type: 'assistant', timestamp: '2026-11-24T01:01:02.000Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: '/repo/a.ts' } }], usage: usage1 } },
      { type: 'user', timestamp: '2026-11-24T01:01:03.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'ok' }, { type: 'tool_result', tool_use_id: 'r2', content: 'ok' }] } },
      { type: 'system', subtype: 'compact_boundary', timestamp: '2026-11-24T01:03:00.000Z', compactMetadata: { durationMs: 120000 } },
      { type: 'api-request', timestamp: '2026-11-24T01:03:01.000Z' },
      { type: 'assistant', timestamp: '2026-11-24T01:04:01.000Z', message: { id: 'msg_2', content: [
        { type: 'tool_use', id: 'r3', name: 'Read', input: { file_path: '/repo/a.ts' } },
        { type: 'tool_use', id: 'r4', name: 'Read', input: { file_path: '/repo/a.ts' } },
        { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'rg x' } },
      ], usage: { input_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 100 } } },
      { type: 'user', timestamp: '2026-11-24T01:04:07.000Z', message: { content: [
        { type: 'tool_result', tool_use_id: 'r3', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'r4', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'b1', content: 'ok' },
      ] } },
    ];
    fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const report = evaluateTask({
      repo: repoRoot,
      base: 'HEAD~1',
      head: 'HEAD',
      since: '2026-11-24T00:59:00.000Z',
      until: '2026-11-24T01:05:00.000Z',
      'metrics-file': metricsFile,
      'paseo-home': path.join(tmp, 'missing-paseo'),
      'claude-projects': path.join(tmp, 'missing-claude'),
      transcript: [transcript],
    });

    const t = report.dimensions.d1.transcripts;
    assert.equal(t.assistantTurns, 2);
    assert.equal(t.toolCalls, 5);
    assert.equal(t.totalTokens, 2100);
    assert.equal(t.thinkingChars, 5);
    assert.equal(t.maxRepeatFileReads, 4);
    assert.equal(t.repeatedFilesCount, 1);
    assert.equal(t.slowBashCalls, 1);
    assert.equal(report.dimensions.d3.apiWaitMinutes, 2);
    assert.equal(report.dimensions.d3.compactionMinutes, 2);
    assert.equal(report.dimensions.d3.bashWaitMinutes, 0.1);
    assert.equal(report.dimensions.d3.avgToolsPerTurn, 2.5);
    assert.equal(report.dimensions.d3.effectiveOutputTokPerSec, 2.5);
    assert.equal(report.dimensions.d3.bashOnlyTurns, 0);
    assert.equal(report.dimensions.d3.bashOnlyApiWaitMinutes, 0);
    assert.equal(report.dimensions.d1.telemetry.toolGuard.reconStall, 1);
    assert.equal(report.dimensions.d1.telemetry.toolGuard.worktreeReadStall, 1);
    assert.equal(report.dimensions.d1.telemetry.authorGuard.repeatRead, 1);
    assert.ok(report.healthFlags.includes('YELLOW:repeat_file_reads'));
    assert.match(renderMarkdown(report), /Turn efficiency/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scorecard-5d tracks multi-line bash-only turns and flags YELLOW:fragmented_turns', () => {
  const tmp = makeTempDir('scorecard-5d-d3-');
  try {
    const fragmentedTranscript = path.join(tmp, 'fragmented.jsonl');
    const batchedTranscript = path.join(tmp, 'batched.jsonl');
    const buildLines = (toolsPerTurn) => {
      const entries = [];
      let sec = 0;
      for (let i = 0; i < 40; i += 1) {
        const mid = `m_${i}`;
        entries.push({ type: 'api-request', timestamp: new Date(Date.parse('2026-11-24T02:00:00.000Z') + sec * 1000).toISOString() });
        sec += 3;
        const tsThink = new Date(Date.parse('2026-11-24T02:00:00.000Z') + sec * 1000).toISOString();
        entries.push({
          type: 'assistant',
          timestamp: tsThink,
          message: { id: mid, content: [{ type: 'thinking', thinking: 'x' }], usage: { input_tokens: 100, output_tokens: 30 } },
        });
        for (let j = 0; j < toolsPerTurn; j += 1) {
          entries.push({
            type: 'assistant',
            timestamp: tsThink,
            message: { id: mid, content: [{ type: 'tool_use', id: `tu_${i}_${j}`, name: j === 0 ? 'Bash' : 'Read', input: {} }], usage: { input_tokens: 100, output_tokens: 30 } },
          });
        }
        sec += 1;
      }
      return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    };

    fs.writeFileSync(fragmentedTranscript, buildLines(1));
    fs.writeFileSync(batchedTranscript, buildLines(2));

    const fragReport = evaluateTask({
      repo: repoRoot,
      base: 'HEAD~1',
      head: 'HEAD',
      'paseo-home': path.join(tmp, 'missing-paseo'),
      'claude-projects': path.join(tmp, 'missing-claude'),
      transcript: [fragmentedTranscript],
    });
    assert.equal(fragReport.dimensions.d3.avgToolsPerTurn, 1);
    assert.equal(fragReport.dimensions.d3.bashOnlyTurns, 40);
    assert.equal(fragReport.dimensions.d3.bashOnlyApiWaitMinutes, 2);
    assert.equal(fragReport.dimensions.d3.effectiveOutputTokPerSec, 10);
    assert.ok(fragReport.healthFlags.includes('YELLOW:fragmented_turns'));

    const batchReport = evaluateTask({
      repo: repoRoot,
      base: 'HEAD~1',
      head: 'HEAD',
      'paseo-home': path.join(tmp, 'missing-paseo'),
      'claude-projects': path.join(tmp, 'missing-claude'),
      transcript: [batchedTranscript],
    });
    assert.equal(batchReport.dimensions.d3.avgToolsPerTurn, 2);
    assert.equal(batchReport.dimensions.d3.bashOnlyTurns, 0);
    assert.ok(!batchReport.healthFlags.includes('YELLOW:fragmented_turns'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
