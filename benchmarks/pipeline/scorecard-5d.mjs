#!/usr/bin/env node
// Lightweight, read-only 5-dimension task evaluation scorecard (ADR-0005 complement).
// Collects deterministic facts from git history, OpenSpec artifacts, harness-metrics.jsonl,
// Paseo agent metadata, and Claude session transcripts; never modifies repo or rules,
// and reports NOT_COLLECTED rather than estimating missing signals.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.resolve(here, '../../skills/paseo-pipeline/lib');
const { parseOptions } = await import(path.join(libDir, 'cli.mjs'));
const { runGit, gitMaybe } = await import(path.join(libDir, 'git.mjs'));
const { paseoHome } = await import(path.join(libDir, 'paseo.mjs'));
const { isTestPath, isDocPath, NON_SUBSTANTIVE_SCOPE } = await import(path.join(libDir, 'paths.mjs'));
const { parseTasks } = await import(path.join(libDir, 'tasks.mjs'));
const { loadSpecTree, analyzeSpecTree } = await import(path.join(libDir, 'spec-scan.mjs'));
const { scanRepo } = await import(path.join(libDir, 'risk-scan.mjs'));
const { weightedSpeedup, LIVE_MODEL } = await import(path.join(libDir, 'schedule.mjs'));
const { telemetryFile } = await import(path.join(libDir, 'telemetry.mjs'));

const NOT_COLLECTED = 'NOT_COLLECTED';

const USAGE = `Usage:
  node benchmarks/pipeline/scorecard-5d.mjs [options]
  node benchmarks/pipeline/scorecard-5d.mjs --compare <report1.json> <report2.json>... [--json | --markdown] [--out <file>]

Options:
  --repo <dir>                  Repository root (default: .)
  --base <ref>                  Base git ref/SHA (default: merge-base with HEAD or HEAD~1)
  --head <ref>                  Head git ref/SHA (default: HEAD)
  --change <name>               OpenSpec change name (active or archived)
  --change-dir <dir>            Explicit OpenSpec change directory
  --since <iso>                 Start timestamp (ISO-8601) for telemetry/agent matching
  --until <iso>                 End timestamp (ISO-8601) for telemetry/agent matching
  --transcript <path>           Explicit Claude session JSONL transcript (repeatable)
  --metrics-file <path>         Override harness-metrics.jsonl path
  --paseo-home <dir>            Override ~/.paseo directory
  --claude-projects <dir>       Override ~/.claude/projects directory
  --tier-initial <1|2|3>        Initial routed tier (optional manual input)
  --tier-final <1|2|3>          Final executed tier (optional manual input)
  --human-interventions <n>     Count of manual stops/corrections (optional)
  --post-merge-fixes <n>        Count of post-merge follow-up fixes (optional)
  --mutations-caught <k/m>      Optional mutation probe result (e.g. 4/5)
  --notes <text>                Optional reviewer notes
  --compare                     Compare multiple --json scorecard outputs passed positionally
  --json                        Emit JSON report
  --markdown                    Emit Markdown scorecard
  --out <file>                  Write output to file instead of stdout
  --help                        Show this help`;

const OPTION_SCHEMA = {
  repo: 'value',
  base: 'value',
  head: 'value',
  change: 'value',
  'change-dir': 'value',
  since: 'value',
  until: 'value',
  transcript: 'repeat',
  'metrics-file': 'value',
  'paseo-home': 'value',
  'claude-projects': 'value',
  'tier-initial': 'value',
  'tier-final': 'value',
  'human-interventions': 'value',
  'post-merge-fixes': 'value',
  'mutations-caught': 'value',
  notes: 'value',
  compare: 'boolean',
  json: 'boolean',
  markdown: 'boolean',
  out: 'value',
  help: 'boolean',
};

function parseTimestamp(value, flag) {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`invalid timestamp for ${flag}: ${value}`);
  return ms;
}

function parseOptionalInt(value, flag) {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`invalid non-negative integer for ${flag}: ${value}`);
  return parsed;
}

function parseOptionalTier(value, flag) {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  if (![1, 2, 3].includes(parsed)) throw new Error(`invalid tier (1|2|3) for ${flag}: ${value}`);
  return parsed;
}

function parseMutationProbe(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!match) throw new Error(`invalid --mutations-caught format (expected K/M): ${value}`);
  const caught = Number(match[1]);
  const total = Number(match[2]);
  if (total <= 0 || caught > total) throw new Error(`invalid --mutations-caught values: ${value}`);
  return { caught, total, ratePct: Number(((caught / total) * 100).toFixed(1)) };
}

function resolveChangeDir(repoRoot, changeName, explicitDir) {
  if (explicitDir) {
    const resolved = path.resolve(repoRoot, explicitDir);
    return fs.existsSync(resolved) ? resolved : null;
  }
  if (!changeName) return null;
  const active = path.join(repoRoot, 'openspec', 'changes', changeName);
  if (fs.existsSync(active)) return active;
  const archiveDir = path.join(repoRoot, 'openspec', 'changes', 'archive');
  if (fs.existsSync(archiveDir)) {
    try {
      const entries = fs.readdirSync(archiveDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && (e.name === changeName || e.name.endsWith(`-${changeName}`)))
        .map((e) => path.join(archiveDir, e.name));
      if (entries.length) return entries.sort().at(-1);
    } catch {}
  }
  return null;
}

function resolveBaseRef(repoRoot, requestedBase, headRef) {
  if (requestedBase) return requestedBase;
  for (const candidate of ['main', 'master']) {
    const mb = gitMaybe(repoRoot, ['merge-base', candidate, headRef]);
    if (mb) return mb;
  }
  const parent = gitMaybe(repoRoot, ['rev-parse', '--verify', `${headRef}~1`]);
  return parent || headRef;
}

function parseNumstat(raw) {
  const rows = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? 0 : Number.parseInt(parts[0], 10) || 0;
    const deleted = parts[1] === '-' ? 0 : Number.parseInt(parts[1], 10) || 0;
    const file = parts.slice(2).join('\t').replace(/\\/g, '/');
    rows.push({ file, added, deleted });
  }
  return rows;
}

function classifyChangedFiles(numstatRows) {
  const buckets = {
    source: { files: 0, added: 0, deleted: 0, list: [] },
    test: { files: 0, added: 0, deleted: 0, list: [] },
    docsAndSpec: { files: 0, added: 0, deleted: 0, list: [] },
  };
  for (const row of numstatRows) {
    let target = buckets.source;
    if (isTestPath(row.file)) target = buckets.test;
    else if (isDocPath(row.file) || NON_SUBSTANTIVE_SCOPE.test(row.file)) target = buckets.docsAndSpec;
    target.files += 1;
    target.added += row.added;
    target.deleted += row.deleted;
    target.list.push(row.file);
  }
  return buckets;
}

function parseCommits(repoRoot, baseSha, headSha) {
  const format = '%H%x1f%ct%x1f%s%x1f%(trailers:key=Pipeline-Role,valueonly)%x1f%(trailers:key=Pipeline-Author,valueonly)%x1e';
  const res = runGit(repoRoot, ['log', '--reverse', `--format=${format}`, `${baseSha}..${headSha}`]);
  if (res.status !== 0) return [];
  const commits = [];
  for (const rec of res.stdout.split('\x1e')) {
    if (!rec.trim()) continue;
    const [sha, tsRaw, subject, roleRaw, authorRaw] = rec.split('\x1f');
    const tsSec = Number.parseInt(tsRaw, 10);
    commits.push({
      sha: (sha || '').trim(),
      tsMs: Number.isFinite(tsSec) ? tsSec * 1000 : null,
      subject: (subject || '').trim(),
      pipelineRole: (roleRaw || '').trim() || null,
      pipelineAuthor: (authorRaw || '').trim() || null,
    });
  }
  return commits;
}

function collectGitFacts({ repoRoot, base, head }) {
  const headSha = gitMaybe(repoRoot, ['rev-parse', '--verify', `${head}^{commit}`]);
  const baseSha = gitMaybe(repoRoot, ['rev-parse', '--verify', `${base}^{commit}`]);
  if (!headSha || !baseSha) {
    throw new Error(`cannot resolve git refs (base=${base}, head=${head}) in ${repoRoot}`);
  }
  const mb = gitMaybe(repoRoot, ['merge-base', baseSha, headSha]) || baseSha;
  const numstatRes = runGit(repoRoot, ['diff', '--numstat', `${mb}..${headSha}`]);
  const rows = numstatRes.status === 0 ? parseNumstat(numstatRes.stdout) : [];
  const files = classifyChangedFiles(rows);
  const commits = parseCommits(repoRoot, mb, headSha);
  const commitTimes = commits.map((c) => c.tsMs).filter((t) => typeof t === 'number');
  const firstCommitMs = commitTimes.length ? Math.min(...commitTimes) : null;
  const lastCommitMs = commitTimes.length ? Math.max(...commitTimes) : null;
  const roles = {};
  for (const c of commits) {
    const key = c.pipelineRole || 'unlabelled';
    roles[key] = (roles[key] || 0) + 1;
  }

  let risk = null;
  try {
    risk = scanRepo({ cwd: repoRoot, base: mb, head: headSha, workingTree: false });
  } catch {
    risk = null;
  }

  return {
    repoRoot,
    baseSha,
    mergeBaseSha: mb,
    headSha,
    files,
    commits: {
      count: commits.length,
      roles,
      firstCommitIso: firstCommitMs ? new Date(firstCommitMs).toISOString() : null,
      lastCommitIso: lastCommitMs ? new Date(lastCommitMs).toISOString() : null,
      spanMinutes: firstCommitMs && lastCommitMs ? Number(((lastCommitMs - firstCommitMs) / 60_000).toFixed(1)) : null,
    },
    risk: risk ? {
      reviewRequired: risk.reviewRequired,
      tierRequired: risk.tierRequired,
      classes: risk.classes,
      sourceFileCount: risk.sourceFiles.length,
      scopeCount: risk.scopes.length,
      scopes: risk.scopes,
      testMutationCount: risk.testMutations.length,
      caveatRemovalCount: risk.caveatRemovals.length,
    } : null,
    firstCommitMs,
    lastCommitMs,
  };
}

function collectOpenSpecFacts(repoRoot, changeDir) {
  if (!changeDir) return null;
  const tasksPath = path.join(changeDir, 'tasks.md');
  const reviewPath = path.join(changeDir, 'review.md');
  let taskStats = null;
  let speedup = null;
  if (fs.existsSync(tasksPath)) {
    const parsed = parseTasks(fs.readFileSync(tasksPath, 'utf8'));
    const substantive = parsed.tasks.filter((t) => (t.scope || []).some((s) => !NON_SUBSTANTIVE_SCOPE.test(s)));
    speedup = substantive.length ? weightedSpeedup(substantive, LIVE_MODEL) : null;
    taskStats = {
      total: parsed.tasks.length,
      substantive: substantive.length,
      checked: parsed.tasks.filter((t) => t.checked).length,
      parseErrors: parsed.errors.length,
      weightedSpeedup: speedup,
    };
  }

  let scenarioCount = null;
  try {
    const specTree = loadSpecTree({ repoRoot, changeDir });
    const analysis = analyzeSpecTree({ specTree, changeDir, repoRoot });
    scenarioCount = analysis.declared.size;
  } catch {
    scenarioCount = null;
  }

  let reviewStats = null;
  if (fs.existsSync(reviewPath)) {
    const raw = fs.readFileSync(reviewPath, 'utf8');
    const r0Matches = raw.match(/\bR0:\s*(?:pass|human-accept|blocked)\b/gi) || [];
    const finalMatches = raw.match(/\bFINAL:\s*(?:pass|human-accept|blocked)\b/gi) || [];
    const deviations = (raw.match(/\bDEVIATION\b/g) || []).length;
    const contractGaps = (raw.match(/\bCONTRACT_GAP\b/g) || []).length;
    reviewStats = {
      r0Markers: r0Matches.length,
      finalMarkers: finalMatches.length,
      deviations,
      contractGaps,
    };
  }

  return {
    changeDir,
    changeName: path.basename(changeDir),
    tasks: taskStats,
    scenarioCount,
    review: reviewStats,
  };
}

function collectTelemetryFacts({ file, sinceMs, untilMs }) {
  if (sinceMs === null || untilMs === null || !file || !fs.existsSync(file)) {
    return null;
  }
  const counts = {
    totalEvents: 0,
    toolGuard: { rewrite: 0, deny: 0, advise: 0, sanitizePaseo: 0, sanitizeWorkspace: 0, worktreeCdPrimary: 0, reconStall: 0, worktreeReadStall: 0 },
    tierWrite: { ask: 0, deny: 0, fileLimit: 0, scopeCross: 0 },
    tierStop: { block: 0 },
    tier2Verify: { total: 0, pass: 0, reviewRequired: 0, fail: 0, unprovableRejections: 0, failByReason: {} },
    workerCheck: { total: 0, pass: 0, fail: 0 },
    freezeCheck: { total: 0, pipeline: 0, handoff: 0, failed: 0 },
    mergeTask: { total: 0, pass: 0, fail: 0 },
    cp2Merge: { total: 0, pass: 0, fail: 0 },
    reviews: { total: 0, pass: 0, blocked: 0, incomplete: 0, humanAccept: 0 },
    authorGuard: { warn: 0, stop: 0, compactEmptySpecs: 0, repeatRead: 0 },
  };
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry?.ts !== 'number' || entry.ts < sinceMs || entry.ts > untilMs) continue;
    counts.totalEvents += 1;
    const ev = entry.event;
    const code = entry.reasonCode || 'unknown';
    if (ev === 'tool_guard') {
      if (Object.hasOwn(counts.toolGuard, entry.action)) counts.toolGuard[entry.action] += 1;
      if (code === 'sanitize_paseo') counts.toolGuard.sanitizePaseo += 1;
      else if (code === 'sanitize_workspace') counts.toolGuard.sanitizeWorkspace += 1;
      else if (code === 'worktree_cd_primary') counts.toolGuard.worktreeCdPrimary += 1;
      else if (code === 'recon_stall') counts.toolGuard.reconStall += 1;
      else if (code === 'worktree_read_stall') counts.toolGuard.worktreeReadStall += 1;
    } else if (ev === 'tier_write') {
      if (Object.hasOwn(counts.tierWrite, entry.action)) counts.tierWrite[entry.action] += 1;
      if (code === 'file_limit') counts.tierWrite.fileLimit += 1;
      else if (code === 'scope_cross') counts.tierWrite.scopeCross += 1;
    } else if (ev === 'tier_stop' && entry.verdict === 'block') {
      counts.tierStop.block += 1;
    } else if (ev === 'tier2_verify') {
      counts.tier2Verify.total += 1;
      if (entry.verdict === 'PASS') counts.tier2Verify.pass += 1;
      else if (entry.verdict === 'REVIEW_REQUIRED') counts.tier2Verify.reviewRequired += 1;
      else if (entry.verdict === 'FAIL') {
        counts.tier2Verify.fail += 1;
        counts.tier2Verify.failByReason[code] = (counts.tier2Verify.failByReason[code] || 0) + 1;
      }
      if (typeof entry.unprovableCount === 'number') counts.tier2Verify.unprovableRejections += entry.unprovableCount;
    } else if (ev === 'worker_check') {
      counts.workerCheck.total += 1;
      if (entry.ok === true) counts.workerCheck.pass += 1;
      else counts.workerCheck.fail += 1;
    } else if (ev === 'freeze_check') {
      counts.freezeCheck.total += 1;
      if (entry.verdict === 'pipeline') counts.freezeCheck.pipeline += 1;
      else if (entry.verdict === 'handoff') counts.freezeCheck.handoff += 1;
      if (entry.ok === false) counts.freezeCheck.failed += 1;
    } else if (ev === 'merge_task') {
      counts.mergeTask.total += 1;
      if (entry.ok === true) counts.mergeTask.pass += 1;
      else counts.mergeTask.fail += 1;
    } else if (ev === 'cp2_merge') {
      counts.cp2Merge.total += 1;
      if (entry.ok === true) counts.cp2Merge.pass += 1;
      else counts.cp2Merge.fail += 1;
    } else if (ev === 'review_verdict') {
      counts.reviews.total += 1;
      if (entry.verdict === 'pass') counts.reviews.pass += 1;
      else if (entry.verdict === 'blocked') counts.reviews.blocked += 1;
      else if (entry.verdict === 'incomplete') counts.reviews.incomplete += 1;
      else if (entry.verdict === 'human_accept') counts.reviews.humanAccept += 1;
    } else if (ev === 'author_guard') {
      if (code === 'author_thrash_warn') counts.authorGuard.warn += 1;
      else if (code === 'author_thrash_stop') counts.authorGuard.stop += 1;
      else if (code === 'author_compact_empty_specs') counts.authorGuard.compactEmptySpecs += 1;
      else if (code === 'author_repeat_read') counts.authorGuard.repeatRead += 1;
    }
  }
  const proceduralVerifyFails = (counts.tier2Verify.failByReason.dirty_worktree || 0)
    + (counts.tier2Verify.failByReason.not_worktree || 0);
  const frictionTotal = counts.toolGuard.rewrite
    + counts.toolGuard.deny
    + counts.tierWrite.ask
    + counts.tierWrite.deny
    + counts.tierStop.block
    + proceduralVerifyFails;
  return { ...counts, proceduralVerifyFails, frictionTotal };
}

function findTranscriptFile(claudeProjectsDir, sessionId) {
  if (!sessionId || !claudeProjectsDir || !fs.existsSync(claudeProjectsDir)) return null;
  const targetName = `${sessionId}.jsonl`;
  try {
    for (const proj of fs.readdirSync(claudeProjectsDir, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const candidate = path.join(claudeProjectsDir, proj.name, targetName);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
}

function parseTranscript(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  const stats = {
    file: filePath,
    assistantTurns: 0,
    toolCalls: 0,
    compactions: 0,
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    thinkingChars: 0,
    apiWaitMs: 0,
    compactionMs: 0,
    toolWaitMs: 0,
    bashWaitMs: 0,
    slowBashCalls: 0,
    bashOnlyTurns: 0,
    bashOnlyApiWaitMs: 0,
    maxRepeatFileReads: 0,
    repeatedFilesCount: 0,
    userInterrupts: 0,
    silentToolStreaks: 0,
    maxApiWaitMs: 0,
    longSilentWaits: 0,
    firstTsMs: null,
    lastTsMs: null,
  };
  const seenMessageIds = new Set();
  const turnMap = new Map();
  const toolStartById = new Map();
  const fileReads = new Map();
  let lastApiReqMs = null;
  let anonSeq = 0;
  let inHumanTurn = false;
  let curHumanTools = 0;
  let curHumanTextChars = 0;
  const flushHumanTurn = () => {
    if (inHumanTurn && curHumanTools >= 10 && curHumanTextChars === 0) {
      stats.silentToolStreaks += 1;
    }
    inHumanTurn = false;
    curHumanTools = 0;
    curHumanTextChars = 0;
  };

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    let ms = null;
    if (typeof obj.timestamp === 'string') {
      const parsedMs = Date.parse(obj.timestamp);
      if (Number.isFinite(parsedMs)) {
        ms = parsedMs;
        stats.firstTsMs = stats.firstTsMs === null ? ms : Math.min(stats.firstTsMs, ms);
        stats.lastTsMs = stats.lastTsMs === null ? ms : Math.max(stats.lastTsMs, ms);
      }
    }
    if (obj.type === 'api-request') {
      if (ms !== null) lastApiReqMs = ms;
      continue;
    }
    if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
      stats.compactions += 1;
      stats.compactionMs += Number(obj.compactMetadata?.durationMs) || 0;
      lastApiReqMs = null;
      continue;
    }
    if (obj.type === 'assistant' && obj.message) {
      const mid = typeof obj.message.id === 'string' && obj.message.id ? obj.message.id : null;
      const turnKey = mid ?? `anon_${anonSeq++}`;
      let turn = turnMap.get(turnKey);
      if (!turn) {
        turn = { tools: [], apiWaitMs: 0 };
        turnMap.set(turnKey, turn);
      }
      const content = Array.isArray(obj.message.content) ? obj.message.content : [];
      for (const block of content) {
        if (block?.type === 'thinking') {
          stats.thinkingChars += String(block.thinking || '').length;
        } else if (block?.type === 'text') {
          curHumanTextChars += String(block.text || '').trim().length;
        } else if (block?.type === 'tool_use') {
          stats.toolCalls += 1;
          curHumanTools += 1;
          turn.tools.push(block.name || '');
          if (block.id && ms !== null) {
            toolStartById.set(block.id, { name: block.name || '', tsMs: ms });
          }
          if (block.name === 'Read' && typeof block.input?.file_path === 'string' && block.input.file_path) {
            const fp = block.input.file_path;
            fileReads.set(fp, (fileReads.get(fp) || 0) + 1);
          }
        }
      }
      if (mid === null || !seenMessageIds.has(mid)) {
        if (mid !== null) seenMessageIds.add(mid);
        stats.assistantTurns += 1;
        const u = obj.message.usage;
        if (u && typeof u === 'object') {
          stats.inputTokens += Number(u.input_tokens) || 0;
          stats.cacheCreationTokens += Number(u.cache_creation_input_tokens) || 0;
          stats.cacheReadTokens += Number(u.cache_read_input_tokens) || 0;
          stats.outputTokens += Number(u.output_tokens) || 0;
          stats.thinkingTokens += Number(u.output_tokens_details?.thinking_tokens) || 0;
        }
        if (lastApiReqMs !== null && ms !== null && ms >= lastApiReqMs) {
          const dt = ms - lastApiReqMs;
          stats.apiWaitMs += dt;
          if (dt > stats.maxApiWaitMs) stats.maxApiWaitMs = dt;
          if (dt >= 45_000) stats.longSilentWaits += 1;
          turn.apiWaitMs += dt;
          lastApiReqMs = null;
        }
      }
      continue;
    }
    if (obj.type === 'user') {
      const content = obj.message?.content;
      const isInterrupted = (typeof content === 'string' && content.startsWith('[Request interrupted by user'))
        || (Array.isArray(content) && content.some((b) => b?.type === 'text' && typeof b?.text === 'string' && b.text.startsWith('[Request interrupted by user')));
      if (isInterrupted) {
        stats.userInterrupts += 1;
        flushHumanTurn();
      } else if (!obj.isMeta) {
        let promptText = null;
        if (typeof content === 'string') {
          promptText = content;
        } else if (Array.isArray(content) && !content.some((b) => b?.type === 'tool_result') && content.some((b) => b?.type === 'text')) {
          promptText = content.filter((b) => b?.type === 'text').map((b) => b.text || '').join('');
        }
        if (
          promptText !== null
          && !promptText.startsWith('This session is being continued from a previous conversation')
          && !/^\s*<(?:paseo-system|task-notification)\b/i.test(promptText)
        ) {
          flushHumanTurn();
          inHumanTurn = true;
        }
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_result' && block.tool_use_id) {
            const start = toolStartById.get(block.tool_use_id);
            if (start && ms !== null && ms >= start.tsMs) {
              const dt = ms - start.tsMs;
              stats.toolWaitMs += dt;
              if (start.name === 'Bash') {
                stats.bashWaitMs += dt;
                if (dt >= 2500) stats.slowBashCalls += 1;
              }
            }
            toolStartById.delete(block.tool_use_id);
          }
        }
      }
    }
  }
  flushHumanTurn();
  for (const count of fileReads.values()) {
    if (count > stats.maxRepeatFileReads) stats.maxRepeatFileReads = count;
    if (count >= 3) stats.repeatedFilesCount += 1;
  }
  for (const turn of turnMap.values()) {
    if (turn.tools.length > 0 && turn.tools.every((n) => n === 'Bash')) {
      stats.bashOnlyTurns += 1;
      stats.bashOnlyApiWaitMs += turn.apiWaitMs;
    }
  }
  stats.totalTokens = stats.inputTokens + stats.cacheCreationTokens + stats.cacheReadTokens + stats.outputTokens;
  stats.wallMinutes = stats.firstTsMs !== null && stats.lastTsMs !== null
    ? Number(((stats.lastTsMs - stats.firstTsMs) / 60_000).toFixed(1))
    : null;
  return stats;
}

function collectAgentAndTranscriptFacts({ homeDir, claudeProjectsDir, changeName, explicitTranscripts, repoRoot, sinceMs, untilMs }) {
  const agentsDir = path.join(homeDir, 'agents');
  const matchedAgents = [];
  if (fs.existsSync(agentsDir) && (changeName || (sinceMs !== null && untilMs !== null))) {
    let realRepo = repoRoot;
    try { realRepo = fs.realpathSync(repoRoot); } catch {}
    for (const sub of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const subDir = path.join(agentsDir, sub.name);
      for (const f of fs.readdirSync(subDir).filter((name) => name.endsWith('.json'))) {
        let meta;
        try { meta = JSON.parse(fs.readFileSync(path.join(subDir, f), 'utf8')); } catch { continue; }
        const labelChange = meta?.labels?.['pipeline.change'];
        const createdMs = Date.parse(meta?.createdAt || '');
        const matchesChange = changeName && labelChange === changeName;
        let matchesWindowAndRepo = false;
        if (!changeName && sinceMs !== null && untilMs !== null && Number.isFinite(createdMs)) {
          const inWindow = createdMs >= sinceMs && createdMs <= untilMs;
          let cwdMatch = false;
          if (typeof meta?.cwd === 'string' && meta.cwd) {
            try {
              const realCwd = fs.realpathSync(meta.cwd);
              cwdMatch = realCwd === realRepo || realCwd.startsWith(`${realRepo}${path.sep}`);
            } catch {
              cwdMatch = meta.cwd === repoRoot || meta.cwd.startsWith(`${repoRoot}${path.sep}`);
            }
          }
          matchesWindowAndRepo = inWindow && cwdMatch;
        }
        if (matchesChange || matchesWindowAndRepo) {
          matchedAgents.push(meta);
        }
      }
    }
  }

  const transcriptPaths = new Set((explicitTranscripts || []).map((p) => path.resolve(p)));
  for (const agent of matchedAgents) {
    const sid = agent?.runtimeInfo?.sessionId;
    const found = findTranscriptFile(claudeProjectsDir, sid);
    if (found) transcriptPaths.add(found);
  }

  const parsedTranscripts = [...transcriptPaths].map(parseTranscript).filter(Boolean);
  if (!matchedAgents.length && !parsedTranscripts.length) {
    return null;
  }

  const byProvider = {};
  for (const a of matchedAgents) {
    const prov = a.provider || 'unknown';
    byProvider[prov] = (byProvider[prov] || 0) + 1;
  }

  const sumField = (key) => parsedTranscripts.reduce((acc, item) => acc + (item[key] || 0), 0);
  const firstTsList = parsedTranscripts.map((t) => t.firstTsMs).filter((x) => x !== null);
  const lastTsList = parsedTranscripts.map((t) => t.lastTsMs).filter((x) => x !== null);
  const createdList = matchedAgents.map((a) => Date.parse(a.createdAt || '')).filter(Number.isFinite);
  const activityList = matchedAgents.map((a) => Date.parse(a.lastActivityAt || '')).filter(Number.isFinite);

  const toMinutes = (ms) => Number((ms / 60_000).toFixed(1));
  const apiWaitMs = sumField('apiWaitMs');
  const compactionMs = sumField('compactionMs');
  const toolWaitMs = sumField('toolWaitMs');
  const bashWaitMs = sumField('bashWaitMs');
  const bashOnlyTurns = sumField('bashOnlyTurns');
  const bashOnlyApiWaitMs = sumField('bashOnlyApiWaitMs');
  const assistantTurns = sumField('assistantTurns');
  const toolCalls = sumField('toolCalls');
  const outputTokens = sumField('outputTokens');
  const inputTokens = sumField('inputTokens');
  const cacheCreationTokens = sumField('cacheCreationTokens');
  const cacheReadTokens = sumField('cacheReadTokens');
  const totalInputTokens = inputTokens + cacheCreationTokens + cacheReadTokens;
  const cacheHitRatePct = totalInputTokens > 0
    ? Number(((cacheReadTokens / totalInputTokens) * 100).toFixed(1))
    : null;
  const maxApiWaitMs = Math.max(0, ...parsedTranscripts.map((t) => t.maxApiWaitMs || 0));

  return {
    agentCount: matchedAgents.length,
    byProvider,
    transcriptCoverage: parsedTranscripts.length
      ? `${parsedTranscripts.length}/${Math.max(matchedAgents.length, parsedTranscripts.length)}`
      : `0/${matchedAgents.length}`,
    transcripts: parsedTranscripts.length ? {
      assistantTurns,
      toolCalls,
      avgToolsPerTurn: assistantTurns > 0 ? Number((toolCalls / assistantTurns).toFixed(2)) : null,
      compactions: sumField('compactions'),
      inputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      cacheHitRatePct,
      outputTokens,
      effectiveOutputTokPerSec: apiWaitMs > 0 ? Number((outputTokens / (apiWaitMs / 1000)).toFixed(1)) : null,
      thinkingTokens: sumField('thinkingTokens'),
      thinkingChars: sumField('thinkingChars'),
      slowBashCalls: sumField('slowBashCalls'),
      bashOnlyTurns,
      bashOnlyApiWaitMinutes: toMinutes(bashOnlyApiWaitMs),
      repeatedFilesCount: sumField('repeatedFilesCount'),
      maxRepeatFileReads: Math.max(0, ...parsedTranscripts.map((t) => t.maxRepeatFileReads || 0)),
      userInterrupts: sumField('userInterrupts'),
      silentToolStreaks: sumField('silentToolStreaks'),
      maxApiWaitSec: Number((maxApiWaitMs / 1000).toFixed(1)),
      longSilentWaits: sumField('longSilentWaits'),
      apiWaitMinutes: toMinutes(apiWaitMs),
      compactionMinutes: toMinutes(compactionMs),
      toolWaitMinutes: toMinutes(toolWaitMs),
      bashWaitMinutes: toMinutes(bashWaitMs),
      totalTokens: sumField('totalTokens'),
      firstTsMs: firstTsList.length ? Math.min(...firstTsList) : null,
      lastTsMs: lastTsList.length ? Math.max(...lastTsList) : null,
      spanMinutes: firstTsList.length && lastTsList.length
        ? Number(((Math.max(...lastTsList) - Math.min(...firstTsList)) / 60_000).toFixed(1))
        : null,
    } : null,
    agentCreatedMinMs: createdList.length ? Math.min(...createdList) : null,
    agentActivityMaxMs: activityList.length ? Math.max(...activityList) : null,
    agentActivityUpperBoundMin: createdList.length && activityList.length
      ? Number(((Math.max(...activityList) - Math.min(...createdList)) / 60_000).toFixed(1))
      : null,
  };
}

function healthStatus(report) {
  const { d1, d2, d3, d4, d5 } = report.dimensions;
  const flags = [];
  if (d1.transcripts?.compactions >= 2) flags.push('RED:compactions>=2');
  else if (d1.transcripts?.compactions === 1) flags.push('YELLOW:compaction=1');
  if (d1.transcripts?.maxRepeatFileReads >= 4) flags.push('YELLOW:repeat_file_reads');
  if (d1.transcripts && d1.transcripts !== NOT_COLLECTED && d1.transcripts.assistantTurns >= 40 && typeof d3.avgToolsPerTurn === 'number' && d3.avgToolsPerTurn < 1.8) {
    flags.push('YELLOW:fragmented_turns');
  }
  if (d1.transcripts?.userInterrupts >= 1) flags.push(`YELLOW:user_interrupts=${d1.transcripts.userInterrupts}`);
  if (d1.transcripts?.silentToolStreaks >= 1) flags.push(`YELLOW:silent_tool_streak=${d1.transcripts.silentToolStreaks}`);
  if (
    d1.transcripts
    && d1.transcripts !== NOT_COLLECTED
    && d1.transcripts.assistantTurns >= 5
    && (d1.transcripts.inputTokens + (d1.transcripts.cacheCreationTokens || 0)) >= 100_000
    && d1.transcripts.cacheHitRatePct === 0
  ) {
    flags.push('YELLOW:zero_cache_hit');
  }
  if (d1.telemetry?.tier2Verify?.failByReason?.dirty_worktree >= 3) flags.push('RED:dirty_worktree>=3');
  else if (d1.telemetry?.tier2Verify?.failByReason?.dirty_worktree >= 1) flags.push('YELLOW:dirty_worktree');
  if (d1.telemetry?.tierWrite?.fileLimit >= 2) flags.push('YELLOW:file_limit_overflow');
  if (d2.unprovableRejections > 0 || d2.testMutationCount > 0) flags.push('YELLOW:oracle_attention');
  if (d4.misrouted === true) flags.push('YELLOW:tier_overflow');
  if ((d5.postMergeFixes ?? 0) > 0) flags.push('RED:post_merge_reopen');
  return flags.length ? flags : ['GREEN'];
}

export function evaluateTask(options) {
  const repoRoot = path.resolve(options.repo || '.');
  const head = options.head || 'HEAD';
  const base = resolveBaseRef(repoRoot, options.base, head);
  const git = collectGitFacts({ repoRoot, base, head });
  const changeDir = resolveChangeDir(repoRoot, options.change, options['change-dir']);
  const openSpec = collectOpenSpecFacts(repoRoot, changeDir);

  const homeDir = options['paseo-home'] || paseoHome();
  const claudeProjectsDir = options['claude-projects'] || path.join(os.homedir(), '.claude', 'projects');
  let sinceMs = parseTimestamp(options.since, '--since');
  let untilMs = parseTimestamp(options.until, '--until');
  let windowSource = sinceMs !== null && untilMs !== null ? 'explicit' : 'none';

  const fallbackSinceMs = git.firstCommitMs !== null ? git.firstCommitMs - 60 * 60_000 : null;
  const fallbackUntilMs = git.lastCommitMs !== null ? git.lastCommitMs + 15 * 60_000 : null;

  const agents = collectAgentAndTranscriptFacts({
    homeDir,
    claudeProjectsDir,
    changeName: openSpec?.changeName || options.change || null,
    explicitTranscripts: options.transcript,
    repoRoot,
    sinceMs: sinceMs ?? fallbackSinceMs,
    untilMs: untilMs ?? fallbackUntilMs,
  });

  if (windowSource === 'none') {
    const starts = [];
    const ends = [];
    if (git.firstCommitMs !== null) starts.push(git.firstCommitMs - 60 * 60_000);
    if (git.lastCommitMs !== null) ends.push(git.lastCommitMs + 15 * 60_000);
    if (agents?.transcripts?.firstTsMs != null) starts.push(agents.transcripts.firstTsMs - 5 * 60_000);
    if (agents?.transcripts?.lastTsMs != null) ends.push(agents.transcripts.lastTsMs + 5 * 60_000);
    if (agents?.agentCreatedMinMs != null) starts.push(agents.agentCreatedMinMs - 5 * 60_000);
    if (agents?.agentActivityMaxMs != null) ends.push(agents.agentActivityMaxMs + 5 * 60_000);
    if (starts.length && ends.length) {
      sinceMs = Math.min(...starts);
      untilMs = Math.max(...ends);
      windowSource = agents ? 'git+agents' : 'git-commits';
    }
  }

  const metricsPath = options['metrics-file'] || telemetryFile();
  const telemetry = collectTelemetryFacts({ file: metricsPath, sinceMs, untilMs });

  const tierInitial = parseOptionalTier(options['tier-initial'], '--tier-initial');
  const tierFinal = parseOptionalTier(options['tier-final'], '--tier-final');
  const humanInterventions = parseOptionalInt(options['human-interventions'], '--human-interventions');
  const postMergeFixes = parseOptionalInt(options['post-merge-fixes'], '--post-merge-fixes');
  const mutationProbe = parseMutationProbe(options['mutations-caught']);

  const inferredRequiredTier = openSpec?.tasks?.substantive >= 4 && (openSpec.tasks.weightedSpeedup ?? 0) >= 1.8
    ? 3
    : (git.risk?.tierRequired ?? null);

  const sourceAdded = git.files.source.added;
  const totalTokens = agents?.transcripts?.totalTokens ?? null;

  const report = {
    schema: 'paseo-5d-scorecard/v1',
    generatedAt: new Date().toISOString(),
    target: {
      repo: repoRoot,
      base: git.mergeBaseSha,
      head: git.headSha,
      change: openSpec?.changeName || options.change || null,
      windowSource,
      window: sinceMs !== null && untilMs !== null
        ? { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() }
        : NOT_COLLECTED,
    },
    dimensions: {
      d1: {
        label: 'Cost & Friction Tax',
        output: {
          sourceFiles: git.files.source.files,
          testFiles: git.files.test.files,
          docsAndSpecFiles: git.files.docsAndSpec.files,
          sourceLinesAdded: sourceAdded,
          sourceLinesDeleted: git.files.source.deleted,
          tasks: openSpec?.tasks?.total ?? NOT_COLLECTED,
          scenarios: openSpec?.scenarioCount ?? NOT_COLLECTED,
        },
        transcripts: agents?.transcripts ? {
          coverage: agents.transcriptCoverage,
          assistantTurns: agents.transcripts.assistantTurns,
          toolCalls: agents.transcripts.toolCalls,
          compactions: agents.transcripts.compactions,
          thinkingChars: agents.transcripts.thinkingChars,
          slowBashCalls: agents.transcripts.slowBashCalls,
          maxRepeatFileReads: agents.transcripts.maxRepeatFileReads,
          repeatedFilesCount: agents.transcripts.repeatedFilesCount,
          inputTokens: agents.transcripts.inputTokens,
          cacheCreationTokens: agents.transcripts.cacheCreationTokens,
          cacheHitRatePct: agents.transcripts.cacheHitRatePct,
          userInterrupts: agents.transcripts.userInterrupts,
          silentToolStreaks: agents.transcripts.silentToolStreaks,
          totalTokens,
          tokensPerSourceAddedLine: sourceAdded > 0 && totalTokens !== null
            ? Number((totalTokens / sourceAdded).toFixed(1))
            : NOT_COLLECTED,
        } : NOT_COLLECTED,
        telemetry: telemetry || NOT_COLLECTED,
        humanInterventions: humanInterventions ?? NOT_COLLECTED,
      },
      d2: {
        label: 'Oracle Fidelity & Mutation Recall',
        riskReviewRequired: git.risk?.reviewRequired ?? NOT_COLLECTED,
        riskClasses: git.risk?.classes ?? NOT_COLLECTED,
        testMutationCount: git.risk?.testMutationCount ?? NOT_COLLECTED,
        caveatRemovalCount: git.risk?.caveatRemovalCount ?? NOT_COLLECTED,
        unprovableRejections: telemetry?.tier2Verify?.unprovableRejections ?? NOT_COLLECTED,
        verifyRuns: telemetry ? {
          tier2: telemetry.tier2Verify,
          workerCheck: telemetry.workerCheck,
        } : NOT_COLLECTED,
        mutationProbe: mutationProbe || NOT_COLLECTED,
      },
      d3: {
        label: 'Lead Time Breakdown',
        commitCount: git.commits.count,
        commitRoles: git.commits.roles,
        commitSpanMinutes: git.commits.spanMinutes ?? NOT_COLLECTED,
        transcriptSpanMinutes: agents?.transcripts?.spanMinutes ?? NOT_COLLECTED,
        apiWaitMinutes: agents?.transcripts?.apiWaitMinutes ?? NOT_COLLECTED,
        compactionMinutes: agents?.transcripts?.compactionMinutes ?? NOT_COLLECTED,
        toolWaitMinutes: agents?.transcripts?.toolWaitMinutes ?? NOT_COLLECTED,
        bashWaitMinutes: agents?.transcripts?.bashWaitMinutes ?? NOT_COLLECTED,
        avgToolsPerTurn: agents?.transcripts?.avgToolsPerTurn ?? NOT_COLLECTED,
        turnsPerCommit: (agents?.transcripts && git.commits.count > 0)
          ? Number((agents.transcripts.assistantTurns / git.commits.count).toFixed(1))
          : NOT_COLLECTED,
        effectiveOutputTokPerSec: agents?.transcripts?.effectiveOutputTokPerSec ?? NOT_COLLECTED,
        bashOnlyTurns: agents?.transcripts?.bashOnlyTurns ?? NOT_COLLECTED,
        bashOnlyApiWaitMinutes: agents?.transcripts?.bashOnlyApiWaitMinutes ?? NOT_COLLECTED,
        maxApiWaitSec: agents?.transcripts?.maxApiWaitSec ?? NOT_COLLECTED,
        longSilentWaits: agents?.transcripts?.longSilentWaits ?? NOT_COLLECTED,
        agentActivityUpperBoundMin: agents?.agentActivityUpperBoundMin ?? NOT_COLLECTED,
      },
      d4: {
        label: 'Tier Routing Calibration',
        tierInitial: tierInitial ?? NOT_COLLECTED,
        tierFinal: tierFinal ?? NOT_COLLECTED,
        objectiveTierRequired: inferredRequiredTier ?? NOT_COLLECTED,
        sourceFileCount: git.risk?.sourceFileCount ?? git.files.source.files,
        scopeCount: git.risk?.scopeCount ?? NOT_COLLECTED,
        weightedSpeedup: openSpec?.tasks?.weightedSpeedup ?? NOT_COLLECTED,
        fileLimitTriggers: telemetry?.tierWrite?.fileLimit ?? NOT_COLLECTED,
        scopeCrossTriggers: telemetry?.tierWrite?.scopeCross ?? NOT_COLLECTED,
        freezeHandoffs: telemetry?.freezeCheck?.handoff ?? NOT_COLLECTED,
        misrouted: tierInitial !== null && (tierFinal ?? inferredRequiredTier) !== null
          ? tierInitial !== (tierFinal ?? inferredRequiredTier)
          : NOT_COLLECTED,
      },
      d5: {
        label: 'Reviewer Calibration & Stability',
        telemetryReviews: telemetry?.reviews ?? NOT_COLLECTED,
        openSpecReview: openSpec?.review ?? NOT_COLLECTED,
        postMergeFixes: postMergeFixes ?? NOT_COLLECTED,
      },
    },
    notes: options.notes || null,
  };
  report.healthFlags = healthStatus(report);
  return report;
}

function fmt(val, suffix = '') {
  if (val === null || val === undefined || val === NOT_COLLECTED) return NOT_COLLECTED;
  return `${val}${suffix}`;
}

export function renderMarkdown(report) {
  const { target, dimensions: d } = report;
  const title = target.change || `${path.basename(target.repo)}@${target.head.slice(0, 7)}`;
  const t = d.d1.transcripts === NOT_COLLECTED ? null : d.d1.transcripts;
  const tel = d.d1.telemetry === NOT_COLLECTED ? null : d.d1.telemetry;
  const lines = [
    `# 5D Task Scorecard: ${title}`,
    '',
    `- **Repo:** \`${target.repo}\` (\`${target.base.slice(0, 7)}..${target.head.slice(0, 7)}\`)`,
    `- **Window (${target.windowSource}):** ${target.window === NOT_COLLECTED ? NOT_COLLECTED : `${target.window.since} → ${target.window.until}`}`,
    `- **Health Flags:** ${report.healthFlags.join(', ')}`,
    ...(report.notes ? [`- **Notes:** ${report.notes}`] : []),
    '',
    '| Dimension | Key Metrics | Value |',
    '| :--- | :--- | :--- |',
    `| **D1 Cost & Friction** | Output (src/test/doc files, src +/-) | ${d.d1.output.sourceFiles}/${d.d1.output.testFiles}/${d.d1.output.docsAndSpecFiles} files, +${d.d1.output.sourceLinesAdded}/-${d.d1.output.sourceLinesDeleted} |`,
    `| | Transcripts (coverage, turns, compactions, tokens) | ${t ? `${t.coverage}, ${t.assistantTurns} turns, ${t.compactions} compactions, ${t.totalTokens} tok (${fmt(t.tokensPerSourceAddedLine, ' tok/src+')})` : NOT_COLLECTED} |`,
    `| | Read thrash (max/files>=3) / slow Bash (>=2.5s) / read-guard advises | ${t ? `${t.maxRepeatFileReads}x / ${t.repeatedFilesCount} / ${t.slowBashCalls}` : NOT_COLLECTED} / ${tel ? (tel.toolGuard.reconStall + tel.toolGuard.worktreeReadStall + tel.authorGuard.repeatRead) : NOT_COLLECTED} |`,
    `| | Cache hit / user interrupts / silent tool streaks | ${t ? `${fmt(t.cacheHitRatePct, '%')} / ${t.userInterrupts} / ${t.silentToolStreaks}` : NOT_COLLECTED} |`,
    `| | Telemetry friction total / dirty_worktree / file_limit / sanitize_paseo | ${tel ? `${tel.frictionTotal} / ${tel.tier2Verify.failByReason.dirty_worktree || 0} / ${tel.tierWrite.fileLimit} / ${tel.toolGuard.sanitizePaseo}` : NOT_COLLECTED} |`,
    `| | Human interventions | ${fmt(d.d1.humanInterventions)} |`,
    `| **D2 Oracle Fidelity** | Risk classes / testMutations / unprovableRejections | ${Array.isArray(d.d2.riskClasses) ? (d.d2.riskClasses.join(', ') || 'none') : NOT_COLLECTED} / ${fmt(d.d2.testMutationCount)} / ${fmt(d.d2.unprovableRejections)} |`,
    `| | Mutation probe (caught/total) | ${d.d2.mutationProbe === NOT_COLLECTED ? NOT_COLLECTED : `${d.d2.mutationProbe.caught}/${d.d2.mutationProbe.total} (${d.d2.mutationProbe.ratePct}%)`} |`,
    `| **D3 Lead Time** | Commits / commit span / transcript span / agent activity upper bound | ${d.d3.commitCount} commits / ${fmt(d.d3.commitSpanMinutes, 'm')} / ${fmt(d.d3.transcriptSpanMinutes, 'm')} / ${fmt(d.d3.agentActivityUpperBoundMin, 'm')} |`,
    `| | Time breakdown (API / compact / tools / Bash) | ${fmt(d.d3.apiWaitMinutes, 'm')} / ${fmt(d.d3.compactionMinutes, 'm')} / ${fmt(d.d3.toolWaitMinutes, 'm')} / ${fmt(d.d3.bashWaitMinutes, 'm')} |`,
    `| | Wait tails (max API wait / >=45s waits) | ${fmt(d.d3.maxApiWaitSec, 's')} / ${fmt(d.d3.longSilentWaits)} |`,
    `| | Turn efficiency (tools/turn / turns/commit / eff tok/s / bash-only) | ${fmt(d.d3.avgToolsPerTurn)} / ${fmt(d.d3.turnsPerCommit)} / ${fmt(d.d3.effectiveOutputTokPerSec)} / ${d.d3.bashOnlyTurns === NOT_COLLECTED ? NOT_COLLECTED : `${d.d3.bashOnlyTurns} (${fmt(d.d3.bashOnlyApiWaitMinutes, 'm')})`} |`,
    `| **D4 Tier Routing** | Tier initial → final (objective required) | ${fmt(d.d4.tierInitial)} → ${fmt(d.d4.tierFinal)} (req: ${fmt(d.d4.objectiveTierRequired)}, scopes: ${fmt(d.d4.scopeCount)}) |`,
    `| | file_limit / scope_cross / handoff reroutes | ${fmt(d.d4.fileLimitTriggers)} / ${fmt(d.d4.scopeCrossTriggers)} / ${fmt(d.d4.freezeHandoffs)} |`,
    `| **D5 Review & Stability** | Telemetry reviews / OpenSpec review markers | ${d.d5.telemetryReviews === NOT_COLLECTED ? NOT_COLLECTED : `${d.d5.telemetryReviews.pass} pass, ${d.d5.telemetryReviews.blocked} blocked`} / ${d.d5.openSpecReview === NOT_COLLECTED ? NOT_COLLECTED : `R0=${d.d5.openSpecReview.r0Markers}, FINAL=${d.d5.openSpecReview.finalMarkers}, gap=${d.d5.openSpecReview.contractGaps}`} |`,
    `| | Post-merge fixes | ${fmt(d.d5.postMergeFixes)} |`,
  ];
  return lines.join('\n');
}

export function compareReports(reports) {
  const rows = reports.map((r) => {
    const t = r.dimensions.d1.transcripts === NOT_COLLECTED ? null : r.dimensions.d1.transcripts;
    const tel = r.dimensions.d1.telemetry === NOT_COLLECTED ? null : r.dimensions.d1.telemetry;
    return {
      name: r.target.change || `${path.basename(r.target.repo)}@${r.target.head.slice(0, 7)}`,
      tier: `${fmt(r.dimensions.d4.tierInitial)}->${fmt(r.dimensions.d4.tierFinal)} (req ${fmt(r.dimensions.d4.objectiveTierRequired)})`,
      srcFiles: r.dimensions.d1.output.sourceFiles,
      srcAdded: r.dimensions.d1.output.sourceLinesAdded,
      compactions: t ? t.compactions : NOT_COLLECTED,
      totalTokens: t ? t.totalTokens : NOT_COLLECTED,
      frictionTotal: tel ? tel.frictionTotal : NOT_COLLECTED,
      dirtyWorktree: tel ? (tel.tier2Verify.failByReason.dirty_worktree || 0) : NOT_COLLECTED,
      fileLimit: tel ? tel.tierWrite.fileLimit : NOT_COLLECTED,
      spanMin: r.dimensions.d3.transcriptSpanMinutes !== NOT_COLLECTED
        ? r.dimensions.d3.transcriptSpanMinutes
        : r.dimensions.d3.commitSpanMinutes,
      postMergeFixes: r.dimensions.d5.postMergeFixes,
      health: r.healthFlags.join(','),
    };
  });
  return {
    schema: 'paseo-5d-comparison/v1',
    count: rows.length,
    rows,
  };
}

export function renderComparisonMarkdown(summary) {
  const lines = [
    `# 5D Scorecard Comparison (${summary.count} tasks)`,
    '',
    '| Task | Tier | Src Files (+LoC) | Compactions | Tokens | Friction (dirty/limit) | Span (m) | Post-Merge Fixes | Health |',
    '| :--- | :--- | ---: | ---: | ---: | :---: | ---: | ---: | :--- |',
  ];
  for (const r of summary.rows) {
    lines.push(`| ${r.name} | ${r.tier} | ${r.srcFiles} (+${r.srcAdded}) | ${r.compactions} | ${r.totalTokens} | ${r.frictionTotal} (${r.dirtyWorktree}/${r.fileLimit}) | ${r.spanMin} | ${r.postMergeFixes} | ${r.health} |`);
  }
  return lines.join('\n');
}

function main() {
  let parsed;
  try {
    parsed = parseOptions(process.argv.slice(2), OPTION_SCHEMA);
  } catch (err) {
    console.error(`[scorecard-5d] ${err.message}\n${USAGE}`);
    process.exit(2);
  }
  if (parsed.options.help) {
    console.log(USAGE);
    return;
  }

  let outputText;
  if (parsed.options.compare) {
    if (!parsed.positional.length) {
      console.error('[scorecard-5d] --compare requires at least one JSON report file');
      process.exit(2);
    }
    const reports = parsed.positional.map((f) => JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')));
    const summary = compareReports(reports);
    outputText = parsed.options.json
      ? JSON.stringify(summary, null, 2)
      : renderComparisonMarkdown(summary);
  } else {
    const report = evaluateTask(parsed.options);
    outputText = parsed.options.json
      ? JSON.stringify(report, null, 2)
      : renderMarkdown(report);
  }

  if (parsed.options.out) {
    const target = path.resolve(parsed.options.out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${outputText}\n`, 'utf8');
  } else {
    console.log(outputText);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`[scorecard-5d] ${err.message}`);
    process.exit(1);
  }
}
