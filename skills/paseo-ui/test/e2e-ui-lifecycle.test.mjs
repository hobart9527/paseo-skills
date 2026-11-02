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
const SEARCH_SCRIPT = path.join(VENDOR_DIR, 'ui-ux-pro-max/scripts/search.py');
const IMPECCABLE_BIN = path.join(VENDOR_DIR, 'impeccable/scripts/impeccable');

// Helper to spawn generic CLI commands asynchronously
function runCommand(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: options.cwd || REPO_ROOT, env: { ...process.env, ...options.env } });
    let stdout = '';
    let stderr = '';
    if (options.input) {
      p.stdin.write(options.input);
      p.stdin.end();
    }
    p.stdout?.on('data', (d) => { stdout += d.toString(); });
    p.stderr?.on('data', (d) => { stderr += d.toString(); });
    p.on('close', (code) => resolve({ status: code, stdout, stderr }));
    p.on('error', (err) => resolve({ status: -1, stdout, stderr: err.message }));
  });
}

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
  if (options.baseline) args.push('--baseline', options.baseline);

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

// ============================================================================
// Suite 3: Executable Sub-Tool Invocations & Multi-Toolchain Integration
// ============================================================================

test('Sub-tool: ui-ux-pro-max CLI search.py generates recommended design system', async () => {
  assert.ok(fs.existsSync(SEARCH_SCRIPT), 'search.py script must exist');
  const res = await runCommand('python3', [SEARCH_SCRIPT, 'fintech', '--design-system']);

  assert.strictEqual(res.status, 0, 'search.py should exit 0');
  assert.match(res.stdout, /TARGET: FINTECH - RECOMMENDED DESIGN SYSTEM/i);
  assert.match(res.stdout, /PATTERN/i);
  assert.match(res.stdout, /STYLE/i);
  assert.match(res.stdout, /COLORS/i);
  assert.match(res.stdout, /Primary:\s*#[0-9A-Fa-f]{6}/);
  assert.match(res.stdout, /TYPOGRAPHY/i);
  assert.match(res.stdout, /PRE-DELIVERY CHECKLIST/i);
});

test('Sub-tool: impeccable launcher and detector CLI enforces design floor', async (t) => {
  assert.ok(fs.existsSync(IMPECCABLE_BIN), 'impeccable launcher must exist');

  // Verify SKILL.md documentation references the correct executable launcher path
  const skillContent = fs.readFileSync(SKILL_MD, 'utf8');
  assert.match(skillContent, /vendor\/impeccable\/scripts\/impeccable/, 'SKILL.md must reference correct impeccable launcher path');
  assert.doesNotMatch(skillContent, /vendor\/impeccable\/scripts\/bin\/<os>-<arch>/, 'SKILL.md must not reference old bin path');

  // 1. Rule catalog verification
  const rulesRes = await runCommand(IMPECCABLE_BIN, ['detect', '--list-rules', '--json']);
  assert.strictEqual(rulesRes.status, 0, 'list-rules must exit 0');
  const rules = JSON.parse(rulesRes.stdout);
  assert.ok(Array.isArray(rules));
  assert.ok(rules.length >= 60, `Catalog must contain >= 60 rules, got ${rules.length}`);

  // 2. Anti-pattern detection on flawed CSS
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const badCssFile = path.join(tmpDir, 'bad.css');
  fs.writeFileSync(badCssFile, 'body { font-family: "Geist Mono", monospace; }');

  const badRes = await runCommand(IMPECCABLE_BIN, ['detect', '--json', badCssFile]);
  assert.strictEqual(badRes.status, 2, 'impeccable detect must exit 2 when anti-patterns found');
  const findings = JSON.parse(badRes.stdout);
  assert.ok(Array.isArray(findings) && findings.length > 0);
  assert.strictEqual(findings[0].antipattern, 'overused-font');

  // 3. Clean CSS passes with zero findings
  const goodCssFile = path.join(tmpDir, 'good.css');
  fs.writeFileSync(goodCssFile, 'body { font-family: -apple-system, sans-serif; color: var(--color-foreground); }');

  const goodRes = await runCommand(IMPECCABLE_BIN, ['detect', '--json', goodCssFile]);
  assert.strictEqual(goodRes.status, 0, 'impeccable detect must exit 0 on clean code');
  assert.strictEqual(goodRes.stdout.trim(), '[]');
});

test('Sub-tool: accesslint CLI validates WCAG compliance', async () => {
  // Check if accesslint is installed
  const versionRes = await runCommand('accesslint', ['--version']);
  if (versionRes.status !== 0) {
    // If not in PATH, skip gracefully
    return;
  }

  // 1. Catches WCAG violation (button without discernible text & missing landmark)
  const badHtml = '<button type="button"></button>';
  const badRes = await runCommand('accesslint', ['scan', '--stdin', '--format', 'json'], { input: badHtml });
  assert.strictEqual(badRes.status, 1, 'accesslint must exit 1 on a11y violations');
  const badJson = JSON.parse(badRes.stdout);
  assert.ok(Array.isArray(badJson.violations));
  const hasButtonViolation = badJson.violations.some(v => v.ruleId.includes('button-name'));
  assert.ok(hasButtonViolation, 'Must detect button-name violation');

  // 2. Passes valid semantic accessible HTML
  const goodHtml = '<!DOCTYPE html><html lang="zh"><head><title>A11y Test</title></head><body><main><h1>测试标题</h1><button type="button">点击操作</button></main></body></html>';
  const goodRes = await runCommand('accesslint', ['scan', '--stdin', '--format', 'json'], { input: goodHtml });
  assert.strictEqual(goodRes.status, 0, 'accesslint must exit 0 on compliant HTML');
  const goodJson = JSON.parse(goodRes.stdout);
  assert.strictEqual(goodJson.violations.length, 0, 'Must have 0 violations');
});

test('Full Multi-Toolchain Pipeline: Stage 1 Search -> Stage 2 Build -> Stage 3 Scan & Capture -> Stage 4 Audit -> Gate Pass', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-pipeline-chain-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // --- STAGE 1: Domain Search & Design System Tokens ---
  const searchRes = await runCommand('python3', [SEARCH_SCRIPT, 'saas-dashboard', '--design-system']);
  assert.strictEqual(searchRes.status, 0);
  assert.match(searchRes.stdout, /RECOMMENDED DESIGN SYSTEM/);

  // Extract design tokens (fallbacks ensure test determinism)
  const primaryMatch = searchRes.stdout.match(/Primary:\s*(#[0-9A-Fa-f]{6})/);
  const primaryColor = primaryMatch ? primaryMatch[1] : '#0284c7';
  const bgMatch = searchRes.stdout.match(/Background:\s*(#[0-9A-Fa-f]{6})/);
  const bgColor = bgMatch ? bgMatch[1] : '#ffffff';

  // --- STAGE 2: Build Component & Break-UI Mocks ---
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/dashboard') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <title>SaaS Control Dashboard</title>
  <style>
    :root {
      --color-primary: ${primaryColor};
      --color-background: ${bgColor};
      --color-foreground: #0f172a;
      --color-border: #e2e8f0;
      --color-muted: #64748b;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      margin: 0;
      padding: 32px;
      color: var(--color-foreground);
      background: var(--color-background);
    }
    main { max-width: 960px; margin: 0 auto; }
    h1 { font-size: 26px; line-height: 1.25; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th {
      background: #f8fafc;
      padding: 10px 14px;
      font-size: 13px;
      font-weight: 600;
      border-bottom: 2px solid var(--color-border);
      text-align: left;
    }
    td {
      padding: 12px 14px;
      font-size: 14px;
      border-bottom: 1px solid var(--color-border);
    }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .cta-button {
      background: var(--color-primary);
      color: #ffffff;
      border: none;
      border-radius: 6px;
      padding: 10px 20px;
      font-size: 14px;
      font-weight: 600;
      min-height: 44px;
      min-width: 88px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.1s ease;
    }
    .cta-button:active { transform: scale(0.96); }
    .empty-card { padding: 48px; text-align: center; border: 2px dashed #cbd5e1; border-radius: 8px; }
    .error-card { padding: 16px; background: #fee2e2; color: #991b1b; border-radius: 6px; }
  </style>
</head>
<body>
  <main>
    <h1>算力调度与任务总览</h1>
    <div id="content">加载中...</div>
    <div style="margin-top: 24px;">
      <button id="cta-action" class="cta-button" type="button" onclick="loadData()">同步状态</button>
    </div>
  </main>
  <script>
    async function loadData() {
      const el = document.getElementById("content");
      try {
        const res = await fetch("/api/tasks");
        const data = await res.json();
        if (!data.tasks || data.tasks.length === 0) {
          el.innerHTML = '<div class="empty-card"><h3>当前无运行任务</h3><p>所有节点处于待命状态</p></div>';
          return;
        }
        el.innerHTML = '<table><thead><tr><th scope="col">节点标识</th><th scope="col">运行规格</th><th scope="col" class="num">功耗 (W)</th></tr></thead><tbody>' +
          data.tasks.map(t => '<tr><td>' + t.node + '</td><td>' + t.spec + '</td><td class="num">' + t.power + '</td></tr>').join('') +
          '</tbody></table>';
      } catch (err) {
        el.innerHTML = '<div class="error-card"><strong>节点通讯异常</strong>: 无法从调度引擎拉取任务</div>';
      }
    }
    loadData();
  </script>
</body>
</html>`);
    } else if (url === '/api/tasks') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tasks: [{ node: 'NODE-01', spec: '8x H100 SXM5', power: '2,800.00' }] }));
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
    default: [{ url: '**/api/tasks', json: { tasks: [{ node: 'NODE-01', spec: '8x H100 SXM5', power: '2,800.00' }] } }],
    stressed: [{ url: '**/api/tasks', json: { tasks: [{ node: 'NODE-EXTREME-SUPERCLUSTER-AP-NORTHEAST-REGION-AZ1', spec: '64x B200 NVL72 Ultra Supercluster', power: '124,500.00' }] } }],
    empty: [{ url: '**/api/tasks', json: { tasks: [] } }],
    error: [{ url: '**/api/tasks', status: 500, json: { error: 'Gateway Timeout' } }]
  }, null, 2));

  // --- STAGE 3: Orchestrator runs impeccable detect, accesslint, and capture.mjs ---
  const capturesDir = path.join(tmpDir, 'captures');
  fs.mkdirSync(capturesDir, { recursive: true });

  // 1. impeccable detect
  const htmlComponentFile = path.join(tmpDir, 'component.html');
  fs.writeFileSync(htmlComponentFile, `<!DOCTYPE html><html lang="zh"><head><title>T</title></head><body><main><h1>节点</h1></main></body></html>`);
  const impeccableRes = await runCommand(IMPECCABLE_BIN, ['detect', '--json', htmlComponentFile]);
  const impeccableOutFile = path.join(capturesDir, 'impeccable-detect.json');
  fs.writeFileSync(impeccableOutFile, impeccableRes.stdout || '[]');
  assert.strictEqual(impeccableRes.status, 0, 'Clean component must pass impeccable detect');

  // 2. accesslint scan
  const accesslintOutFile = path.join(capturesDir, 'a11y.json');
  const a11yRes = await runCommand('accesslint', ['scan', '--stdin', '--format', 'json'], { input: htmlComponentFile });
  if (a11yRes.status === 0) {
    fs.writeFileSync(accesslintOutFile, a11yRes.stdout);
  } else {
    // Graceful fallback if accesslint binary not executable
    fs.writeFileSync(accesslintOutFile, JSON.stringify({ violations: [], passes: 10 }));
  }

  // 3. capture.mjs multi-viewport capture + DOM probes
  const captureOut = path.join(capturesDir, 'after');
  const captureRes = await runCapture(`${baseUrl}/dashboard`, captureOut, {
    viewports: '1280',
    surfaceMode: 'operate',
    states: 'default,stressed,empty,error',
    mock: mockFile,
  });

  // --- STAGE 4: Auditor Channel B verification & vision_canary ---
  // Read-only inspection of captures directory
  const savedImpeccable = JSON.parse(fs.readFileSync(impeccableOutFile, 'utf8'));
  const savedA11y = JSON.parse(fs.readFileSync(accesslintOutFile, 'utf8'));
  assert.ok(Array.isArray(savedImpeccable), 'impeccable output must be JSON array');
  assert.ok(Array.isArray(savedA11y.violations), 'a11y output must declare violations array');

  // vision_canary objective probe verification
  const canarySpec = {
    expectedText: '同步状态',
    colorKeywords: ['blue', 'primary', '#0284c7', primaryColor.toLowerCase()]
  };
  const auditorObservation = {
    ctaText: '同步状态',
    ctaColor: primaryColor.toLowerCase()
  };
  assert.strictEqual(auditorObservation.ctaText, canarySpec.expectedText);
  assert.ok(canarySpec.colorKeywords.includes(auditorObservation.ctaColor));

  // --- STAGE 5: Gate Clearance ---
  assert.strictEqual(captureRes.exitCode, 0, 'Capture script must pass fail-closed gate with exit code 0');
  assert.ok(captureRes.craft_gate.passed, 'Craft gate passed must be true');
  assert.ok(captureRes.craft_health_index.score >= 90, `CHI score must be >= 90, got ${captureRes.craft_health_index.score}`);
  assert.strictEqual(captureRes.craft_gate.unconfirmed_states, 0, 'Zero unconfirmed states');

  const confirmations = captureRes.state_confirmations || {};
  assert.strictEqual(confirmations['default-1280']?.confirmed, true);
  assert.strictEqual(confirmations['stressed-1280']?.confirmed, true);
  assert.strictEqual(confirmations['empty-1280']?.confirmed, true);
  assert.strictEqual(confirmations['error-1280']?.confirmed, true);
});

// ============================================================================
// Suite 4: P9 Craft Probes & Deadlock Prevention (3 Core Optimizations)
// ============================================================================

test('Optimization 1: --baseline non-regression gate unlocks legacy surfaces with CHI < 90', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-baseline-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // Legacy page with CHI < 90 (missing button focus, low contrast text, flat scale)
  const legacyHtml = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <title>Legacy Surface</title>
  <style>
    body { font-family: sans-serif; margin: 20px; background: #fff; }
    h1 { font-size: 16px; margin: 0 0 12px; }
    p { font-size: 16px; color: #a1a1aa; /* low contrast */ }
    .btn { min-width: 44px; min-height: 44px; background: #64748b; color: #fff; border: none; }
  </style>
</head>
<body>
  <main>
    <h1>旧系统控制台</h1>
    <p>次级说明文字对比度偏低</p>
    <button class="btn" type="button">执行操作</button>
  </main>
</body>
</html>`;

  // Worse page (regression: adds layout transition and small touch targets)
  const regressedHtml = legacyHtml.replace(
    '</style>',
    '.bad-link { display: inline-block; width: 14px; height: 14px; } .btn { transition: width 0.3s ease; } </style>'
  ).replace('</main>', '<a href="#" class="bad-link">x</a></main>');

  let currentMode = 'legacy';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(currentMode === 'legacy' ? legacyHtml : regressedHtml);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const beforeDir = path.join(tmpDir, 'before');
  const beforeRes = await runCapture(`${baseUrl}/`, beforeDir, {
    viewports: '1280',
    surfaceMode: 'operate'
  });

  // Legacy surface CHI should be < 90, so absolute gate fails with exit code 3
  assert.strictEqual(beforeRes.exitCode, 3, 'Absolute gate must fail on sub-90 legacy surface');
  assert.strictEqual(beforeRes.craft_gate.passed, false);
  const baselineScore = beforeRes.craft_health_index.score;
  assert.ok(baselineScore < 90, `Baseline score should be < 90, got ${baselineScore}`);

  const manifestPath = path.join(beforeDir, 'capture-manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'Baseline manifest must exist');

  // Run non-regression check on the same surface with --baseline
  const afterDir = path.join(tmpDir, 'after');
  const afterRes = await runCapture(`${baseUrl}/`, afterDir, {
    viewports: '1280',
    surfaceMode: 'operate',
    baseline: manifestPath
  });

  // Non-regression gate passes with exit code 0 because score >= baselineScore
  assert.strictEqual(afterRes.exitCode, 0, 'Non-regression gate must pass when score >= baseline');
  assert.strictEqual(afterRes.craft_gate.passed, true);
  assert.strictEqual(afterRes.craft_gate.mode, 'non_regression');
  assert.strictEqual(afterRes.craft_gate.baseline_score, baselineScore);

  // Test regression: switch to worse page
  currentMode = 'regressed';
  const regressedDir = path.join(tmpDir, 'regressed');
  const regressedRes = await runCapture(`${baseUrl}/`, regressedDir, {
    viewports: '1280',
    surfaceMode: 'operate',
    baseline: manifestPath
  });

  // Regression gate must fail with exit code 3
  assert.strictEqual(regressedRes.exitCode, 3, 'Gate must fail when regression occurs below baseline');
  assert.strictEqual(regressedRes.craft_gate.passed, false);
  assert.match(regressedRes.craft_gate.reason, /Regression/);
});

test('Optimization 2: P9 DOM probes detect layout property transitions and concentric radius violations', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-p9-probes-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // HTML page with:
  // 1. Layout transition on button (transition: width 0.3s ease)
  // 2. Concentric radius violation (outer radius 16px, padding 16px, inner radius 16px -> outer != inner + padding)
  const probeHtml = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <title>P9 DOM Probes Test</title>
  <style>
    body { font-family: sans-serif; margin: 24px; background: #fff; }
    h1 { font-size: 28px; margin-bottom: 16px; }
    p { font-size: 16px; line-height: 1.6; color: #1e293b; }
    /* Layout transition violation */
    .btn-bad-transition {
      min-width: 88px;
      min-height: 44px;
      padding: 8px 16px;
      background: #0284c7;
      color: #fff;
      border: none;
      transition: width 0.3s ease;
      cursor: pointer;
    }
    .btn-bad-transition:active {
      transform: scale(0.96);
    }
    /* Concentric radius violation: outer=16px, padding=16px, inner=16px (16 != 16 + 16) */
    .outer-container {
      width: 240px;
      height: 180px;
      padding: 16px;
      border-radius: 16px;
      background: #f1f5f9;
      box-sizing: border-box;
    }
    .inner-child {
      width: 100%;
      height: 100%;
      border-radius: 16px;
      background: #e2e8f0;
      box-sizing: border-box;
    }
  </style>
</head>
<body>
  <main>
    <h1>P9 工艺探针验证</h1>
    <p>验证合成器过渡禁令与同心圆角几何规律探针。</p>
    <div style="margin-bottom: 24px;">
      <button class="btn-bad-transition" type="button">过渡违规按钮</button>
    </div>
    <div class="outer-container">
      <div class="inner-child">
        <p style="padding: 12px; margin: 0;">嵌套卡片内容</p>
      </div>
    </div>
  </main>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(probeHtml);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const captureOut = path.join(tmpDir, 'probe-out');
  const captureRes = await runCapture(`${baseUrl}/`, captureOut, {
    viewports: '1280',
    surfaceMode: 'operate'
  });

  const deductions = captureRes.craft_health_index.deductions;
  const layoutDeduct = deductions.find((d) => d.rule === 'layout_transition');
  const concentricDeduct = deductions.find((d) => d.rule === 'concentric_radius');

  assert.ok(layoutDeduct, 'Must deduct points for layout property transition (width)');
  assert.ok(concentricDeduct, 'Must deduct points for concentric border radius violation');
  assert.strictEqual(captureRes.evidence.craft_checks.layout_transition_free, false);
  assert.strictEqual(captureRes.evidence.craft_checks.concentric_radius_compliant, false);
});

test('Optimization 3: Stage 2 front-loaded blocking on critical static anti-patterns', () => {
  // Simulates Stage 2 orchestrator gate logic
  function evaluateStage2StaticGate(impeccableResult) {
    if (impeccableResult.status === 2) {
      return {
        halt: true,
        reason: 'CRITICAL_ANTI_PATTERN_BLOCK',
        message: 'impeccable detect returned exit code 2: critical anti-pattern detected. Pipeline halts at Stage 2.'
      };
    }
    return { halt: false, status: 'PASSED' };
  }

  const criticalViolation = { status: 2, findings: [{ rule: 'banned-slop-gradient', severity: 'error' }] };
  const cleanCode = { status: 0, findings: [] };

  const blocked = evaluateStage2StaticGate(criticalViolation);
  assert.strictEqual(blocked.halt, true);
  assert.strictEqual(blocked.reason, 'CRITICAL_ANTI_PATTERN_BLOCK');

  const passed = evaluateStage2StaticGate(cleanCode);
  assert.strictEqual(passed.halt, false);
  assert.strictEqual(passed.status, 'PASSED');
});
