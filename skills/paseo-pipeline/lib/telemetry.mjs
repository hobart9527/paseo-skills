// Fail-open, secret-free local harness telemetry (ADR-0005).
// Writes compact (<200B) event metadata lines to PIPELINE_TELEMETRY_FILE or ~/.paseo/harness-metrics.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { paseoHome } from './paseo.mjs';

const MAX_BYTES = 200;
const DAY_MS = 86_400_000;
const STRING_KEYS = ['verdict', 'action', 'reasonCode', 'tier', 'role'];
const NUM_KEYS = ['exit', 'durationMs', 'count', 'unprovableCount'];

export const MONITORED_RULES = [
  'sanitize_paseo',
  'sanitize_workspace',
  'paseo_cli_wait',
  'worktree_cd_primary',
  'repeated_failure',
  'bare_provider',
  'settings_mismatch',
  'missing_pipeline_label',
  'file_limit',
  'scope_cross',
  'large_file',
  'test_blast',
  'churn',
  'risk_sentinel',
  'worktree_compact_heavy',
  'worktree_missing_workspace_id',
  'builtin_agent_review',
];

export function telemetryFile() {
  return process.env.PIPELINE_TELEMETRY_FILE || path.join(paseoHome(), 'harness-metrics.jsonl');
}

function sanitizeFields(fields) {
  const clean = {};
  if (!fields || typeof fields !== 'object') return clean;
  for (const key of STRING_KEYS) {
    if (typeof fields[key] === 'string' && fields[key].trim()) {
      clean[key] = fields[key].trim().slice(0, 48);
    }
  }
  for (const key of NUM_KEYS) {
    if (typeof fields[key] === 'number' && Number.isFinite(fields[key])) {
      clean[key] = fields[key];
    }
  }
  if (typeof fields.ok === 'boolean') clean.ok = fields.ok;
  if (Array.isArray(fields.riskClasses) && fields.riskClasses.length) {
    clean.riskClasses = fields.riskClasses
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => item.trim().slice(0, 20))
      .slice(0, 5);
  }
  return clean;
}

export function recordEvent(event, fields = {}, { file = null } = {}) {
  try {
    if (process.env.PIPELINE_TELEMETRY === 'off') return false;
    // Prevent `node --test` invocations from polluting the real global metrics file unless isolated.
    if (!file && !process.env.PIPELINE_TELEMETRY_FILE && process.env.NODE_TEST_CONTEXT) return false;
    const target = file || telemetryFile();
    const record = {
      ts: Date.now(),
      event: String(event || 'unknown').trim().slice(0, 32),
      ...sanitizeFields(fields),
    };
    let line = JSON.stringify(record);
    if (Buffer.byteLength(line, 'utf8') >= MAX_BYTES) {
      delete record.riskClasses;
      line = JSON.stringify(record);
    }
    if (Buffer.byteLength(line, 'utf8') >= MAX_BYTES && typeof record.reasonCode === 'string') {
      record.reasonCode = record.reasonCode.slice(0, 16);
      line = JSON.stringify(record);
    }
    if (Buffer.byteLength(line, 'utf8') >= MAX_BYTES) return false;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${line}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function rate(num, den) {
  return den > 0 ? Number(((num / den) * 100).toFixed(1)) : null;
}

export function summarizeTelemetry({ days = 7, file = null } = {}) {
  const parsedDays = Number(days);
  const windowDays = Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 7;
  const target = file || telemetryFile();
  const cutoff = Date.now() - windowDays * DAY_MS;

  const summary = {
    windowDays,
    file: target,
    totalEvents: 0,
    byEvent: {},
    hookActions: { rewrite: 0, deny: 0, advise: 0 },
    verify: { total: 0, pass: 0, fail: 0, reviewRequired: 0, unprovableRejections: 0 },
    workerCheck: { total: 0, pass: 0, fail: 0 },
    stopBlocks: { total: 0, byReason: {} },
    tierWrite: { ask: 0, deny: 0, byReason: {} },
    freezeCheck: { total: 0, pipeline: 0, handoff: 0, failed: 0 },
    mergeTask: { total: 0, pass: 0, fail: 0 },
    cp2Merge: { total: 0, pass: 0, fail: 0, driftSynced: 0 },
    reviews: { total: 0, pass: 0, blocked: 0, incomplete: 0, humanAccept: 0 },
    northStar: {
      tier2PassRate: null,
      workerFirstPassRate: null,
      mergePassRate: null,
      tier3HandoffRate: null,
      reviewBlockerRate: null,
    },
    pruneCandidates: [],
    topReasonCodes: [],
  };

  let raw = '';
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch {
    return summary;
  }

  const reasonCounts = new Map();
  let freezeFullTotal = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object' || typeof entry.ts !== 'number' || entry.ts < cutoff) continue;

    summary.totalEvents += 1;
    const ev = typeof entry.event === 'string' ? entry.event : 'unknown';
    summary.byEvent[ev] = (summary.byEvent[ev] || 0) + 1;

    if (typeof entry.reasonCode === 'string' && entry.reasonCode) {
      reasonCounts.set(entry.reasonCode, (reasonCounts.get(entry.reasonCode) || 0) + 1);
    }

    if (ev === 'tool_guard' && Object.hasOwn(summary.hookActions, entry.action)) {
      summary.hookActions[entry.action] += 1;
    } else if (ev === 'tier2_verify') {
      summary.verify.total += 1;
      if (entry.verdict === 'PASS') summary.verify.pass += 1;
      else if (entry.verdict === 'REVIEW_REQUIRED') summary.verify.reviewRequired += 1;
      else if (entry.verdict === 'FAIL') summary.verify.fail += 1;
      if (typeof entry.unprovableCount === 'number' && entry.unprovableCount > 0) {
        summary.verify.unprovableRejections += entry.unprovableCount;
      }
    } else if (ev === 'worker_check') {
      summary.workerCheck.total += 1;
      if (entry.ok === true) summary.workerCheck.pass += 1;
      else summary.workerCheck.fail += 1;
    } else if (ev === 'tier_stop' && entry.verdict === 'block') {
      summary.stopBlocks.total += 1;
      const code = entry.reasonCode || 'unknown';
      summary.stopBlocks.byReason[code] = (summary.stopBlocks.byReason[code] || 0) + 1;
    } else if (ev === 'tier_write') {
      if (entry.action === 'ask') summary.tierWrite.ask += 1;
      else if (entry.action === 'deny') summary.tierWrite.deny += 1;
      const code = entry.reasonCode || 'unknown';
      summary.tierWrite.byReason[code] = (summary.tierWrite.byReason[code] || 0) + 1;
    } else if (ev === 'freeze_check') {
      summary.freezeCheck.total += 1;
      if (entry.verdict === 'pipeline' || entry.verdict === 'handoff') {
        freezeFullTotal += 1;
        if (entry.verdict === 'pipeline') summary.freezeCheck.pipeline += 1;
        else summary.freezeCheck.handoff += 1;
      }
      if (entry.ok === false) summary.freezeCheck.failed += 1;
    } else if (ev === 'merge_task') {
      summary.mergeTask.total += 1;
      if (entry.ok === true) summary.mergeTask.pass += 1;
      else summary.mergeTask.fail += 1;
    } else if (ev === 'cp2_merge') {
      summary.cp2Merge.total += 1;
      if (entry.ok === true) {
        summary.cp2Merge.pass += 1;
        if (entry.verdict === 'drift_synced') summary.cp2Merge.driftSynced += 1;
      } else {
        summary.cp2Merge.fail += 1;
      }
    } else if (ev === 'review_verdict') {
      summary.reviews.total += 1;
      if (entry.verdict === 'pass') summary.reviews.pass += 1;
      else if (entry.verdict === 'blocked') summary.reviews.blocked += 1;
      else if (entry.verdict === 'incomplete') summary.reviews.incomplete += 1;
      else if (entry.verdict === 'human_accept') summary.reviews.humanAccept += 1;
    }
  }

  summary.northStar = {
    tier2PassRate: rate(summary.verify.pass + summary.verify.reviewRequired, summary.verify.total),
    workerFirstPassRate: rate(summary.workerCheck.pass, summary.workerCheck.total),
    mergePassRate: rate(summary.mergeTask.pass, summary.mergeTask.total),
    tier3HandoffRate: rate(summary.freezeCheck.handoff, freezeFullTotal),
    reviewBlockerRate: rate(summary.reviews.blocked, summary.reviews.total),
  };

  if (windowDays >= 30 && summary.totalEvents > 0) {
    summary.pruneCandidates = MONITORED_RULES.filter((code) => !reasonCounts.has(code));
  }

  summary.topReasonCodes = [...reasonCounts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  return summary;
}
