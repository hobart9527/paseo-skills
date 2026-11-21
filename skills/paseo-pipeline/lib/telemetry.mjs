// Fail-open, secret-free local harness telemetry (ADR-0005).
// Writes compact (<200B) event metadata lines to PIPELINE_TELEMETRY_FILE or ~/.paseo/harness-metrics.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { paseoHome } from './paseo.mjs';

const MAX_BYTES = 200;
const DAY_MS = 86_400_000;
const STRING_KEYS = ['verdict', 'action', 'reasonCode', 'tier', 'role'];
const NUM_KEYS = ['exit', 'durationMs', 'count', 'unprovableCount'];

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
    authorGuard: { warn: 0, stop: 0, compactEmptySpecs: 0 },
    topReasonCodes: [],
  };

  let raw = '';
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch {
    return summary;
  }

  const reasonCounts = new Map();
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
    } else if (ev === 'author_guard') {
      const code = entry.reasonCode || '';
      if (code === 'author_thrash_warn') summary.authorGuard.warn += 1;
      else if (code === 'author_thrash_stop') summary.authorGuard.stop += 1;
      else if (code === 'author_compact_empty_specs') summary.authorGuard.compactEmptySpecs += 1;
    }
  }

  summary.topReasonCodes = [...reasonCounts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  return summary;
}
