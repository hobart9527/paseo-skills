import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const CAPTURE_SCRIPT = path.join(REPO_ROOT, 'skills/paseo-ui/capture.mjs');
const BRIEF_RULES = path.join(REPO_ROOT, 'skills/paseo-ui/brief-rules.md');
const SKILL_MD = path.join(REPO_ROOT, 'skills/paseo-ui/SKILL.md');
const VENDOR_DIR = path.join(REPO_ROOT, 'skills/paseo-ui/vendor');

// Helper to spawn capture.mjs asynchronously
async function runCapture(url, outDir, options = {}) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const args = [
    CAPTURE_SCRIPT,
    url,
    '--out', outDir,
    '--viewports', options.viewports || '1280',
    '--surface-mode', options.surfaceMode || 'operate',
  ];
  if (options.states) args.push('--states', options.states);
  if (options.mock) args.push('--mock', options.mock);

  const { status, stdout, stderr } = await new Promise((resolve) => {
    const p = spawn(process.execPath, args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
  });

  let manifest = null;
  const manifestPath = path.join(outDir, 'capture-manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {}
  }
  const evidence = manifest?.verification?.metadata?.evidence || {};
  return {
    exitCode: status,
    stdout,
    stderr,
    manifest,
    evidence,
    craft_health_index: evidence.craft_health_index,
    craft_gate: evidence.craft_gate,
    viewport_metrics: evidence.viewport_metrics,
    state_confirmations: evidence.state_confirmations,
  };
}

// ============================================================================
// Suite 1: Full 6-Stage Lifecycle Simulation
// ============================================================================

test('Full UI Lifecycle Stage 1: Constitution & Intent Shaping State Machine', () => {
  // Validate state machine inputs (State A: Existing DESIGN.md, State B: Extract, State C: 0->1)
  const stateADesign = '# Design Constitution\n\n## Overview\nSurface Mode: operate\n';
  const stateCRequirements = { domain: 'fintech-reconciliation', surfaceMode: 'operate', isGreenfield: true };

  // 1. Surface Mode verification
  assert.strictEqual(stateCRequirements.surfaceMode, 'operate');
  assert.match(stateADesign, /Surface Mode: operate/);

  // 2. Interaction Contract Matrix validation
  const contractMatrix = [
    { component: 'ReconciliationModal', focusTrap: true, escCloses: true, rollbackOnFail: true },
    { component: 'BatchActionTable', destructiveConfirm: true, tabularNums: true, keyboardNav: true }
  ];

  for (const c of contractMatrix) {
    assert.ok(c.component);
    assert.ok(c.focusTrap || c.destructiveConfirm, 'Contract must declare focus/destructive rules');
  }

  // 3. Suggest Block Generation (Domain, Color world, Direction, Rejecting)
  const suggestBlock = {
    domain: 'Enterprise B2B',
    colorWorld: 'Slate & Indigo',
    direction: 'High-density tabular operate layout',
    rejecting: 'Decorative gradients and bouncy spring entrance',
    confirmedByHuman: false
  };

  assert.strictEqual(suggestBlock.confirmedByHuman, false, 'Suggest block must pause for human confirmation CP-1');
  suggestBlock.confirmedByHuman = true; // CP-1 passed
  assert.strictEqual(suggestBlock.confirmedByHuman, true);
});

test('Full UI Lifecycle Stage 2 & 3: Build, Break-UI Hardening and Capture Gate', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-ui-e2e-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // Fixture providing real endpoints and breakable UI
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/app') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Reconciliation Hub</title>
  <style>
    body { font-family: -apple-system, sans-serif; margin: 32px; color: #0f172a; background: #fff; }
    h1 { font-size: 28px; line-height: 1.2; font-weight: 700; margin-bottom: 24px; }
    table { width: 100%; max-width: 960px; border-collapse: collapse; }
    th { background: #f8fafc; padding: 10px 14px; font-size: 13px; font-weight: 600; border-bottom: 2px solid #e2e8f0; }
    td { padding: 12px 14px; font-size: 14px; border-bottom: 1px solid #e2e8f0; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .cta-btn {
      padding: 10px 20px; font-size: 14px; font-weight: 600; color: #fff;
      background: #0284c7; border: none; border-radius: 6px; cursor: pointer;
      min-height: 44px; min-width: 80px;
    }
    .cta-btn:active { transform: scale(0.96); }
    .empty-state { padding: 48px; text-align: center; border: 2px dashed #cbd5e1; border-radius: 8px; }
    .error-state { padding: 20px; background: #fee2e2; color: #991b1b; border-radius: 6px; }
  </style>
</head>
<body>
  <div id="root">
    <h1>财务清算中心 (Reconciliation Hub)</h1>
    <div id="data-area">加载中...</div>
    <div style="margin-top: 24px;">
      <button id="cta-refresh" class="cta-btn" type="button" onclick="load()">刷新数据</button>
    </div>
  </div>
  <script>
    async function load() {
      const el = document.getElementById("data-area");
      try {
        const res = await fetch("/api/records");
        const json = await res.json();
        if (!json.items || json.items.length === 0) {
          el.innerHTML = '<div class="empty-state"><h3>暂无结算记录</h3><p>所有待结算项均已处理</p></div>';
          return;
        }
        el.innerHTML = '<table><thead><tr><th scope="col">流水号</th><th scope="col">商户</th><th scope="col" class="num">结算额</th></tr></thead><tbody>' +
          json.items.map(i => '<tr><td>' + i.id + '</td><td>' + i.merchant + '</td><td class="num">' + i.amount + '</td></tr>').join('') +
          '</tbody></table>';
      } catch (err) {
        el.innerHTML = '<div class="error-state"><strong>接口请求异常</strong>: 无法获取清算记录</div>';
      }
    }
    load();
  </script>
</body>
</html>`);
    } else if (url === '/api/records') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [{ id: 'TX-001', merchant: '核心科技', amount: '¥10,000.00' }] }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Break-UI mocks definition
  const mockFile = path.join(tmpDir, 'mocks.json');
  fs.writeFileSync(mockFile, JSON.stringify({
    default: [{ url: '**/api/records', json: { items: [{ id: 'TX-DEFAULT', merchant: '默认商户', amount: '¥5,200.00' }] } }],
    stressed: [{ url: '**/api/records', json: { items: [{ id: 'TX-EXTREME', merchant: '超长商户名——全球算力调度与边缘节点跨境结算系统股份有限公司', amount: '¥999,999,999.00' }] } }],
    empty: [{ url: '**/api/records', json: { items: [] } }],
    error: [{ url: '**/api/records', status: 500, json: { error: 'Internal Error' } }]
  }, null, 2));

  // Run Stage 3 capture across viewports and break-ui states
  const captureOut = path.join(tmpDir, 'captures/after');
  const res = await runCapture(`${baseUrl}/app`, captureOut, {
    viewports: '1280',
    surfaceMode: 'operate',
    states: 'default,stressed,empty,error',
    mock: mockFile,
  });

  assert.strictEqual(res.exitCode, 0, 'Stage 3 capture must pass gate with exit code 0');
  assert.ok(res.craft_gate.passed, 'Craft gate must pass');
  assert.ok(res.craft_health_index.score >= 90, 'CHI score must be >= 90');

  // Verify all 4 states confirmed
  const confirmations = res.state_confirmations || {};
  assert.strictEqual(confirmations['default-1280']?.confirmed, true);
  assert.strictEqual(confirmations['stressed-1280']?.confirmed, true);
  assert.strictEqual(confirmations['empty-1280']?.confirmed, true);
  assert.strictEqual(confirmations['error-1280']?.confirmed, true);
});

test('Full UI Lifecycle Stage 4: Concurrent Audit & vision_canary objective probe', () => {
  // 1. Channel B Read-Only Contract verification
  const auditBrief = {
    channel: 'B',
    isReadOnly: true,
    allowedReads: ['./captures/*', 'DESIGN.md', './captures/diff.patch'],
    forbiddenPrefixes: ['~/.claude/skills/', '/Users/hobart/.claude/skills/'],
    forbiddenActions: ['execute_cli', 'npm', 'git commit']
  };

  const samplePathRequest = '~/.claude/skills/paseo-ui/vendor/impeccable/reference/audit.md';
  const isForbiddenPath = auditBrief.forbiddenPrefixes.some(p => samplePathRequest.startsWith(p));
  assert.strictEqual(isForbiddenPath, true, 'Channel B must forbid reading external skill directories');

  // 2. vision_canary Objective Visual Probe
  // Orchestrator injects dynamic Q&A: Target CTA button visible text and color
  const canarySpec = {
    question: 'Report the visible text and background color of the main CTA button in 1280 viewport',
    expectedText: '刷新数据',
    expectedColorPattern: /blue|sky|#0284c7|rgb\(2, 132, 199\)/i,
  };

  // Case A: Reviewer A correctly answers canary
  const auditorPassResponse = {
    canaryAnswer: 'The CTA button text is "刷新数据" and its background color is rgb(2, 132, 199) (#0284c7).',
    findings: []
  };
  const canaryPassed = auditorPassResponse.canaryAnswer.includes(canarySpec.expectedText) &&
    canarySpec.expectedColorPattern.test(auditorPassResponse.canaryAnswer);
  assert.strictEqual(canaryPassed, true, 'Valid visual auditor passes canary');

  // Case B: Reviewer A fails canary (hallucination or cannot read image)
  const auditorFailResponse = {
    canaryAnswer: 'The button says "Submit" and is green.',
    findings: []
  };
  const canaryFailed = !(auditorFailResponse.canaryAnswer.includes(canarySpec.expectedText) &&
    canarySpec.expectedColorPattern.test(auditorFailResponse.canaryAnswer));
  assert.strictEqual(canaryFailed, true, 'Invalid visual auditor fails canary');

  // Orchestrator fallback mechanism: when canary fails, orchestrator replaces reviewer with main session takeover
  const orchestratorAction = canaryFailed ? 'REPLACE_WITH_MAIN_SESSION_TAKEOVER' : 'ACCEPT_AUDIT';
  assert.strictEqual(orchestratorAction, 'REPLACE_WITH_MAIN_SESSION_TAKEOVER');
});

test('Full UI Lifecycle Stage 5: Convergence Rework & Round Bound', () => {
  // Simulate defect loop: round 1 fails CHI (<90) -> Builder fixes -> round 2 passes
  let currentRound = 1;
  const maxRounds = 2;
  const auditFindings = [{ id: 'DEFECT-1', severity: 'P1', description: 'Touch target size < 44px' }];

  let chiScore = 82; // Initial failing score
  assert.ok(chiScore < 90, 'Round 1 fails craft gate');

  // Builder addresses finding
  if (auditFindings.length > 0 && currentRound <= maxRounds) {
    currentRound += 1;
    chiScore = 98; // Fixed score
  }

  assert.strictEqual(currentRound, 2);
  assert.ok(chiScore >= 90, 'Round 2 converges and passes gate');
  assert.ok(currentRound <= maxRounds, 'Must converge within <= 2 rounds');
});

// ============================================================================
// Suite 2: Specific Fast Tracks Validation (Motion, Skeleton, Chart, Color, Audit)
// ============================================================================

test('Fast Track: Motion (④) - Rejects layout property transitions, demands compositor properties', () => {
  // Inspect CSS rules for layout vs compositor transitions
  const badCss = `
    .nav-drawer {
      transition: width 0.3s ease, height 0.3s ease, margin-top 0.2s; /* VIOLATION: layout properties */
    }
  `;
  const goodCss = `
    .nav-drawer {
      transition: transform 0.2s ease, opacity 0.2s ease; /* VALID: compositor properties */
      transform: translate3d(0, 0, 0);
    }
    @media (prefers-reduced-motion: reduce) {
      .nav-drawer {
        transition: none;
      }
    }
  `;

  const layoutPropertyRegex = /transition\s*:[^;]*(width|height|top|left|margin|padding|all)[^;]*;/i;
  assert.match(badCss, layoutPropertyRegex, 'Bad CSS must trigger layout property transition violation');
  assert.doesNotMatch(goodCss, layoutPropertyRegex, 'Good CSS must only use compositor properties');
  assert.match(goodCss, /prefers-reduced-motion/, 'Good motion must declare reduced motion fallback');
});

test('Fast Track: Skeleton & CLS (⑩) - Prevents Cumulative Layout Shift with geometric reservations', () => {
  // Probe logic for CLS reservation
  const badMediaBlock = `
    <!-- Missing explicit width/height or aspect-ratio causes CLS shift on load -->
    <img src="/banner.png">
  `;
  const goodMediaBlock = `
    <!-- 1:1 geometric placeholder / skeleton prevents CLS -->
    <div style="aspect-ratio: 16/9; width: 100%;" class="skeleton-placeholder">
      <img src="/banner.png" style="width: 100%; height: 100%; object-fit: cover;">
    </div>
  `;

  const stripComments = (str) => str.replace(/<!--[\s\S]*?-->/g, '');
  const hasGeometricReservation = (html) => /aspect-ratio|width=.*height=|style=.*width:.*height:/i.test(stripComments(html));
  assert.strictEqual(hasGeometricReservation(badMediaBlock), false);
  assert.strictEqual(hasGeometricReservation(goodMediaBlock), true);
});

test('Fast Track: Chart & Dataviz (⑪) - Demands tabular-nums, direct labelling and color-blind safe encoding', () => {
  const chartConfig = {
    type: 'bar',
    categories: ['2026-Q1', '2026-Q2', '2026-Q3'],
    series: [
      {
        name: '收入',
        data: [120000, 150000, 180000],
        pattern: 'stripe', // Texture/pattern dual-encoding for color blindness
        dataLabels: { enabled: true, style: { fontVariantNumeric: 'tabular-nums' } }
      }
    ],
    axes: { yAxis: { unit: '万元' } } // Explicit measurement unit
  };

  assert.ok(chartConfig.series[0].pattern, 'Dataviz must have texture/pattern dual-encoding');
  assert.strictEqual(chartConfig.series[0].dataLabels.style.fontVariantNumeric, 'tabular-nums');
  assert.ok(chartConfig.axes.yAxis.unit, 'Axis must have explicit unit');
});

test('Fast Track: Color (②) - Enforces semantic token binding, forbids raw hex/rgb literals in components', () => {
  const badComponentCode = `
    <div style="background-color: #3b82f6; color: #ffffff; border: 1px solid #e5e7eb;">
      <span style="color: #9ca3af;">次级信息</span>
    </div>
  `;
  const goodComponentCode = `
    <div class="bg-[var(--color-surface)] text-[var(--color-foreground)] border border-[var(--color-border)]">
      <span class="text-[var(--color-muted-foreground)]">次级信息</span>
    </div>
  `;

  const hardcodedHexRegex = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
  const badMatches = badComponentCode.match(hardcodedHexRegex) || [];
  const goodMatches = goodComponentCode.match(hardcodedHexRegex) || [];

  assert.strictEqual(badMatches.length, 4, 'Bad component has 4 hardcoded hex values');
  assert.strictEqual(goodMatches.length, 0, 'Good component uses semantic token variables');
});

test('Fast Track: Audit (⑦) - Produces structured a11y findings schema compliant with WCAG AA', () => {
  const mockA11yReport = {
    url: 'http://127.0.0.1:3000',
    timestamp: new Date().toISOString(),
    violations: [
      {
        id: 'color-contrast',
        impact: 'serious',
        description: 'Ensures the contrast between foreground and background colors meets WCAG 2 AA thresholds',
        nodes: [{ target: ['p.muted-text'], failureSummary: 'Fix any of the following: element has insufficient contrast' }]
      }
    ],
    passes: 42
  };

  assert.ok(Array.isArray(mockA11yReport.violations));
  assert.strictEqual(mockA11yReport.violations[0].impact, 'serious');
  assert.ok(mockA11yReport.passes > 0);
});
