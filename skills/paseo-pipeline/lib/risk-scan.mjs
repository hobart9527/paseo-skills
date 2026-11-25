// Deterministic diff scanner for Tier 1/2/3 delivery gates.
// Prevents subjective `Risk: none` escapes and silent test-oracle weakening by checking
// actual changed files and diff hunks against the 5 named risk classes + test mutations.
import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './git.mjs';
import { DEFAULT_LIMIT, EXEMPT, UNCOUNTED, FIXTURE_DIR, isTestPath, scopeKey } from './paths.mjs';

export const RISK_CLASSES = ['auth', 'concurrency', 'persistence', 'money', 'external-write'];

const HARD_PATH_RULES = [
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
    pattern: /(?:^|\/)(?:migrations?|schema|prisma|drizzle)(?:[\/._-]|$)|\.(?:sql|prisma)$/i,
    reason: 'path touches schema/migration surface',
  },
  {
    riskClass: 'money',
    pattern: /(?:^|\/)(?:money|billing|tax|taxes|settlement|refund|refunds|ledger|payout|payouts|reconcil\w*)(?:[\/._-]|$)/i,
    reason: 'path touches core billing/settlement surface',
  },
  {
    riskClass: 'external-write',
    pattern: /(?:^|\/)(?:webhook|webhooks|mailer|smtp|sms|kingdee|external|gateway|notifier)(?:[\/._-]|$)/i,
    reason: 'path touches external-write integration surface',
  },
];

const LIGHT_PATH_RULES = [
  {
    riskClass: 'persistence',
    pattern: /(?:^|\/)(?:db|database|sqlite|postgres|mysql|redis|repositories)(?:[\/._-]|$)/i,
    reason: 'path-only persistence layer touch without write/DDL hunk',
  },
  {
    riskClass: 'money',
    pattern: /(?:^|\/)(?:pay|payment|payments|invoice|invoices|balance|pricing|price|fee|fees)(?:[\/._-]|$)/i,
    reason: 'path-only money/invoice domain touch without arithmetic/settlement hunk',
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
const UI_ONLY_PATH = /(?:^|\/)(?:components|pages|views|styles)\/.*\.(?:tsx|jsx|css|scss|less)$/i;
const PASSIVE_DOMAIN_PATH = /(?:^|\/)(?:types?|dtos?|interfaces?|constants?|labels?|i18n|locales)\/.*\.(?:ts|tsx|js|mjs|d\.ts)$|\.(?:d\.ts|dto\.ts|types\.ts)$|(?:^|\/)(?:web|frontend|client|ui)\/src\/(?:hooks|utils|formatters)\/.*\.(?:ts|tsx|js|mjs)$/i;
const UI_PATH_RULE_SKIP = new Set(['money', 'persistence', 'external-write']);
const COMMENT_ONLY_LINE = /^\s*(?:\/\/|\/\*|\*(?:\/|\s|$)|#(?!!))/;
const normalizeAssertionLine = (line) => line
  .replace(/;+\s*$/, '')
  .replace(/['"`]/g, "'")
  .replace(/\s+/g, ' ')
  .replace(/\s*([(),[\]{}:;=])\s*/g, '$1')
  .trim();

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
  const advisoryHits = [];
  const testMutations = [];
  const caveatRemovals = [];
  const sourceFiles = [];
  const untrackedFiles = new Set();
  const seenHits = new Set();
  const seenHardFileClass = new Set();
  const seenAdvisories = new Set();

  const recordHit = (riskClass, file, reason, untracked = false) => {
    seenHardFileClass.add(`${riskClass}:${file}`);
    const key = `${riskClass}:${file}:${reason}`;
    if (seenHits.has(key)) return;
    seenHits.add(key);
    hits.push({ class: riskClass, file, reason, untracked: Boolean(untracked) });
  };

  const recordAdvisory = (riskClass, file, reason, untracked = false) => {
    const key = `${riskClass}:${file}:${reason}`;
    if (seenAdvisories.has(key)) return;
    seenAdvisories.add(key);
    advisoryHits.push({ class: riskClass, file, reason, untracked: Boolean(untracked) });
  };

  for (const entry of entries) {
    const file = String(entry.file || '').replace(/\\/g, '/');
    if (!file) continue;
    const isUntracked = entry.status === '?';
    if (isUntracked) untrackedFiles.add(file);

    if (!EXEMPT(file)) sourceFiles.push(file);

    if (isTestFile(file)) {
      if (entry.status === 'D' || entry.status === 'R') {
        testMutations.push({ file, reason: `existing test file ${entry.status === 'D' ? 'deleted' : 'renamed'}` });
      } else if (entry.status !== 'A' && !isUntracked) {
        const fileHunk = hunks.get(file);
        if (fileHunk) {
          const addedNorm = new Set(
            fileHunk.added.filter((line) => !COMMENT_ONLY_LINE.test(line)).map(normalizeAssertionLine),
          );
          if (fileHunk.removed.some((line) => !COMMENT_ONLY_LINE.test(line)
            && TEST_REMOVED_ASSERTION.test(line)
            && !addedNorm.has(normalizeAssertionLine(line)))) {
            testMutations.push({ file, reason: 'existing test assertion modified or removed' });
          } else if (FIXTURE_DIR.test(file) && fileHunk.removed.length > 0) {
            testMutations.push({ file, reason: 'existing snapshot/golden fixture modified' });
          }
          if (fileHunk.added.some((line) => !COMMENT_ONLY_LINE.test(line) && TEST_SKIP_ADDED.test(line))) {
            testMutations.push({ file, reason: 'test skipped or isolated via .skip/.todo/.only' });
          }
        }
      }
      continue;
    }

    if (DOC_OR_PROMPT_PATH.test(file) && entry.status !== 'A' && !isUntracked) {
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

    const skipDomainPathOnly = UI_ONLY_PATH.test(file) || PASSIVE_DOMAIN_PATH.test(file);
    for (const rule of HARD_PATH_RULES) {
      if (skipDomainPathOnly && UI_PATH_RULE_SKIP.has(rule.riskClass)) continue;
      if (rule.pattern.test(file)) recordHit(rule.riskClass, file, rule.reason, isUntracked);
    }

    const fileHunk = hunks.get(file);
    const changedLines = fileHunk
      ? [...fileHunk.added, ...fileHunk.removed]
      : (untrackedContents.has(file) ? String(untrackedContents.get(file)).split(/\r?\n/) : []);
    for (const line of changedLines) {
      if (COMMENT_ONLY_LINE.test(line)) continue;
      for (const rule of HUNK_RULES) {
        if (rule.pattern.test(line)) recordHit(rule.riskClass, file, rule.reason, isUntracked);
      }
    }

    if (!skipDomainPathOnly) {
      for (const rule of LIGHT_PATH_RULES) {
        if (seenHardFileClass.has(`${rule.riskClass}:${file}`)) continue;
        if (rule.pattern.test(file)) recordAdvisory(rule.riskClass, file, rule.reason, isUntracked);
      }
    }
  }

  const uniqueSources = [...new Set(sourceFiles)].sort();
  const scopes = [...new Set(uniqueSources.map(scopeKey))].sort();
  const classes = [...new Set(hits.map((h) => h.class))].sort();
  const advisoryClasses = [...new Set(advisoryHits.map((h) => h.class))].sort();
  const reviewRequired = classes.length > 0 || testMutations.length > 0 || caveatRemovals.length > 0;
  const tierRequired = uniqueSources.length > DEFAULT_LIMIT || scopes.length >= 2 ? 2 : 1;
  const untrackedOnlyRisk = hits.length > 0
    && hits.every((h) => h.untracked)
    && testMutations.length === 0
    && caveatRemovals.length === 0;

  return {
    reviewRequired,
    tierRequired,
    classes,
    hits,
    advisoryClasses,
    advisoryHits,
    testMutations,
    caveatRemovals,
    sourceFiles: uniqueSources,
    scopes,
    untrackedFiles: [...untrackedFiles].sort(),
    untrackedOnlyRisk,
  };
}

function normalizeScanFilter(files) {
  if (!Array.isArray(files) || !files.length) return null;
  const normalized = files
    .flatMap((item) => String(item || '').split(','))
    .map((p) => p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter(Boolean);
  return normalized.length ? new Set(normalized) : null;
}

/** Run git diff + untracked scan in `cwd` comparing `base` to `head` (or working tree). */
export function scanRepo({ cwd = process.cwd(), base, head = null, workingTree = false, files = null, trackedOnly = false } = {}) {
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

  const fileFilter = normalizeScanFilter(files);
  const matchesFilter = (entry) => !fileFilter
    || fileFilter.has(String(entry.file || '').replace(/\\/g, '/'))
    || (entry.from && fileFilter.has(String(entry.from).replace(/\\/g, '/')));

  let mergeBaseSha = baseSha;
  const mbRes = runGit(root, ['merge-base', baseSha, headSha || 'HEAD']);
  if (mbRes.status === 0 && mbRes.stdout.trim()) {
    mergeBaseSha = mbRes.stdout.trim();
  }

  const rangeArgs = useWorkingTree ? [mergeBaseSha] : [mergeBaseSha, headSha];
  const nameStatus = runGit(root, ['diff', '--name-status', '-z', ...rangeArgs]);
  if (nameStatus.status !== 0) throw new Error(`git diff --name-status failed: ${nameStatus.stderr}`);
  const entries = parseNameStatusZ(nameStatus.stdout).filter(matchesFilter);

  const diffOut = runGit(root, ['diff', '-U0', '--no-color', ...rangeArgs], { maxBuffer: 32 * 1024 * 1024 });
  if (diffOut.status !== 0) throw new Error(`git diff failed: ${diffOut.stderr}`);

  const untrackedContents = new Map();
  if (useWorkingTree && !trackedOnly) {
    const untracked = runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']);
    if (untracked.status === 0) {
      for (const file of untracked.stdout.split('\0').filter(Boolean)) {
        const normFile = file.replace(/\\/g, '/');
        if (fileFilter && !fileFilter.has(normFile)) continue;
        entries.push({ status: '?', file: normFile });
        if (!UNCOUNTED(normFile) && !normFile.startsWith('openspec/') && !normFile.startsWith('.superpowers/')) {
          try {
            const full = path.join(root, normFile);
            if (fs.statSync(full).size <= 512 * 1024) {
              untrackedContents.set(normFile, fs.readFileSync(full, 'utf8'));
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
    mergeBase: mergeBaseSha,
    head: headSha,
    workingTree: useWorkingTree,
    trackedOnly: Boolean(trackedOnly),
    ...(fileFilter ? { filteredFiles: [...fileFilter].sort() } : {}),
    ...scan,
  };
}
