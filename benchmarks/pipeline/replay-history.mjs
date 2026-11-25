#!/usr/bin/env node
// Historical session transcript replay + synthetic adversarial sandbox for paseo-pipeline hooks.
// Replays real Claude Code JSONL trajectories inside isolated temporary git repos/worktrees
// without touching ~/.paseo/harness-metrics.jsonl or any real repository.
//
// Usage:
//   node benchmarks/pipeline/replay-history.mjs [--days 10] [--limit 25] [--session <id>] [--json]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const HOOKS_DIR = path.join(REPO_ROOT, 'skills', 'paseo-pipeline', 'hooks');

const HOOKS = {
  session: path.join(HOOKS_DIR, 'tier-session-hook.mjs'),
  reminder: path.join(HOOKS_DIR, 'tier-reminder-hook.mjs'),
  write: path.join(HOOKS_DIR, 'tier-write-hook.mjs'),
  guard: path.join(HOOKS_DIR, 'tool-guard-hook.mjs'),
  stop: path.join(HOOKS_DIR, 'tier-stop-hook.mjs'),
};

function parseArgs(argv) {
  const opts = { days: 10, limit: 25, session: null, compare: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--days' && argv[i + 1]) opts.days = Number(argv[++i]);
    else if (a === '--limit' && argv[i + 1]) opts.limit = Number(argv[++i]);
    else if (a === '--session' && argv[i + 1]) opts.session = argv[++i];
    else if (a === '--compare' && argv[i + 1]) opts.compare = argv[++i];
    else if (a === '--json') opts.json = true;
  }
  return opts;
}

function runHook(scriptPath, payload, env) {
  const t0 = performance.now();
  const res = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
    timeout: 10_000,
  });
  const ms = performance.now() - t0;
  let parsed = null;
  const out = (res.stdout || '').trim();
  if (out) {
    try { parsed = JSON.parse(out); } catch { parsed = null; }
  }
  return { status: res.status ?? 1, ms, raw: out, parsed };
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'replay',
      GIT_AUTHOR_EMAIL: 'replay@example.com',
      GIT_COMMITTER_NAME: 'replay',
      GIT_COMMITTER_EMAIL: 'replay@example.com',
    },
  }).trim();
}

function discoverTranscripts({ days, limit, session }) {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsRoot)) return [];
  const cutoff = Date.now() - days * 86_400_000;
  const candidates = [];
  for (const dir of fs.readdirSync(projectsRoot)) {
    if (dir.startsWith('-private-tmp')) continue;
    const fullDir = path.join(projectsRoot, dir);
    let st;
    try { st = fs.statSync(fullDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const name of fs.readdirSync(fullDir)) {
      if (!name.endsWith('.jsonl')) continue;
      if (session && !name.includes(session)) continue;
      const fullPath = path.join(fullDir, name);
      try {
        const fst = fs.statSync(fullPath);
        if (!session && fst.mtimeMs < cutoff) continue;
        if (fst.size < 2048) continue;
        candidates.push({ path: fullPath, size: fst.size, mtimeMs: fst.mtimeMs, id: name.replace(/\.jsonl$/, '') });
      } catch {}
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.slice(0, limit);
}

function extractEvents(jsonlPath) {
  const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
  const events = [];
  let repoRootGuess = null;
  const worktrees = new Set();

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const cwd = typeof obj.cwd === 'string' ? obj.cwd : null;
    if (cwd) {
      const wtIdx = cwd.indexOf('/.claude/worktrees/');
      if (wtIdx !== -1) {
        repoRootGuess = repoRootGuess || cwd.slice(0, wtIdx);
        worktrees.add(cwd.slice(wtIdx + '/.claude/worktrees/'.length).split('/')[0]);
      } else if (!repoRootGuess && !cwd.startsWith('/tmp') && !cwd.startsWith('/private/tmp')) {
        repoRootGuess = cwd;
      }
    }

    if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
      events.push({ kind: 'compact', cwd });
      continue;
    }

    if (obj.type === 'user' && !obj.isMeta) {
      const content = obj.message?.content;
      let text = '';
      let isToolResult = false;
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        if (content.every((c) => c.type === 'tool_result')) isToolResult = true;
        text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      }
      if (!isToolResult && text.trim()) {
        events.push({ kind: 'user', prompt: text.trim().slice(0, 600), cwd });
      }
      continue;
    }

    if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
      for (const item of obj.message.content) {
        if (item.type !== 'tool_use') continue;
        const name = item.name;
        const input = item.input || {};
        if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) {
          const fp = input.file_path || input.notebook_path;
          if (typeof fp === 'string' && fp) {
            events.push({ kind: 'write', toolName: name, filePath: fp, cwd });
          }
        } else if (name === 'Bash' || name === 'Agent' || name.startsWith('mcp__paseo__')) {
          events.push({ kind: 'guard', toolName: name, input, cwd });
        }
      }
    }
  }

  return { events, repoRootGuess, worktrees: [...worktrees] };
}

const PROFILE_SAFE_FIELDS = ['id', 'name', 'provider', 'model', 'modeId', 'thinkingOptionId', 'features', 'featureValues', 'notes'];
function loadSanitizedAgentProfiles() {
  const cfgPath = path.join(process.env.PASEO_HOME || path.join(os.homedir(), '.paseo'), 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const list = raw?.daemon?.agentProfiles;
    if (!Array.isArray(list)) return [];
    return list
      .filter((p) => p && typeof p === 'object' && !Array.isArray(p))
      .map((p) => {
        const clean = {};
        for (const k of PROFILE_SAFE_FIELDS) {
          if (p[k] !== undefined) clean[k] = p[k];
        }
        return clean;
      });
  } catch {
    return [];
  }
}
const SANITIZED_PROFILES = loadSanitizedAgentProfiles();

function mapPathToSandbox(origPath, origRepoRoot, primarySandbox, worktreeMap, outsideDir) {
  if (!origPath || typeof origPath !== 'string') return primarySandbox;
  if (origRepoRoot && origPath.startsWith(origRepoRoot)) {
    const rest = origPath.slice(origRepoRoot.length);
    if (rest.startsWith('/.claude/worktrees/')) {
      const after = rest.slice('/.claude/worktrees/'.length);
      const slash = after.indexOf('/');
      const wtName = slash === -1 ? after : after.slice(0, slash);
      const sub = slash === -1 ? '' : after.slice(slash + 1);
      const wtRoot = worktreeMap.get(wtName);
      if (wtRoot) return sub ? path.join(wtRoot, sub) : wtRoot;
    }
    const cleanRest = rest.replace(/^\/+/, '');
    return cleanRest ? path.join(primarySandbox, cleanRest) : primarySandbox;
  }
  return path.join(outsideDir, path.basename(origPath));
}

function replayTranscript(candidate) {
  const { events, repoRootGuess, worktrees } = extractEvents(candidate.path);
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-replay-'));
  const primary = path.join(tmpBase, 'repo');
  const outsideDir = path.join(tmpBase, 'outside');
  const stateDir = path.join(tmpBase, 'state');
  const telFile = path.join(tmpBase, 'metrics.jsonl');
  const paseoHome = path.join(tmpBase, 'paseo-home');
  fs.mkdirSync(path.join(primary, 'src'), { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(paseoHome, { recursive: true });
  if (SANITIZED_PROFILES.length > 0) {
    fs.writeFileSync(path.join(paseoHome, 'config.json'), JSON.stringify({ daemon: { agentProfiles: SANITIZED_PROFILES } }));
  }
  fs.writeFileSync(path.join(primary, 'src', 'seed.ts'), 'export const seed = 1;\n');
  git(primary, 'init', '-q', '-b', 'main');
  git(primary, 'add', '.');
  git(primary, 'commit', '-qm', 'seed');

  const worktreeMap = new Map();
  for (const wtName of worktrees) {
    const wtDir = path.join(tmpBase, `wt-${wtName}`);
    try {
      git(primary, 'worktree', 'add', '-q', '-b', `wt/${wtName}`, wtDir);
      worktreeMap.set(wtName, wtDir);
    } catch {}
  }

  const env = {
    ...process.env,
    PIPELINE_TIER_GATE_STATE: stateDir,
    PIPELINE_TELEMETRY_FILE: telFile,
    PASEO_HOME: paseoHome,
    PIPELINE_TIER_GATE: 'on',
  };
  delete env.NODE_TEST_CONTEXT;

  const sid = `replay-${candidate.id.slice(0, 12)}`;
  const stats = {
    id: candidate.id,
    events: events.length,
    compacts: 0,
    prompts: 0,
    writes: 0,
    guards: 0,
    stops: 0,
    outcomes: { ask: 0, deny: 0, block: 0, rewrite: 0, advise: 0, inject: 0 },
    reasons: {},
    latenciesMs: { session: [], reminder: [], write: [], guard: [], stop: [] },
  };
  const bumpReason = (code) => {
    if (!code) return;
    stats.reasons[code] = (stats.reasons[code] || 0) + 1;
  };

  let turnOpen = false;
  let lastCwd = primary;

  try {
    for (const ev of events) {
      const mappedCwd = mapPathToSandbox(ev.cwd, repoRootGuess, primary, worktreeMap, outsideDir);
      const cwd = fs.existsSync(mappedCwd) ? mappedCwd : primary;
      lastCwd = cwd;

      if (ev.kind === 'compact') {
        stats.compacts += 1;
        const r = runHook(HOOKS.session, { source: 'compact', cwd, session_id: sid }, env);
        stats.latenciesMs.session.push(r.ms);
        if (r.parsed?.hookSpecificOutput?.additionalContext) stats.outcomes.inject += 1;
      } else if (ev.kind === 'user') {
        if (turnOpen) {
          stats.stops += 1;
          const sr = runHook(HOOKS.stop, { cwd: lastCwd, session_id: sid }, env);
          stats.latenciesMs.stop.push(sr.ms);
          if (sr.parsed?.decision === 'block') stats.outcomes.block += 1;
        }
        turnOpen = true;
        stats.prompts += 1;
        const rr = runHook(HOOKS.reminder, { prompt: ev.prompt, cwd, session_id: sid }, env);
        stats.latenciesMs.reminder.push(rr.ms);
        if (rr.parsed?.hookSpecificOutput?.additionalContext) stats.outcomes.inject += 1;
      } else if (ev.kind === 'write') {
        stats.writes += 1;
        const target = mapPathToSandbox(ev.filePath, repoRootGuess, primary, worktreeMap, outsideDir);
        const wr = runHook(HOOKS.write, {
          tool_name: ev.toolName,
          tool_input: { file_path: target },
          cwd,
          session_id: sid,
        }, env);
        stats.latenciesMs.write.push(wr.ms);
        const dec = wr.parsed?.hookSpecificOutput?.permissionDecision;
        if (dec === 'ask') stats.outcomes.ask += 1;
        else if (dec === 'deny') stats.outcomes.deny += 1;
        if (dec !== 'deny') {
          try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.appendFileSync(target, `// replay ${Date.now()}\n`);
          } catch {}
        }
      } else if (ev.kind === 'guard') {
        stats.guards += 1;
        const gr = runHook(HOOKS.guard, {
          tool_name: ev.toolName,
          tool_input: ev.input,
          cwd,
          session_id: sid,
        }, env);
        stats.latenciesMs.guard.push(gr.ms);
        const hso = gr.parsed?.hookSpecificOutput;
        if (hso?.permissionDecision === 'deny') stats.outcomes.deny += 1;
        else if (hso?.permissionDecision === 'allow' && hso?.updatedInput) stats.outcomes.rewrite += 1;
        if (hso?.additionalContext) stats.outcomes.advise += 1;
      }
    }

    if (turnOpen) {
      stats.stops += 1;
      const sr = runHook(HOOKS.stop, { cwd: lastCwd, session_id: sid }, env);
      stats.latenciesMs.stop.push(sr.ms);
      if (sr.parsed?.decision === 'block') stats.outcomes.block += 1;
    }

    if (fs.existsSync(telFile)) {
      for (const line of fs.readFileSync(telFile, 'utf8').split('\n').filter(Boolean)) {
        try {
          const entry = JSON.parse(line);
          if (entry.reasonCode) bumpReason(entry.reasonCode);
        } catch {}
      }
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
  return stats;
}

function runSyntheticAdversarialSuite() {
  const results = [];
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-replay-adv-'));
  const repo = path.join(tmpBase, 'repo');
  const stateDir = path.join(tmpBase, 'state');
  const telFile = path.join(tmpBase, 'metrics.jsonl');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'seed');
  const wt = path.join(tmpBase, 'wt-adv');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/adv', wt);

  const env = { ...process.env, PIPELINE_TIER_GATE_STATE: stateDir, PIPELINE_TELEMETRY_FILE: telFile };
  delete env.NODE_TEST_CONTEXT;

  try {
    // 1. Bash 4-file bypass caught by Stop
    const sid1 = 'adv-bash4';
    runHook(HOOKS.reminder, { prompt: 'fix a', cwd: repo, session_id: sid1 }, env);
    for (const f of ['b.ts', 'c.ts', 'd.ts', 'e.ts']) fs.writeFileSync(path.join(repo, 'src', f), 'export const x = 1;\n');
    const r1 = runHook(HOOKS.stop, { cwd: repo, session_id: sid1 }, env);
    results.push({ name: 'bash_4files_stop_block', pass: r1.parsed?.decision === 'block' });
    git(repo, 'clean', '-fdq');

    // 2. Heavy worktree (>=2 compactions) source write -> ask
    const sid2 = 'adv-heavy-wt';
    runHook(HOOKS.session, { source: 'compact', cwd: wt, session_id: sid2 }, env);
    runHook(HOOKS.session, { source: 'compact', cwd: wt, session_id: sid2 }, env);
    const r2 = runHook(HOOKS.write, { tool_name: 'Edit', tool_input: { file_path: path.join(wt, 'src', 'a.ts') }, cwd: wt, session_id: sid2 }, env);
    results.push({ name: 'heavy_worktree_compact2_ask', pass: r2.parsed?.hookSpecificOutput?.permissionDecision === 'ask' });

    // 3. Worktree create_agent without workspaceId -> deny
    const r3 = runHook(HOOKS.guard, { tool_name: 'mcp__paseo__create_agent', cwd: wt, tool_input: { provider: 'claude/flash', title: '[Handoff] x', initialPrompt: 'p' }, session_id: sid2 }, env);
    results.push({ name: 'worktree_create_agent_missing_ws_deny', pass: r3.parsed?.hookSpecificOutput?.permissionDecision === 'deny' });

    // 4. Built-in Agent independent review -> deny
    const r4 = runHook(HOOKS.guard, { tool_name: 'Agent', cwd: wt, tool_input: { description: 'Tier 2 independent code review', prompt: 'Review and return PASS or BLOCKED' }, session_id: sid2 }, env);
    results.push({ name: 'builtin_agent_review_deny', pass: r4.parsed?.hookSpecificOutput?.permissionDecision === 'deny' });

    // 5. Tier 0 Q&A prompt -> zero injection
    const sid5 = 'adv-tier0';
    const r5 = runHook(HOOKS.reminder, { prompt: '为什么这个接口返回 404？', cwd: repo, session_id: sid5 }, env);
    results.push({ name: 'tier0_qa_zero_inject', pass: !r5.parsed?.hookSpecificOutput?.additionalContext });
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
  return results;
}

function summarizeLatencies(arr) {
  if (!arr.length) return { count: 0, avgMs: 0, p95Ms: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return { count: sorted.length, avgMs: Number((sum / sorted.length).toFixed(1)), p95Ms: Number(p95.toFixed(1)) };
}

function runReplayProcess(workDir, scriptPath, extraArgs) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [scriptPath, ...extraArgs], {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`replay child exited ${code}: ${stderr || stdout}`));
        return;
      }
      resolve({ wallMs: Math.round(performance.now() - t0), ...JSON.parse(stdout) });
    });
  });
}

async function runCompare(opts) {
  const selfScript = fileURLToPath(import.meta.url);
  const tmpWt = path.join(os.tmpdir(), `paseo-replay-cmp-${process.pid}-${Date.now()}`);
  const forwardArgs = ['--days', String(opts.days), '--limit', String(opts.limit), ...(opts.session ? ['--session', opts.session] : []), '--json'];
  let baseline;
  let current;
  try {
    git(REPO_ROOT, 'worktree', 'add', '--detach', '-q', tmpWt, opts.compare);
    const tmpScript = path.join(tmpWt, 'benchmarks', 'pipeline', 'replay-history.mjs');
    fs.mkdirSync(path.dirname(tmpScript), { recursive: true });
    fs.copyFileSync(selfScript, tmpScript);
    [baseline, current] = await Promise.all([
      runReplayProcess(tmpWt, tmpScript, forwardArgs),
      runReplayProcess(REPO_ROOT, selfScript, forwardArgs),
    ]);
  } finally {
    try { execFileSync('git', ['-C', REPO_ROOT, 'worktree', 'remove', '--force', tmpWt], { stdio: 'ignore' }); } catch {}
    try { fs.rmSync(tmpWt, { recursive: true, force: true }); } catch {}
  }

  const result = { baseRef: opts.compare, baseline, current };
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const b = baseline;
  const c = current;
  console.log(`Historical Replay A/B (${opts.compare} vs WORKTREE, ${c.replayedSessions} sessions, ${c.totals.events} events)`);
  console.log(`  wallClock:  ${(b.wallMs / 1000).toFixed(1)}s -> ${(c.wallMs / 1000).toFixed(1)}s`);
  console.log(`  outcomes:   inject ${b.totals.inject}->${c.totals.inject}, ask ${b.totals.ask}->${c.totals.ask}, deny ${b.totals.deny}->${c.totals.deny}, block ${b.totals.block}->${c.totals.block}, rewrite ${b.totals.rewrite}->${c.totals.rewrite}, advise ${b.totals.advise}->${c.totals.advise}`);
  console.log('  latencies (avg ms):');
  for (const k of Object.keys(c.latencies)) {
    console.log(`    ${k.padEnd(9)} ${b.latencies[k].avgMs}ms -> ${c.latencies[k].avgMs}ms`);
  }
  const fmtReasons = (r) => Object.entries(r).sort((a, d) => d[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', ') || 'none';
  console.log(`  base reasons: ${fmtReasons(b.reasonTotals)}`);
  console.log(`  curr reasons: ${fmtReasons(c.reasonTotals)}`);
  console.log(`  adversarial:  ${b.adversarial.filter((x) => x.pass).length}/${b.adversarial.length} -> ${c.adversarial.filter((x) => x.pass).length}/${c.adversarial.length}`);
}

const opts = parseArgs(process.argv.slice(2));
if (opts.compare) {
  await runCompare(opts);
} else {
  const candidates = discoverTranscripts(opts);
  const sessions = [];
  const allLatencies = { session: [], reminder: [], write: [], guard: [], stop: [] };
  const totals = { events: 0, compacts: 0, prompts: 0, writes: 0, guards: 0, stops: 0, ask: 0, deny: 0, block: 0, rewrite: 0, advise: 0, inject: 0 };
  const reasonTotals = {};

  for (const c of candidates) {
    const s = replayTranscript(c);
    sessions.push({
      id: s.id,
      events: s.events,
      compacts: s.compacts,
      prompts: s.prompts,
      writes: s.writes,
      guards: s.guards,
      outcomes: s.outcomes,
      reasons: s.reasons,
    });
    totals.events += s.events;
    totals.compacts += s.compacts;
    totals.prompts += s.prompts;
    totals.writes += s.writes;
    totals.guards += s.guards;
    totals.stops += s.stops;
    for (const k of ['ask', 'deny', 'block', 'rewrite', 'advise', 'inject']) totals[k] += s.outcomes[k];
    for (const [code, cnt] of Object.entries(s.reasons)) reasonTotals[code] = (reasonTotals[code] || 0) + cnt;
    for (const k of Object.keys(allLatencies)) allLatencies[k].push(...s.latenciesMs[k]);
  }

  const adversarial = runSyntheticAdversarialSuite();
  const summary = {
    replayedSessions: sessions.length,
    totals,
    reasonTotals,
    latencies: Object.fromEntries(Object.entries(allLatencies).map(([k, v]) => [k, summarizeLatencies(v)])),
    adversarial,
    adversarialPassed: adversarial.every((a) => a.pass),
    sessions,
  };

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Historical Replay Summary (${summary.replayedSessions} sessions, ${totals.events} events)`);
    console.log(`  actions: prompts=${totals.prompts} writes=${totals.writes} guards=${totals.guards} compacts=${totals.compacts} stops=${totals.stops}`);
    console.log(`  outcomes: inject=${totals.inject} ask=${totals.ask} deny=${totals.deny} block=${totals.block} rewrite=${totals.rewrite} advise=${totals.advise}`);
    console.log(`  reasons: ${Object.entries(reasonTotals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
    console.log('  latencies:');
    for (const [k, l] of Object.entries(summary.latencies)) {
      console.log(`    ${k.padEnd(9)} count=${String(l.count).padStart(4)} avg=${l.avgMs}ms p95=${l.p95Ms}ms`);
    }
    console.log(`  adversarial (${adversarial.filter((a) => a.pass).length}/${adversarial.length} PASS):`);
    for (const a of adversarial) console.log(`    ${a.pass ? 'PASS' : 'FAIL'} ${a.name}`);
  }
}
