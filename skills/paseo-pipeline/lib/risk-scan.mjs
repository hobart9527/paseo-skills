// Deterministic diff scanner for Tier 1/2/3 delivery gates.
// Prevents subjective `Risk: none` escapes and silent test-oracle weakening by checking
// actual changed files and diff hunks against the 5 named risk classes + test mutations.
import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './git.mjs';
import { DEFAULT_LIMIT, EXEMPT, UNCOUNTED, FIXTURE_DIR, isTestPath, scopeKey } from './paths.mjs';

export const RISK_CLASSES = ['auth', 'concurrency', 'persistence', 'money', 'external-write'];

const PATH_RULES = [
  {
    riskClass: 'auth',
    pattern: /(?:^|\/)(?:auth|authn|authz|session|oauth|jwt|rbac|acl|permission|permissions|security|crypto|credential|credentials|token|tokens)(?:[\/._-]|$)/i,
    reason: 'path touches auth/security surface',
  },
  {
    riskClass: 'concurrency',
    pattern: /(?:^|\/)(?:lock|locks|mutex|semaphore|lease|leases|queue|queues|worker|workers|idempoten\w*|concurrent\w*|scheduler)(?:[\/._-]|$)/i,
    reason: 'path touches concurrency/idempotency surface',
  },
  {
    riskClass: 'persistence',
    pattern: /(?:^|\/)(?:migrations?|schema|prisma|drizzle|db|database|sqlite|postgres|mysql|redis|repositories)(?:[\/._-]|$)|\.(?:sql|prisma)$/i,
    reason: 'path touches persistence/schema surface',
  },
  {
    riskClass: 'money',
    pattern: /(?:^|\/)(?:money|pay|payment|payments|billing|invoice|invoices|tax|taxes|settlement|refund|refunds|ledger|balance|pricing|price|payout|payouts|reconcil\w*|fee|fees)(?:[\/._-]|$)/i,
    reason: 'path touches money/billing/settlement surface',
  },
  {
    riskClass: 'external-write',
    pattern: /(?:^|\/)(?:webhook|webhooks|mailer|smtp|sms|kingdee|external|gateway|notifier)(?:[\/._-]|$)/i,
    reason: 'path touches external-write integration surface',
  },
];

const HUNK_RULES = [
  {
    riskClass: 'auth',
    pattern: /\b(?:jwt|oauth|rbac|acl|bearer|sessionId|checkPermission|hasPermission|authorize|authenticate|bcrypt|argon2|pbkdf2|hmac|timingSafeEqual|setCookie|httpOnly|sameSite|verifySignature|isAdmin)\b/i,
    reason: 'diff touches auth/security primitive',
  },
  {
    riskClass: 'concurrency',
    pattern: /\b(?:idempotency|idempotent|mutex|semaphore|acquireLock|releaseLock|for\s+update|isolationLevel|BEGIN\s+TRANSACTION|Promise\.race|Atomics\.|dedup\w*|leaseId|optimisticLock)\b/i,
    reason: 'diff touches concurrency/idempotency primitive',
  },
  {
    riskClass: 'persistence',
    pattern: /\b(?:CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|ADD\s+COLUMN|DROP\s+COLUMN|CREATE\s+(?:UNIQUE\s+)?INDEX|PRAGMA\s+|INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+\w+\s+SET)\b/i,
    reason: 'diff touches database schema or persistence mutation',
  },
  {
    riskClass: 'money',
    pattern: /\b(?:currency|cents|amountCents|taxAmount|taxRate|netAmount|grossAmount|invoiceAmount|settlement|refund|payout|ledger|debit|credit|roundHalf)\b/i,
    reason: 'diff touches monetary calculation or settlement semantics',
  },
  {
    riskClass: 'external-write',
    pattern: /(?:fetch\s*\([^)]*method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]|\baxios\.(?:post|put|patch|delete)\b|\.sendMail\b|\b(?:dispatchExternal|pushToRemote)\b)/i,
    reason: 'diff performs external write or mutating HTTP call',
  },
];

const TEST_REMOVED_ASSERTION = /\b(?:assert|expect|should|rejects|throws|doesNotThrow|deepEqual|strictEqual|equal|match|toBe|toEqual|toThrow|toMatch)\b|\.(?:skip|todo|only)\b/;
const TEST_SKIP_ADDED = /\b(?:test|it|describe)\.(?:skip|todo|only)\b|@?(?:pytest\.mark\.(?:skip|xfail)|unittest\.skip)\b/;
const DOC_OR_PROMPT_PATH = /(?:^|\/)(?:SKILL\.md|README\.md|CLAUDE\.md|task-routing\.md|(?:docs|templates)\/.*\.md)$/i;
const DOC_CAVEAT_TERM = /\b(?:never|must not|do not|cannot|not\s+(?:an?|only|independence|sandbox|self)|read-only|refuse|block(?:ed)?|unverified|forbidden|prohibited|caveat)\b/gi;

export const isTestFile = isTestPath;

/** Parse `git diff --name-status -z` output into `{ status, file, from? }` entries. */
export function parseNameStatusZ(raw) {
  const tokens = String(raw || '').split('\0').filter((t) => t.length > 0);
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const code = tokens[i];
    const kind = code[0];
    if (kind === 'R' || kind === 'C') {
      const from = tokens[++i];
      const to = tokens[++i];
      if (to) out.push({ status: kind, file: to, from });
    } else {
      const file = tokens[++i];
      if (file) out.push({ status: kind, file });
    }
  }
  return out;
}

/** Parse unified `git diff -U0` into per-file `{ added: string[], removed: string[] }`. */
export function parseUnifiedDiff(diffText) {
  const byFile = new Map();
  let current = null;
  let fromPath = null;
  let inHunk = false;
  for (const line of String(diffText || '').split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      current = null;
      fromPath = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith('--- ')) {
      const src = line.slice(4).trim();
      fromPath = src === '/dev/null' ? null : (src.startsWith('a/') ? src.slice(2) : src);
      if (fromPath && !current) {
        if (!byFile.has(fromPath)) byFile.set(fromPath, { added: [], removed: [] });
        current = byFile.get(fromPath);
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      const rel = target === '/dev/null' ? fromPath : (target.startsWith('b/') ? target.slice(2) : target);
      if (rel) {
        if (!byFile.has(rel)) byFile.set(rel, { added: [], removed: [] });
        current = byFile.get(rel);
      } else {
        current = null;
      }
      inHunk = false;
      continue;
    }
    if (line.startsWith('@@ ')) {
      inHunk = true;
      continue;
    }
    if (!inHunk || !current) continue;
    if (line.startsWith('+')) current.added.push(line.slice(1));
    else if (line.startsWith('-')) current.removed.push(line.slice(1));
  }
  return byFile;
}

/**
 * Pure scanner over normalized `{ entries, diffText, untrackedContents }`.
 * Docs/openspec/test files are excluded from source-file risk classes (tests have dedicated oracle checks).
 */
export function scanChanges({ entries = [], diffText = '', untrackedContents = new Map() } = {}) {
  const hunks = parseUnifiedDiff(diffText);
  const hits = [];
  const testMutations = [];
  const caveatRemovals = [];
  const sourceFiles = [];
  const seenHits = new Set();

  const recordHit = (riskClass, file, reason) => {
    const key = `${riskClass}:${file}:${reason}`;
    if (seenHits.has(key)) return;
    seenHits.add(key);
    hits.push({ class: riskClass, file, reason });
  };

  for (const entry of entries) {
    const file = String(entry.file || '').replace(/\\/g, '/');
    if (!file) continue;

    if (!EXEMPT(file)) sourceFiles.push(file);

    if (isTestFile(file)) {
      if (entry.status === 'D' || entry.status === 'R') {
        testMutations.push({ file, reason: `existing test file ${entry.status === 'D' ? 'deleted' : 'renamed'}` });
      } else if (entry.status !== 'A' && entry.status !== '?') {
        const fileHunk = hunks.get(file);
        if (fileHunk) {
          if (fileHunk.removed.some((line) => TEST_REMOVED_ASSERTION.test(line))) {
            testMutations.push({ file, reason: 'existing test assertion modified or removed' });
          } else if (FIXTURE_DIR.test(file) && fileHunk.removed.length > 0) {
            testMutations.push({ file, reason: 'existing snapshot/golden fixture modified' });
          }
          if (fileHunk.added.some((line) => TEST_SKIP_ADDED.test(line))) {
            testMutations.push({ file, reason: 'test skipped or isolated via .skip/.todo/.only' });
          }
        }
      }
      continue;
    }

    if (DOC_OR_PROMPT_PATH.test(file) && entry.status !== 'A' && entry.status !== '?') {
      const fileHunk = hunks.get(file);
      if (fileHunk && fileHunk.removed.length) {
        const countTerms = (lines) => {
          const map = new Map();
          for (const line of lines) {
            for (const m of line.matchAll(DOC_CAVEAT_TERM)) {
              const token = m[0].toLowerCase().replace(/\s+/g, ' ');
              map.set(token, (map.get(token) || 0) + 1);
            }
          }
          return map;
        };
        const removedTerms = countTerms(fileHunk.removed);
        const addedTerms = countTerms(fileHunk.added);
        const dropped = [];
        for (const [term, count] of removedTerms) {
          if (count > (addedTerms.get(term) || 0)) dropped.push(term);
        }
        if (dropped.length) {
          caveatRemovals.push({ file, terms: dropped.sort(), reason: `safety/prohibition qualifier removed (${dropped.sort().join(', ')})` });
        }
      }
    }

    if (UNCOUNTED(file) || file === 'openspec' || file.startsWith('openspec/') || file === '.superpowers' || file.startsWith('.superpowers/')) {
      continue;
    }

    for (const rule of PATH_RULES) {
      if (rule.pattern.test(file)) recordHit(rule.riskClass, file, rule.reason);
    }

    const fileHunk = hunks.get(file);
    const changedLines = fileHunk
      ? [...fileHunk.added, ...fileHunk.removed]
      : (untrackedContents.has(file) ? String(untrackedContents.get(file)).split(/\r?\n/) : []);
    for (const line of changedLines) {
      for (const rule of HUNK_RULES) {
        if (rule.pattern.test(line)) recordHit(rule.riskClass, file, rule.reason);
      }
    }
  }

  const uniqueSources = [...new Set(sourceFiles)].sort();
  const scopes = [...new Set(uniqueSources.map(scopeKey))].sort();
  const classes = [...new Set(hits.map((h) => h.class))].sort();
  const reviewRequired = classes.length > 0 || testMutations.length > 0 || caveatRemovals.length > 0;
  const tierRequired = uniqueSources.length > DEFAULT_LIMIT || scopes.length >= 2 ? 2 : 1;

  return {
    reviewRequired,
    tierRequired,
    classes,
    hits,
    testMutations,
    caveatRemovals,
    sourceFiles: uniqueSources,
    scopes,
  };
}

/** Run git diff + untracked scan in `cwd` comparing `base` to `head` (or working tree). */
export function scanRepo({ cwd = process.cwd(), base, head = null, workingTree = false } = {}) {
  if (!base) throw new Error('base ref or SHA is required');
  const rootRes = runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (rootRes.status !== 0) throw new Error(`not a git repository: ${cwd}`);
  const root = rootRes.stdout.trim();

  const verifyBase = runGit(root, ['rev-parse', '--verify', `${base}^{commit}`]);
  if (verifyBase.status !== 0) throw new Error(`invalid base commit: ${base}`);
  const baseSha = verifyBase.stdout.trim();

  let headSha = null;
  const useWorkingTree = workingTree || !head;
  if (head) {
    const verifyHead = runGit(root, ['rev-parse', '--verify', `${head}^{commit}`]);
    if (verifyHead.status !== 0) throw new Error(`invalid head commit: ${head}`);
    headSha = verifyHead.stdout.trim();
  }

  const rangeArgs = useWorkingTree ? [baseSha] : [baseSha, headSha];
  const nameStatus = runGit(root, ['diff', '--name-status', '-z', ...rangeArgs]);
  if (nameStatus.status !== 0) throw new Error(`git diff --name-status failed: ${nameStatus.stderr}`);
  const entries = parseNameStatusZ(nameStatus.stdout);

  const diffOut = runGit(root, ['diff', '-U0', '--no-color', ...rangeArgs], { maxBuffer: 32 * 1024 * 1024 });
  if (diffOut.status !== 0) throw new Error(`git diff failed: ${diffOut.stderr}`);

  const untrackedContents = new Map();
  if (useWorkingTree) {
    const untracked = runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']);
    if (untracked.status === 0) {
      for (const file of untracked.stdout.split('\0').filter(Boolean)) {
        entries.push({ status: '?', file });
        if (!UNCOUNTED(file) && !file.startsWith('openspec/') && !file.startsWith('.superpowers/')) {
          try {
            const full = path.join(root, file);
            if (fs.statSync(full).size <= 512 * 1024) {
              untrackedContents.set(file, fs.readFileSync(full, 'utf8'));
            }
          } catch {
            // Skip unreadable untracked file
          }
        }
      }
    }
  }

  const scan = scanChanges({ entries, diffText: diffOut.stdout, untrackedContents });
  return {
    repo: root,
    base: baseSha,
    head: headSha,
    workingTree: useWorkingTree,
    ...scan,
  };
}
