#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
function localServerId(paseoHome) {
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
const GENERIC_ROLE_PREFIXES = /^(?:兼容入口|测试|开发|审查|调研|架构|协调|攻坚|界面)$/;
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function profileMatchTokens(profile) {
  const tokens = new Set();
  const id = typeof profile?.id === 'string' ? profile.id.trim() : '';
  if (id) tokens.add(id.toLowerCase());
  const idMatch = id.match(/^agent_profile_([a-z][a-z0-9-]+)$/i);
  if (idMatch) tokens.add(idMatch[1].toLowerCase());
  const name = typeof profile?.name === 'string' ? profile.name.trim() : '';
  if (name) {
    tokens.add(name.toLowerCase());
    for (const m of name.matchAll(/[（(]([^）)]+)[）)]/g)) {
      const inner = m[1].trim();
      if (!inner || /[，,]/.test(inner)) continue;
      if (/^[a-z0-9-]+$/i.test(inner)) {
        if (inner.length >= 3) tokens.add(inner.toLowerCase());
      } else if (inner.length >= 2 && inner.length <= 6) {
        tokens.add(inner);
      }
    }
    const lead = name.split(/[\s（(]/)[0].trim();
    if (lead.length >= 2 && !GENERIC_ROLE_PREFIXES.test(lead) && (!/^[a-z0-9-]+$/i.test(lead) || lead.length >= 3)) {
      tokens.add(/^[a-z0-9-]+$/i.test(lead) ? lead.toLowerCase() : lead);
    }
  }
  return [...tokens];
}
function tokenMatchesText(text, token) {
  if (!text || !token) return false;
  if (/^[a-z0-9-]+$/i.test(token)) {
    return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(token)}(?![A-Za-z0-9_])`, 'i').test(text);
  }
  return text.toLowerCase().includes(token.toLowerCase());
}
/** Pick a unique matching profile from title first, then the first two non-empty prompt lines. */
function selectProfileByText(candidates, input) {
  if (!candidates.length) return null;
  const matchText = (text) => candidates.filter((p) => profileMatchTokens(p).some((tok) => tokenMatchesText(text, tok)));
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  if (title) {
    const titleHits = matchText(title);
    if (titleHits.length === 1) return titleHits[0];
    if (titleHits.length > 1) return null;
  }
  const prompt = typeof input?.initialPrompt === 'string' ? input.initialPrompt : '';
  const intro = prompt.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 2).join('\n');
  if (intro) {
    const introHits = matchText(intro);
    if (introHits.length === 1) return introHits[0];
  }
  return null;
}
/** Resolve a role name, Chinese alias, or profile ID into its live provider/model and settings. */
function resolvedRoleProvider(input, profiles, { profileIdOf, profilePair }) {
  if (!isPlainObject(input)) return null;
  const raw = typeof input.provider === 'string' ? input.provider.trim() : '';
  if (!raw || raw.includes('/')) return null;
  const key = raw.toLowerCase();
  const mappedId = profileIdOf(key).toLowerCase();
  const hits = profiles.filter((p) => {
    if (!profilePair(p)) return false;
    const pid = typeof p.id === 'string' ? p.id.trim().toLowerCase() : '';
    const pname = typeof p.name === 'string' ? p.name.trim().toLowerCase() : '';
    const lead = pname ? pname.split(/[\s（(]/)[0].trim() : '';
    if (pid && (pid === key || pid === mappedId)) return true;
    if (pname && (pname === key || lead === key)) return true;
    return profileMatchTokens(p).some((tok) => tok.toLowerCase() === key);
  });
  if (hits.length !== 1) return null;
  const hit = hits[0];
  const next = { ...input, provider: profilePair(hit) };
  delete next.model;
  const nested = isPlainObject(input.settings) ? input.settings : null;
  const nextSettings = nested ? { ...nested } : {};
  if (!nested) {
    for (const field of SETTINGS) {
      if (field in input) {
        nextSettings[field] = input[field];
        delete next[field];
      }
    }
  }
  delete nextSettings.model;
  if (typeof hit.modeId === 'string' && hit.modeId && isUnset('modeId', nextSettings.modeId)) {
    nextSettings.modeId = hit.modeId;
  }
  if (typeof hit.thinkingOptionId === 'string' && hit.thinkingOptionId && nextSettings.thinkingOptionId === undefined) {
    nextSettings.thinkingOptionId = hit.thinkingOptionId;
  }
  const hitFeatures = profileFeaturesOf(hit);
  if (hitFeatures && nextSettings.features === undefined) {
    nextSettings.features = hitFeatures;
  }
  if (Object.keys(nextSettings).length > 0) next.settings = nextSettings;
  else delete next.settings;
  return { updated: next, matchedProfile: hit };
}
/** Rewrite a bare provider only when model is explicit or one profile matches title/intro unambiguously. */
function resolvedBareProvider(input, profiles, profilePair) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  if (!provider || provider.includes('/')) return null;
  const nested = input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings) ? input.settings : null;
  const topModel = typeof input.model === 'string' ? input.model.trim() : '';
  const nestedModel = typeof nested?.model === 'string' ? nested.model.trim() : '';
  if (topModel && nestedModel && topModel.toLowerCase() !== nestedModel.toLowerCase()) return null;
  const explicitModel = topModel || nestedModel;
  if (explicitModel) {
    const targetPair = `${provider}/${explicitModel}`;
    const matched = profiles.find((p) => profilePair(p)?.toLowerCase() === targetPair.toLowerCase());
    if (profiles.length > 0 && !matched) return null;
    const next = { ...input, provider: matched ? profilePair(matched) : targetPair };
    delete next.model;
    if (nested && 'model' in nested) {
      const nextSettings = { ...nested };
      delete nextSettings.model;
      if (Object.keys(nextSettings).length > 0) next.settings = nextSettings;
      else delete next.settings;
    }
    return next;
  }
  const candidates = profiles.filter(
    (p) => typeof p?.provider === 'string' && p.provider.trim().toLowerCase() === provider.toLowerCase() && profilePair(p),
  );
  const hit = selectProfileByText(candidates, input);
  return hit ? { ...input, provider: profilePair(hit) } : null;
}
/** A bare provider ("claude") is ambiguous across profiles, so it cannot be rewritten; name the valid pairs. */
function bareProviderReason(input, profiles, profilePair) {
  const provider = typeof input?.provider === 'string' ? input.provider.trim() : '';
  if (!provider || provider.includes('/')) return null;
  const pairs = profiles.map((p) => profilePair(p) && `${String(p.name ?? p.id).split(/\s/)[0]}=${profilePair(p)}`).filter(Boolean);
  return `create_agent provider must be a role name or "<profile.provider>/<profile.model>", not "${provider}".`
    + (pairs.length ? ` Current profiles: ${pairs.join(', ')}.` : '');
}
const SETTINGS = ['modeId', 'thinkingOptionId', 'features'];
const isPlainObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const canonical = (value) => JSON.stringify(value, (_, v) => (isPlainObject(v)
  ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v));
const sameValue = (left, right) => canonical(left) === canonical(right);
// Empty `features` map `{}` carries zero flag overrides, semantically identical to null/undefined.
const isUnset = (field, value) => value === undefined || value === null
  || (field === 'features' && isPlainObject(value) && Object.keys(value).length === 0);
const profileFeaturesOf = (profile) => (!isUnset('features', profile?.featureValues)
  ? profile.featureValues
  : (!isUnset('features', profile?.features) ? profile.features : undefined));
const profileFieldValue = (profile, field) => (field === 'features' ? profileFeaturesOf(profile) : profile?.[field]);

/**
 * Align create_agent settings with the target Paseo profile(s) automatically instead of denying
 * stale or omitted fields. Only deny when multiple conflicting profiles share the pair, the title
 * does not disambiguate them, and a caller-supplied value matches none of the candidates.
 */
function reconciledAgentSettings(input, profiles, pinnedProfile = null, profilePair = (p) => (p?.provider && p?.model ? `${p.provider}/${p.model}` : null)) {
  if (!isPlainObject(input)) return { updated: null, denyReason: null };
  const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  if (!provider.includes('/')) return { updated: null, denyReason: null };
  const matches = profiles.filter((profile) => profilePair(profile) === provider);
  if (!matches.length) return { updated: null, denyReason: null };

  const textHit = pinnedProfile || (matches.length > 1 ? selectProfileByText(matches, input) : null);
  const targets = textHit ? [textHit] : matches;
  const nested = isPlainObject(input.settings) ? input.settings : null;
  const hasKey = (field) => (nested ? field in nested : field in input);
  const valueOf = (field) => (nested ? nested[field] : input[field]);
  const agreesValue = (profile, field, val) => {
    const pVal = profileFieldValue(profile, field);
    return isUnset(field, pVal) ? isUnset(field, val) : sameValue(pVal, val);
  };
  const agrees = (profile, field) => agreesValue(profile, field, valueOf(field));

  // Distinct canonical definitions across `targets` for a given field.
  const distinctDefs = (field) => {
    const map = new Map();
    for (const profile of targets) {
      const pVal = profileFieldValue(profile, field);
      if (isUnset(field, pVal)) map.set('__unset__', { set: false, value: undefined });
      else map.set(canonical(pVal), { set: true, value: pVal });
    }
    return [...map.values()];
  };

  const modeDefs = distinctDefs('modeId');
  const definedModes = modeDefs.filter((d) => d.set);
  const needsModeFill = isUnset('modeId', valueOf('modeId')) && definedModes.length === 1;
  const stated = SETTINGS.filter((field) => valueOf(field) !== undefined);
  if (!needsModeFill && (!stated.length || targets.some((profile) => stated.every((field) => agrees(profile, field))))) {
    return { updated: null, denyReason: null };
  }

  const nextSettings = nested ? { ...nested } : {};
  if (!nested) {
    for (const field of SETTINGS) {
      if (field in input) nextSettings[field] = input[field];
    }
  }
  const next = { ...input };
  let changed = false;
  const role = (profile) => String(profile.name ?? profile.id ?? provider).split(/\s/)[0];
  const formatSetting = (val) => (val === undefined ? 'none' : JSON.stringify(val));

  for (const field of SETTINGS) {
    const defs = distinctDefs(field);
    const val = valueOf(field);
    if (field === 'modeId' && definedModes.length === 1 && (isUnset(field, val) || !sameValue(val, definedModes[0].value))) {
      nextSettings[field] = definedModes[0].value;
      if (!nested) delete next[field];
      changed = true;
      continue;
    }
    if (defs.length === 1) {
      const def = defs[0];
      if (!def.set) {
        // Profile leaves this setting unset: strip any non-unset override instead of denying.
        if (hasKey(field) && !isUnset(field, val)) {
          delete nextSettings[field];
          if (!nested) delete next[field];
          changed = true;
        }
      } else if (val !== undefined && !sameValue(val, def.value)) {
        nextSettings[field] = def.value;
        if (!nested) delete next[field];
        changed = true;
      }
      continue;
    }

    // Multiple profiles disagree on this field: keep valid matches, deny only invalid overrides.
    if (val === undefined || targets.some((profile) => agrees(profile, field))) continue;
    const candidates = targets
      .map((profile) => `${role(profile)} (${provider}) sets ${field} ${formatSetting(profileFieldValue(profile, field))}`)
      .join('; ');
    return {
      updated: null,
      denyReason: `create_agent ${field} ${JSON.stringify(val)} matches no profile for ${provider}. Candidates: ${candidates}.`,
    };
  }

  // Prevent mixing values from incompatible conflicting profiles across caller-stated fields.
  if (targets.length > 1 && stated.length > 1 && !targets.some((profile) => stated.every((field) => agreesValue(profile, field, nextSettings[field])))) {
    const candidates = targets
      .map((profile) => `${role(profile)} (${provider}): ${SETTINGS.map((f) => `${f}=${formatSetting(profileFieldValue(profile, f))}`).join(', ')}`)
      .join('; ');
    return {
      updated: null,
      denyReason: `create_agent settings combine values from incompatible profiles for ${provider}. Candidates: ${candidates}.`,
    };
  }

  if (!changed) return { updated: null, denyReason: null };
  if (Object.keys(nextSettings).length > 0) next.settings = nextSettings;
  else delete next.settings;
  return { updated: next, denyReason: null };
}

/** The planner and merge gate find pipeline agents by this label; an unlabelled one is invisible and gets re-dispatched. */
const hasChangeLabel = (input) => {
  const change = input?.labels?.['pipeline.change'];
  return typeof change === 'string' && !!change.trim();
};
function liveChanges(cwd, repoContext) {
  const ctx = typeof cwd === 'string' && cwd ? repoContext(cwd) : null;
  if (!ctx) return [];
  try {
    return fs.readdirSync(path.join(ctx.root, 'openspec', 'changes'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'archive').map((entry) => entry.name);
  } catch { return []; }
}
/** Fill pipeline.change only when exactly one live change is named by the title (its last token, per DISPATCH) or, failing that, by `openspec/changes/<name>` paths in the prompt. */
function inferredChange(input, cwd, repoContext) {
  const live = liveChanges(cwd, repoContext);
  if (!live.length) return null;
  const tokens = new Set(String(input.title).trim().split(/\s+/));
  let hits = live.filter((name) => tokens.has(name));
  if (!hits.length && typeof input.initialPrompt === 'string') {
    hits = live.filter((name) => input.initialPrompt.includes(`openspec/changes/${name}/`) || input.initialPrompt.includes(`pipeline.change=${name}`));
  }
  return hits.length === 1 ? hits[0] : null;
}
function withPipelineLabel(input, cwd, repoContext) {
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  if (!title.startsWith('[Pipeline]') || hasChangeLabel(input)) return null;
  const change = inferredChange({ ...input, title }, cwd, repoContext);
  if (!change) return null;
  const labels = input.labels && typeof input.labels === 'object' && !Array.isArray(input.labels) ? input.labels : {};
  return { ...input, labels: { ...labels, 'pipeline.change': change } };
}
function pipelineLabelReason(input) {
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  if (!title.startsWith('[Pipeline]') || hasChangeLabel(input)) return null;
  return 'A "[Pipeline]" agent needs labels: { "pipeline.change": "<change>" } (the openspec change name); without it `pipeline-run.mjs plan` cannot see the agent and dispatches the task again. The hook could not infer one unambiguously. Copy title and labels from the plan\'s DISPATCH line.';
}
const STRICT_READ_ONLY_MODES = new Set(['plan', 'read-only']);
const WRITE_MODES = new Set(['auto', 'accept-edits', 'acceptedits', 'bypasspermissions', 'full-access']);
const READ_ONLY_TITLE_RE = /(?:^|\b)(?:review|tier2-review|r0|final|recon|audit)(?:\b|$)|审查|按察司|中书/i;
const WRITE_TITLE_RE = /(?:^|\b)(?:handoff|implement|fix|refactor|migrate|feat|patch)(?:\b|$)|工部|刑部|兵部/i;
/** True when create_agent dispatches a read-only observer rather than a workspace writer; ROLES overrides provider-specific modeId names. */
function isReadOnlyAgentCall(input, pinnedProfile, profiles, { ROLES, profileIdOf, profilePair }) {
  let prof = pinnedProfile;
  if (!prof && typeof input?.provider === 'string' && Array.isArray(profiles)) {
    const matches = profiles.filter((p) => profilePair(p) === input.provider);
    if (matches.length === 1) prof = matches[0];
    else if (matches.length > 1) prof = selectProfileByText(matches, input);
  }
  if (prof) {
    const pid = typeof prof.id === 'string' ? prof.id.trim().toLowerCase() : '';
    const wrIds = new Set(Object.entries(ROLES).filter(([, m]) => m.isWriter).map(([k]) => profileIdOf(k).toLowerCase()));
    const roIds = new Set(Object.entries(ROLES).filter(([, m]) => !m.isWriter).map(([k]) => profileIdOf(k).toLowerCase()));
    if (pid && wrIds.has(pid)) return false;
    if (pid && roIds.has(pid)) return true;
  }
  const modeId = String(input?.settings?.modeId ?? input?.modeId ?? prof?.modeId ?? '').trim().toLowerCase();
  if (STRICT_READ_ONLY_MODES.has(modeId)) return true;
  if (WRITE_MODES.has(modeId)) return false;
  const title = typeof input?.title === 'string' ? input.title : '';
  if (READ_ONLY_TITLE_RE.test(title) && !WRITE_TITLE_RE.test(title)) return true;
  return false;
}
const output = (fields) => console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...fields } }));
const deny = (reason, reasonCode = 'denied', recordEvent = () => {}) => {
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

function repeatedFailures(file, name, input, rewritten = null) {
  const calls = loadTranscriptCalls(file);
  const candidates = new Set([canonical(input)]);
  if (rewritten !== null) candidates.add(canonical(rewritten));
  return calls.length >= 3 && calls.slice(-3).every((call) => call.name === name && candidates.has(call.input) && call.result === true);
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

function primaryRootForWorktree(cwd, repoContext, runGit) {
  if (typeof cwd !== 'string' || !cwd) return null;
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
  return primaryRoot === ctx.root ? null : { ctx, primaryRoot };
}

function targetsPrimary(cwd, ctx, primaryRoot, command, regex, skipDash = false) {
  for (const match of command.matchAll(regex)) {
    const rawTarget = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!rawTarget || rawTarget.startsWith('$') || (skipDash && rawTarget === '-')) continue;
    let expandedTarget = rawTarget;
    if (rawTarget === '~' || rawTarget.startsWith('~/')) {
      expandedTarget = rawTarget === '~' ? os.homedir() : path.join(os.homedir(), rawTarget.slice(2));
    } else if (rawTarget.startsWith('~')) {
      continue;
    }
    const resolved = realOrResolved(path.isAbsolute(expandedTarget) ? expandedTarget : path.resolve(cwd, expandedTarget));
    if (inside(primaryRoot, resolved) && !inside(ctx.root, resolved)) return true;
  }
  return false;
}

function primaryCheckoutWarning(cwd, command, repoContext, runGit) {
  const hasCd = /\bcd\b/.test(command);
  const hasGitC = /\bgit\b[^;&|\n]*\s-C\s/.test(command);
  if (!hasCd && !hasGitC) return null;
  const info = primaryRootForWorktree(cwd, repoContext, runGit);
  if (!info) return null;
  const { ctx, primaryRoot } = info;

  if (hasCd && targetsPrimary(cwd, ctx, primaryRoot, command, /(?:^|[;&|(\s])cd\s+(?:-P\s+|-L\s+)?(?:"([^"\n]+)"|'([^'\n]+)'|([^\s;&|()]+))/g, true)) {
    return `You are in a linked worktree (${ctx.root}); avoid \`cd\` into the shared primary checkout (${primaryRoot}). Use absolute paths for reads, or call \`ExitWorktree\` (\`action: "keep"\`) before running git writes in the primary checkout.`;
  }
  if (hasGitC && targetsPrimary(cwd, ctx, primaryRoot, command, /(?:^|[;&|(\s])git\s+(?:[^\n;&|]*?\s)?-C\s+(?:"([^"\n]+)"|'([^'\n]+)'|([^\s;&|()]+))/g)) {
    return `Avoid \`git -C\` mutating the primary checkout (${primaryRoot}) from a worktree. Call \`ExitWorktree\` (\`action: "keep"\`) first to return to ${primaryRoot} (or if \`ExitWorktree\` is no-op, keep primary access read-only or delegate writes to a Paseo agent rooted there).`;
  }
  return null;
}

function builtinAgentReviewReason(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const subType = typeof input.subagent_type === 'string' ? input.subagent_type.trim() : '';
  const desc = typeof input.description === 'string' ? input.description : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const subHit = /^(?:code-review(?:er)?|contract-review(?:er)?|reviewer|review)$/i.test(subType);
  const descHit = /(?:independent\s+(?:tier\s*2\s*|code\s+|contract\s+)?review(?:er)?|tier\s*2\s*(?:independent\s*)?review|code\s+review(?:er)?|contract\s+review(?:er)?|独立评审|独立审查|异构审查|契约审查|代码审查)/i.test(desc);
  const promptIntent = /(?:independent\s+(?:tier\s*2\s*|code\s+|contract\s+)?review(?:er)?|独立评审|独立审查|异构审查|tier\s*2\s*reviewer\s*brief)/i.test(prompt);
  const promptVerdict = /(?:\bPASS\b|\bBLOCKED\b|\bverdict\b|只评审|不改代码|read-only)/i.test(prompt);
  if (!subHit && !descHit && !(promptIntent && promptVerdict)) return null;
  return [
    'Do NOT use the built-in Agent tool for independent code/contract review: it inherits the calling model family and blocks the main context.',
    'Dispatch an external heterogeneous reviewer via mcp__paseo__create_agent (call list_profiles to pick anchasi / 审查（按察司）, assemble brief via `pipeline-run.mjs brief tier2-review`), OR return the `tier2-verify` / `risk-scan` evidence directly to the user for human decision.',
  ].join(' ');
}

async function main() {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch { return; }
  const name = payload?.tool_name;
  const input = payload?.tool_input;
  if (name === 'Agent') {
    const reviewReason = builtinAgentReviewReason(input);
    if (reviewReason) {
      const { recordEvent } = await import('../lib/telemetry.mjs');
      deny(reviewReason, 'builtin_agent_review', recordEvent);
    }
    return;
  }
  if (name === 'Bash' && typeof input?.command === 'string') {
    const command = input.command;
    const needsPaseoWait = /\bpaseo\s+(?:run|send)\b/.test(command) && !/(?:^|\s)--wait(?:\s|=|$)/.test(command) && !/\bpaseo\s+wait\b/.test(command);
    const hasCdOrGitC = /\bcd\b/.test(command) || /\bgit\b[^;&|\n]*\s-C\s/.test(command);
    if (!needsPaseoWait && !hasCdOrGitC) return;

    const contexts = [];
    let recordEventFn = null;
    if (needsPaseoWait) {
      ({ recordEvent: recordEventFn } = await import('../lib/telemetry.mjs'));
      recordEventFn('tool_guard', { action: 'advise', reasonCode: 'paseo_cli_wait' });
      contexts.push('CLI dispatch registers no completion callback; ending this turn will not wake the parent. Use MCP create_agent, or immediately start paseo wait <id> --timeout 540 in the background.');
    }
    if (hasCdOrGitC) {
      const [{ repoContext }, { runGit }] = await Promise.all([
        import('../lib/tier-gate.mjs'),
        import('../lib/git.mjs'),
      ]);
      const cdWarn = primaryCheckoutWarning(payload?.cwd, command, repoContext, runGit);
      if (cdWarn) {
        if (!recordEventFn) ({ recordEvent: recordEventFn } = await import('../lib/telemetry.mjs'));
        recordEventFn('tool_guard', { action: 'advise', reasonCode: 'worktree_cd_primary' });
        contexts.push(cdWarn);
      }
    }
    if (contexts.length) output({ additionalContext: contexts.join('\n') });
    return;
  }
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return;
  const { recordEvent } = await import('../lib/telemetry.mjs');
  let updated = input;
  let changed = false;
  if (name.startsWith('mcp__paseo__')) {
    const [{ paseoHome, loadProfiles, profilePair }, { ROLES, profileIdOf }, { repoContext }] = await Promise.all([
      import('../lib/paseo.mjs'),
      import('../lib/roles.mjs'),
      import('../lib/tier-gate.mjs'),
    ]);
    const isObject = isPlainObject(updated);
    if (isObject && (isPlaceholderServerId(updated.serverId) || isTypoOfLocal(updated.serverId, localServerId(paseoHome)))) {
      updated = { ...updated };
      delete updated.serverId;
      changed = true;
    }
    const sanitized = sanitizedPaseoInput(name, updated);
    if (sanitized) {
      updated = sanitized;
      changed = true;
    }
    if (isObject && name === 'mcp__paseo__create_agent') {
      const profiles = loadProfiles();
      let pinnedProfile = null;
      const roleMatch = resolvedRoleProvider(updated, profiles, { profileIdOf, profilePair });
      if (roleMatch) {
        updated = roleMatch.updated;
        pinnedProfile = roleMatch.matchedProfile;
        changed = true;
      }
      const resolvedProvider = resolvedBareProvider(updated, profiles, profilePair);
      if (resolvedProvider) {
        updated = resolvedProvider;
        changed = true;
      }
      const bare = bareProviderReason(updated, profiles, profilePair);
      if (bare) { deny(bare, 'bare_provider', recordEvent); return; }
      const { updated: reconciled, denyReason } = reconciledAgentSettings(updated, profiles, pinnedProfile, profilePair);
      if (denyReason) { deny(denyReason, 'settings_mismatch', recordEvent); return; }
      if (reconciled) {
        updated = reconciled;
        changed = true;
      }
      const labelled = withPipelineLabel(updated, payload?.cwd, repoContext);
      if (labelled) {
        updated = labelled;
        changed = true;
      }
      const unlabelled = pipelineLabelReason(updated);
      if (unlabelled) { deny(unlabelled, 'missing_pipeline_label', recordEvent); return; }
      const agent = sanitizedCreateAgent(updated);
      if (agent) {
        updated = agent;
        changed = true;
      }
      const cwdCtx = typeof payload?.cwd === 'string' && payload.cwd ? repoContext(payload.cwd) : null;
      const hasWorkspaceId = typeof updated.workspaceId === 'string' && updated.workspaceId.trim().length > 0;
      if (cwdCtx && !cwdCtx.isPrimary && !hasWorkspaceId && !isReadOnlyAgentCall(updated, pinnedProfile, profiles, { ROLES, profileIdOf, profilePair })) {
        deny([
          `You are running inside linked worktree (${cwdCtx.root}), but create_agent omitted a valid workspaceId.`,
          'Without workspaceId, Paseo spawns the child agent in the caller primary checkout instead of this worktree.',
          `Call mcp__paseo__create_workspace({ path: "${cwdCtx.root}", isolation: "local" }) (or find it via mcp__paseo__list_workspaces) first, then pass its workspaceId to create_agent.`,
        ].join(' '), 'worktree_missing_workspace_id', recordEvent);
        return;
      }
    }
  }
  if (repeatedFailures(payload.transcript_path, name, input, changed ? updated : null)) {
    deny(repeatedFailureReason(name), 'repeated_failure', recordEvent);
    return;
  }
  if (changed) {
    recordEvent('tool_guard', { action: 'rewrite', reasonCode: name === 'mcp__paseo__create_workspace' ? 'sanitize_workspace' : 'sanitize_paseo' });
    output({ permissionDecision: 'allow', updatedInput: updated });
    return;
  }
}

try { await main(); } catch (err) {
  const { logHookError } = await import('../lib/tier-gate.mjs');
  logHookError('tool-guard-hook', err);
}
