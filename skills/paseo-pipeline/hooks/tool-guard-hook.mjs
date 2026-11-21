#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logHookError, repoContext } from '../lib/tier-gate.mjs';
import { paseoHome, loadProfiles, profilePair } from '../lib/paseo.mjs';
import { runGit } from '../lib/git.mjs';
import { recordEvent } from '../lib/telemetry.mjs';
import { recordAuthorRead } from '../lib/author-guard.mjs';

const LIMIT = 2 * 1024 * 1024;
const TAIL_ANCHOR = 256;
// The server rejects `branch`/`prNumber`/`forge` together with `mode: "branch-off"` (and with the
// omitted default, which is branch-off). Denying only produced the same call again — one window
// logged 48 identical failures — so rewrite it into the call the server accepts.
const BRANCH_OFF_EXTRAS = ['branch', 'prNumber', 'forge'];
// An id that is not a `srv_*` handle is never resolvable. Denying it mid-batch loses the call;
// stripping sends the request to the calling daemon, which is what an omitted serverId means.
// "srv_invalid" also matches the handle shape, so the placeholder words are named explicitly
// instead of requiring mixed case; a real id must not be stripped by accident.
const PLACEHOLDER_SERVER_ID = /^srv[_-]?(?:invalid|unknown|placeholder|none|null|test|dummy|example|fake|todo|x+)?$/i;
const isPlaceholderServerId = (value) => {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return text === '' || !/^srv_[A-Za-z0-9]+$/.test(text) || PLACEHOLDER_SERVER_ID.test(text);
};
// A near-miss of this host's own id (one dropped or swapped character, seen 4 times in one session)
// is a typo for "this host"; omitting serverId means exactly that. Distant srv_* ids may be real
// remote hosts and are left to the server.
function localServerId() {
  try { return fs.readFileSync(path.join(paseoHome(), 'server-id'), 'utf8').trim(); } catch { return ''; }
}
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}
const isTypoOfLocal = (value, local) => typeof value === 'string' && !!local
  && value.trim() !== local && editDistance(value.trim(), local) <= 2;
// Words models use for "the caller's workspace"; omitting workspaceId means exactly that.
const PLACEHOLDER_WORKSPACE_ID = /^(?:|default|local|current|self|this|none|null|x+)$/i;
const TITLE_MAX = 60;
const clip = (text) => Array.from(text).slice(0, TITLE_MAX).join('').slice(0, TITLE_MAX);
/** create_agent: title is required and ≤60 chars; a missing one is derived from the prompt's first line. */
function sanitizedCreateAgent(input) {
  const next = { ...input };
  let changed = false;
  if (typeof next.workspaceId === 'string' && PLACEHOLDER_WORKSPACE_ID.test(next.workspaceId.trim())) {
    delete next.workspaceId; changed = true;
  }
  const title = typeof next.title === 'string' ? next.title.trim() : '';
  if (!title && typeof next.initialPrompt === 'string') {
    const line = next.initialPrompt.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').replace(/\s+/g, ' ').trim()).find(Boolean);
    if (line) { next.title = clip(line); changed = true; }
  } else if (title && (title.length > TITLE_MAX || title !== next.title)) {
    next.title = clip(title); changed = true;
  }
  return changed ? next : null;
}
/** A bare provider ("claude") is ambiguous across profiles, so it cannot be rewritten; name the valid pairs. */
function bareProviderReason(input) {
  const provider = typeof input?.provider === 'string' ? input.provider.trim() : '';
  if (!provider || provider.includes('/')) return null;
  const pairs = loadProfiles().map((p) => profilePair(p) && `${String(p.name ?? p.id).split(/\s/)[0]}=${profilePair(p)}`).filter(Boolean);
  return `create_agent provider must be "<profile.provider>/<profile.model>", not "${provider}". Join the two list_profiles fields with "/".`
    + (pairs.length ? ` Current profiles: ${pairs.join(', ')}.` : '');
}
const SETTINGS = ['modeId', 'thinkingOptionId', 'features'];
function filledModeId(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  if (!provider.includes('/')) return null;
  const nested = input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings) ? input.settings : {};
  const stated = 'modeId' in nested ? nested.modeId : input.modeId;
  if (stated !== undefined && stated !== null) return null;
  const modes = [...new Set(loadProfiles().filter((profile) => profilePair(profile) === provider)
    .map((profile) => profile.modeId).filter((mode) => typeof mode === 'string' && mode))];
  if (modes.length !== 1) return null;
  return { ...input, settings: { ...nested, modeId: modes[0] } };
}
const canonical = (value) => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v);
const sameValue = (left, right) => canonical(left) === canonical(right);
// Empty `features` map `{}` carries zero flag overrides, semantically identical to null/undefined.
const isUnset = (field, value) => value === undefined || value === null
  || (field === 'features' && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
function settingsMismatchReason(input) {
  const provider = typeof input?.provider === 'string' ? input.provider.trim() : '';
  if (!provider.includes('/')) return null;
  const matches = loadProfiles().filter((profile) => profilePair(profile) === provider);
  if (!matches.length) return null;
  const nested = input?.settings && typeof input.settings === 'object' && !Array.isArray(input.settings) ? input.settings : {};
  const valueOf = (field) => (field in nested ? nested[field] : input?.[field]);
  const stated = SETTINGS.filter((field) => valueOf(field) !== undefined);
  if (!stated.length) return null;
  const agrees = (profile, field) => (isUnset(field, profile[field])
    ? isUnset(field, valueOf(field))
    : sameValue(profile[field], valueOf(field)));
  if (matches.some((profile) => stated.every((field) => agrees(profile, field)))) return null;
  const role = (profile) => String(profile.name ?? profile.id ?? provider).split(/\s/)[0];
  if (matches.length === 1) {
    const [profile] = matches;
    const field = stated.find((name) => !agrees(profile, name));
    const expected = profile[field];
    return `create_agent ${field} is ${JSON.stringify(valueOf(field))}, but profile ${role(profile)} (${provider}) sets ${isUnset(field, expected) ? 'none' : JSON.stringify(expected)}. Use the profile's value, or edit the profile in config.json if the setting really changed.`;
  }
  const candidates = matches.map((profile) => `${role(profile)} (${provider}) sets ${stated.map((field) => `${field} ${isUnset(field, profile[field]) ? 'none' : JSON.stringify(profile[field])}`).join(', ')}`).join('; ');
  return `create_agent ${stated.map((field) => `${field} ${JSON.stringify(valueOf(field))}`).join(', ')} matches no profile for ${provider}. Candidates: ${candidates}. Use one candidate's values, or edit the profile in config.json if the setting really changed.`;
}
/** The planner and merge gate find pipeline agents by this label; an unlabelled one is invisible and gets re-dispatched. */
const hasChangeLabel = (input) => {
  const change = input?.labels?.['pipeline.change'];
  return typeof change === 'string' && !!change.trim();
};
function liveChanges(cwd) {
  const ctx = typeof cwd === 'string' && cwd ? repoContext(cwd) : null;
  if (!ctx) return [];
  try {
    return fs.readdirSync(path.join(ctx.root, 'openspec', 'changes'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'archive').map((entry) => entry.name);
  } catch { return []; }
}
/** Fill pipeline.change only when exactly one live change is named by the title (its last token, per DISPATCH) or, failing that, by `openspec/changes/<name>` paths in the prompt. */
function inferredChange(input, cwd) {
  const live = liveChanges(cwd);
  if (!live.length) return null;
  const tokens = new Set(String(input.title).trim().split(/\s+/));
  let hits = live.filter((name) => tokens.has(name));
  if (!hits.length && typeof input.initialPrompt === 'string') {
    hits = live.filter((name) => input.initialPrompt.includes(`openspec/changes/${name}/`) || input.initialPrompt.includes(`pipeline.change=${name}`));
  }
  return hits.length === 1 ? hits[0] : null;
}
function withPipelineLabel(input, cwd) {
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  if (!title.startsWith('[Pipeline]') || hasChangeLabel(input)) return null;
  const change = inferredChange({ ...input, title }, cwd);
  if (!change) return null;
  const labels = input.labels && typeof input.labels === 'object' && !Array.isArray(input.labels) ? input.labels : {};
  return { ...input, labels: { ...labels, 'pipeline.change': change } };
}
function pipelineLabelReason(input) {
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  if (!title.startsWith('[Pipeline]') || hasChangeLabel(input)) return null;
  return 'A "[Pipeline]" agent needs labels: { "pipeline.change": "<change>" } (the openspec change name); without it `pipeline-run.mjs plan` cannot see the agent and dispatches the task again. The hook could not infer one unambiguously. Copy title and labels from the plan\'s DISPATCH line.';
}
const output = (fields) => console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...fields } }));
const deny = (reason, reasonCode = 'denied') => {
  recordEvent('tool_guard', { action: 'deny', reasonCode });
  output({ permissionDecision: 'deny', permissionDecisionReason: reason });
};

function cacheDir() {
  return process.env.PIPELINE_TIER_GATE_STATE || path.join(os.tmpdir(), 'paseo-tier-gate');
}

function cachePathFor(transcriptFile) {
  const hash = crypto.createHash('sha1').update(transcriptFile).digest('hex').slice(0, 12);
  return path.join(cacheDir(), `tg-${hash}.json`);
}

function readTailHash(fd, offset) {
  if (offset <= 0) return '';
  const start = Math.max(0, offset - TAIL_ANCHOR);
  const len = offset - start;
  const buf = Buffer.alloc(len);
  const bytes = fs.readSync(fd, buf, 0, len, start);
  return crypto.createHash('sha1').update(buf.subarray(0, bytes)).digest('hex').slice(0, 16);
}

function applyLines(lines, prevCalls = []) {
  const calls = [...prevCalls];
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item.type === 'tool_use') {
        calls.push({ id: item.id || null, name: item.name, input: canonical(item.input), result: undefined });
      } else if (item.type === 'tool_result' && item.tool_use_id) {
        // Reconcile against calls by tool_use_id instead of object reference so JSON cache reload preserves identity.
        for (let i = calls.length - 1; i >= 0; i -= 1) {
          if (calls[i].id === item.tool_use_id) {
            calls[i] = { ...calls[i], result: item.is_error === true };
            break;
          }
        }
      }
    }
  }
  return calls.slice(-32);
}

function loadTranscriptCalls(file) {
  if (typeof file !== 'string' || !file) return [];
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return []; }
  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    if (size === 0) return [];

    const cPath = cachePathFor(file);
    let cached = null;
    try { cached = JSON.parse(fs.readFileSync(cPath, 'utf8')); } catch { cached = null; }

    const sameInode = cached && cached.ino === stat.ino && typeof cached.offset === 'number' && cached.offset >= 0 && cached.offset <= size;
    if (sameInode && size === cached.offset && readTailHash(fd, cached.offset) === cached.tailHash) {
      return cached.calls || [];
    }

    let prevCalls = [];
    let readFrom = Math.max(0, size - LIMIT);
    let dropFirstPartial = readFrom > 0;

    if (sameInode && size > cached.offset && size - cached.offset <= LIMIT && readTailHash(fd, cached.offset) === cached.tailHash) {
      prevCalls = cached.calls || [];
      readFrom = cached.offset;
      dropFirstPartial = false;
    }

    const buffer = Buffer.alloc(size - readFrom);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, readFrom);
    let text = buffer.subarray(0, bytes).toString('utf8');
    let consumedBytes = bytes;
    if (dropFirstPartial) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    const rawLines = text.split('\n');
    if (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() !== '') {
      try { JSON.parse(rawLines[rawLines.length - 1]); }
      catch {
        // Hold back trailing incomplete JSON line so next turn parses it whole.
        const incomplete = rawLines.pop();
        consumedBytes = Math.max(0, bytes - Buffer.byteLength(incomplete, 'utf8'));
      }
    }
    const nextCalls = applyLines(rawLines, prevCalls);
    const newOffset = readFrom + consumedBytes;
    const tailHash = readTailHash(fd, newOffset);
    try {
      fs.mkdirSync(cacheDir(), { recursive: true });
      fs.writeFileSync(cPath, JSON.stringify({
        ino: stat.ino,
        offset: newOffset,
        tailHash,
        calls: nextCalls,
      }));
    } catch {}
    return nextCalls;
  } finally {
    fs.closeSync(fd);
  }
}

function repeatedFailures(file, name, input) {
  const calls = loadTranscriptCalls(file);
  const expected = canonical(input);
  return calls.length >= 3 && calls.slice(-3).every((call) => call.name === name && call.input === expected && call.result === true);
}

// Say what to change, not just that something failed. The old message ("change args") was read as
// "retry the same call", which is how a denial loop forms.
function repeatedFailureReason(name) {
  if (name === 'mcp__paseo__create_workspace') {
    return 'This exact create_workspace call failed 3 times. Read the error, then change the fields: for mode "branch-off" (the default) remove branch、prNumber、forge and keep only branchName+baseBranch (plus optional worktreeSlug/path).';
  }
  return 'This exact call failed 3 times. Read the error text and change the specific field it names before retrying; if the error does not name a field, report to the user instead of repeating the call.';
}

/** Strip fields the server rejects for the mode being used; returns null when nothing changes. */
function sanitizedPaseoInput(name, input) {
  if (name !== 'mcp__paseo__create_workspace') return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const mode = typeof input.mode === 'string' ? input.mode.trim().toLowerCase() : 'branch-off';
  if (mode !== 'branch-off') return null;
  if (!BRANCH_OFF_EXTRAS.some((field) => field in input)) return null;
  const next = { ...input };
  for (const field of BRANCH_OFF_EXTRAS) delete next[field];
  return next;
}

function realOrResolved(target) {
  try { return fs.realpathSync(target); } catch { return path.resolve(target); }
}

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function primaryCheckoutWarning(cwd, command) {
  if (typeof cwd !== 'string' || !cwd || !/\bcd\b/.test(command)) return null;
  const ctx = repoContext(cwd);
  if (!ctx || ctx.isPrimary) return null;
  const common = runGit(ctx.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const commonRaw = common.status === 0 && common.stdout.trim()
    ? common.stdout.trim()
    : runGit(ctx.root, ['rev-parse', '--git-common-dir']).stdout.trim();
  if (!commonRaw) return null;
  const commonAbs = realOrResolved(path.isAbsolute(commonRaw) ? commonRaw : path.resolve(ctx.root, commonRaw));
  if (path.basename(commonAbs) !== '.git') return null;
  const primaryRoot = path.dirname(commonAbs);
  if (primaryRoot === ctx.root) return null;

  const cdRegex = /(?:^|[;&|(\s])cd\s+(?:-P\s+|-L\s+)?(?:"([^"\n]+)"|'([^'\n]+)'|([^\s;&|()]+))/g;
  for (const match of command.matchAll(cdRegex)) {
    const rawTarget = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!rawTarget || rawTarget.startsWith('$') || rawTarget.startsWith('~') || rawTarget === '-') continue;
    const resolved = realOrResolved(path.isAbsolute(rawTarget) ? rawTarget : path.resolve(cwd, rawTarget));
    if (inside(primaryRoot, resolved) && !inside(ctx.root, resolved)) {
      return `You are in a linked worktree (${ctx.root}); avoid \`cd\` into the shared primary checkout (${primaryRoot}). Use \`git -C <abs-path>\` or absolute paths instead.`;
    }
  }
  return null;
}

async function main() {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch { return; }
  const name = payload?.tool_name;
  const input = payload?.tool_input;
  if (name === 'Bash' && typeof input?.command === 'string') {
    const command = input.command;
    const contexts = [];
    if (/\bpaseo\s+(?:run|send)\b/.test(command) && !/(?:^|\s)--wait(?:\s|=|$)/.test(command) && !/\bpaseo\s+wait\b/.test(command)) {
      recordEvent('tool_guard', { action: 'advise', reasonCode: 'paseo_cli_wait' });
      contexts.push('CLI dispatch registers no completion callback; ending this turn will not wake the parent. Use MCP create_agent, or immediately start paseo wait <id> --timeout 540 in the background.');
    }
    const cdWarn = primaryCheckoutWarning(payload?.cwd, command);
    if (cdWarn) {
      recordEvent('tool_guard', { action: 'advise', reasonCode: 'worktree_cd_primary' });
      contexts.push(cdWarn);
    }
    const authorGuard = recordAuthorRead({ cwd: payload?.cwd, sessionId: payload?.session_id, command });
    if (authorGuard?.message) contexts.push(authorGuard.message);
    if (contexts.length) output({ additionalContext: contexts.join('\n') });
  }
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return;
  let updated = input;
  let changed = false;
  if (name.startsWith('mcp__paseo__')) {
    const isObject = updated && typeof updated === 'object' && !Array.isArray(updated);
    if (isObject && (isPlaceholderServerId(updated.serverId) || isTypoOfLocal(updated.serverId, localServerId()))) {
      updated = { ...updated };
      delete updated.serverId;
      changed = true;
    }
    const sanitized = sanitizedPaseoInput(name, updated);
    if (sanitized) {
      updated = sanitized;
      changed = true;
    }
    const bare = isObject && name === 'mcp__paseo__create_agent' ? bareProviderReason(updated) : null;
    if (bare) { deny(bare, 'bare_provider'); return; }
    const filled = isObject && name === 'mcp__paseo__create_agent' ? filledModeId(updated) : null;
    if (filled) {
      updated = filled;
      changed = true;
    }
    const settingsMismatch = isObject && name === 'mcp__paseo__create_agent' ? settingsMismatchReason(updated) : null;
    if (settingsMismatch) { deny(settingsMismatch, 'settings_mismatch'); return; }
    const labelled = isObject && name === 'mcp__paseo__create_agent' ? withPipelineLabel(updated, payload?.cwd) : null;
    if (labelled) {
      updated = labelled;
      changed = true;
    }
    const unlabelled = isObject && name === 'mcp__paseo__create_agent' ? pipelineLabelReason(updated) : null;
    if (unlabelled) { deny(unlabelled, 'missing_pipeline_label'); return; }
    const agent = isObject && name === 'mcp__paseo__create_agent' ? sanitizedCreateAgent(updated) : null;
    if (agent) {
      updated = agent;
      changed = true;
    }
  }
  // A rewritten call cannot be the same failing call, so it never reaches the deny below.
  if (changed) {
    recordEvent('tool_guard', { action: 'rewrite', reasonCode: name === 'mcp__paseo__create_workspace' ? 'sanitize_workspace' : 'sanitize_paseo' });
    output({ permissionDecision: 'allow', updatedInput: updated });
    return;
  }
  if (repeatedFailures(payload.transcript_path, name, input)) deny(repeatedFailureReason(name), 'repeated_failure');
}

try { await main(); } catch (err) { logHookError('tool-guard-hook', err); }
