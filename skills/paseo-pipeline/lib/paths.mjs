// Single authoritative path & scope classifier for Tier 1/2/3 gates and risk scanning.
// Kept dependency-free (only node:fs / node:path) so both lib/risk-scan.mjs and lib/tier-gate.mjs
// can import it without circular dependencies.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_LIMIT = 3;
export const FIXTURE_DIR = /(?:^|\/)(?:fixtures?|testdata|__snapshots__)(?:\/|$)/i;
export const NON_SUBSTANTIVE_SCOPE = /^(?:openspec\/.*|docs\/.*|[^/]*\.md|run-log\.md)$/i;

const WORKSPACE_ROOTS = new Set(['packages', 'apps', 'services', 'crates', 'skills']);
const SOURCE_TEST_ROOTS = new Set(['src', 'test', 'tests', '__tests__', 'spec', 'e2e']);
const SOURCE_TEST_SCOPE = '(src/test)';

/**
 * Test assets include the common conventions that are not named `*.test.*`:
 * pytest's `test_*.py` / `*_test.py`, Go's `*_test.go`, e2e specs, fixtures,
 * `testdata/` (Go), `__snapshots__/`, and `scripts/specs/`.
 * Contract files under `openspec/**\/specs/*.md` and `docs/specs/*.md` stay outside.
 */
export function isTestPath(file) {
  const value = String(file || '').replace(/\\/g, '/');
  return /(^|\/)(test|tests|__tests__|spec|e2e|fixtures?|testdata|__snapshots__)(\/|$)/i.test(value)
    || /(?:^|\/)scripts\/specs\//i.test(value)
    || /(?:^|\/)test_[^/]*\.py$/i.test(value)
    || /(?:\.|_)(test|spec|e2e)\.[^.]+$/i.test(value);
}

export function isDocPath(file) {
  const normalized = String(file || '').replace(/\\/g, '/');
  const parts = normalized.split('/');
  const base = parts.at(-1) ?? '';
  const ext = path.extname(base).toLowerCase();
  return (parts[0] === 'docs' && parts.length > 1) || ['.md', '.mdx'].includes(ext);
}

export const UNCOUNTED = (rel) => isTestPath(rel) || isDocPath(rel);

export const EXEMPT = (rel) => {
  const normalized = String(rel || '').replace(/\\/g, '/');
  return normalized === 'openspec' || normalized.startsWith('openspec/')
    || normalized === '.superpowers' || normalized.startsWith('.superpowers/')
    || UNCOUNTED(normalized);
};

export const CHURN_EXEMPT = (rel) => {
  const normalized = String(rel || '').replace(/\\/g, '/');
  return normalized === 'openspec' || normalized.startsWith('openspec/')
    || normalized === '.superpowers' || normalized.startsWith('.superpowers/')
    || normalized === 'docs/prototypes' || normalized.startsWith('docs/prototypes/')
    || normalized === 'docs/specs' || normalized.startsWith('docs/specs/');
};

export function isSubstantiveScope(scope) {
  return !NON_SUBSTANTIVE_SCOPE.test(String(scope || '').trim());
}

export function scopeKey(rel) {
  const parts = String(rel || '').replace(/\\/g, '/').split('/');
  if (parts.length > 2 && WORKSPACE_ROOTS.has(parts[0])) return `${parts[0]}/${parts[1]}`;
  if (parts.length > 1 && SOURCE_TEST_ROOTS.has(parts[0])) return SOURCE_TEST_SCOPE;
  return parts.length > 1 ? parts[0] : '.';
}

function workspaceRoots(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && WORKSPACE_ROOTS.has(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function resolveScopedPath(rel, root) {
  const value = String(rel);
  const parts = value.split('/');
  if (parts.length < 2 || WORKSPACE_ROOTS.has(parts[0])) return value;
  const candidates = [];
  for (const top of workspaceRoots(root)) {
    try {
      for (const entry of fs.readdirSync(path.join(root, top), { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(`${top}/${entry.name}`);
      }
    } catch {}
  }
  const hits = candidates.filter((dir) => {
    try { fs.statSync(path.join(root, dir, value)); return true; } catch { return false; }
  });
  return hits.length === 1 ? `${hits[0]}/${value}` : value;
}
