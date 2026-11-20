#!/usr/bin/env node
// Production brief renderer for Tier 2 and Tier 3 roles.
// Renders complete, copy-pasteable prompts from templates + frozen contracts without manual editing.
// Never selects or emits concrete model IDs: callers resolve profiles via `list_profiles`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTasks, isTestPath } from './lib/tasks.mjs';
import { checklistForSurfaces } from './lib/adversarial.mjs';
import { gitMaybe } from './lib/git.mjs';
import { argValue, positionalArgs } from './lib/cli.mjs';
import { scanRepo } from './lib/risk-scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const ROLES = ['recon', 'author', 'revise', 'r0', 'final', 'tester', 'worker', 'reviewer', 'tier2', 'tier2-review'];
const usage = `Usage: brief.mjs <${ROLES.join('|')}> --change <name> --repo <path> [--task <id>] [--base <sha>] [--goal <text>] [--json]`;

const args = process.argv.slice(2);
const json = args.includes('--json');
const positional = positionalArgs(args, ['change', 'repo', 'task', 'base', 'goal']);
const role = positional[0];
const change = argValue(args, 'change');
const repoArg = argValue(args, 'repo');
const taskId = argValue(args, 'task');
const baseArg = argValue(args, 'base');
const goalArg = argValue(args, 'goal');

if (!role || !repoArg || (!change && !['recon', 'tier2', 'tier2-review'].includes(role))) {
  console.error(usage);
  process.exit(2);
}
if (!ROLES.includes(role)) {
  console.error(`[brief] unknown role "${role}"; expected one of ${ROLES.join(', ')}`);
  process.exit(2);
}

const repo = path.resolve(repoArg);
const templateMap = {
  recon: path.join(HERE, 'templates', 'recon.md'),
  author: path.join(HERE, 'templates', 'author.md'),
  revise: path.join(HERE, 'templates', 'author.md'),
  r0: path.join(HERE, 'templates', 'reviewer.md'),
  final: path.join(HERE, 'templates', 'reviewer.md'),
  reviewer: path.join(HERE, 'templates', 'reviewer.md'),
  tester: path.join(HERE, 'templates', 'tester.md'),
  worker: path.join(HERE, 'templates', 'worker.md'),
  tier2: path.join(REPO_ROOT, 'docs', 'tier2-handoff-brief.md'),
  'tier2-review': path.join(REPO_ROOT, 'docs', 'tier2-reviewer-brief.md'),
};

let template;
try {
  template = fs.readFileSync(templateMap[role], 'utf8');
} catch {
  console.error(`[brief] template not found: ${templateMap[role]}`);
  process.exit(2);
}

// Slice combined reviewer/author templates to the exact active mode so subagents see zero irrelevant rules.
if (role === 'r0') {
  const head = template.slice(0, template.indexOf('## R0'));
  const r0Body = template.slice(template.indexOf('## R0'), template.indexOf('## FINAL'));
  template = `${head.trimEnd()}\n\n${r0Body.trim()}\n`.replace('Mode: `R0 | FINAL`.', 'Mode: `R0`.');
} else if (role === 'final') {
  const head = template.slice(0, template.indexOf('## R0'));
  const finalBody = template.slice(template.indexOf('## FINAL'));
  template = `${head.trimEnd()}\n\n${finalBody.trim()}\n`.replace('Mode: `R0 | FINAL`.', 'Mode: `FINAL`.');
} else if (role === 'author') {
  template = template.replace('Mode: `FULL | REVISE`.', 'Mode: `FULL`.');
} else if (role === 'revise') {
  template = template.replace('Mode: `FULL | REVISE`.', 'Mode: `REVISE`.');
}

const git = (gitArgs, cwd = repo) => gitMaybe(cwd, gitArgs);
const isGit = git(['rev-parse', '--is-inside-work-tree']) === 'true';
const effectiveChange = change || path.basename(repo);
const changeDir = path.join(repo, 'openspec', 'changes', effectiveChange);
const tasksFile = path.join(changeDir, 'tasks.md');
let tasksMarkdown = null;
try { tasksMarkdown = fs.readFileSync(tasksFile, 'utf8'); } catch { tasksMarkdown = null; }

const integrationBranch = `integration/${effectiveChange}`;
const taskBranch = taskId ? `task/${effectiveChange}/${taskId}` : null;

function extraFields(markdown) {
  const out = new Map();
  let current = null;
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const taskLine = line.match(/^\s*[-*]\s*\[[ xX]\]\s+(?:(?:\d+(?:\.\d+)*)\s+)?([A-Za-z][A-Za-z0-9]*-\d+)(?::\s*|\s+)(.*)$/);
    if (taskLine) { current = taskLine[1]; out.set(current, {}); continue; }
    const field = line.match(/^\s+[-*]\s+([^:]+):\s*(.*)$/);
    if (!field) { if (current && /^\s*[^#\s]/.test(line)) current = null; continue; }
    if (!current) continue;
    const key = field[1].trim().toLowerCase();
    const value = field[2].trim();
    const entry = out.get(current);
    if (['depends on', 'write scope', 'verify with', 'scen', 'scenarios', 'review', 'done'].includes(key)) continue;
    entry[key] = value;
  }
  return out;
}

const extras = extraFields(tasksMarkdown);
const parsed = tasksMarkdown ? parseTasks(tasksMarkdown) : { tasks: [], errors: [] };
const task = taskId ? parsed.tasks.find((item) => item.id === taskId) : null;
if (taskId && !task) {
  console.error(`[brief] unknown task ${taskId} in ${path.relative(repo, tasksFile)}`);
  process.exit(2);
}

function worktreeFor(branch) {
  if (!isGit) return null;
  const out = git(['worktree', 'list', '--porcelain']);
  if (!out) return null;
  for (const block of out.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const branchLine = lines.find((line) => line.startsWith('branch '));
    if (branchLine?.slice('branch '.length) === `refs/heads/${branch}`) {
      const worktreeLine = lines.find((line) => line.startsWith('worktree '));
      return worktreeLine ? worktreeLine.slice('worktree '.length) : null;
    }
  }
  return null;
}

const integrationWorktree = worktreeFor(integrationBranch)
  || (isGit && git(['branch', '--show-current']) === integrationBranch ? repo : repo);
const taskWorktree = taskBranch ? worktreeFor(taskBranch) : null;

function resolveBase() {
  if (baseArg) return isGit ? git(['rev-parse', '--verify', '--quiet', `${baseArg}^{commit}`]) : null;
  if (!isGit) return null;
  const candidates = [taskBranch, 'HEAD'].filter(Boolean);
  for (const ref of candidates) {
    const refSha = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    const integrationSha = git(['rev-parse', '--verify', '--quiet', `refs/heads/${integrationBranch}^{commit}`]);
    if (refSha && integrationSha) {
      const base = git(['merge-base', refSha, integrationSha]);
      if (base) return base;
    }
  }
  return git(['log', '-1', '--format=%H', '--', path.relative(repo, changeDir)]) || git(['rev-parse', '--verify', '--quiet', 'HEAD']);
}

const base = resolveBase();

function contractPaths() {
  if (!fs.existsSync(changeDir)) return null;
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(repo, full));
    }
  };
  walk(changeDir);
  return files.sort();
}

const testPaths = task ? task.scope.filter(isTestPath) : [];
const scopeList = task ? task.scope : [];
const dependencyStates = task
  ? task.depends.map((dep) => {
    const parent = parsed.tasks.find((item) => item.id === dep);
    return { id: dep, done: parent?.done ? `yes (source=${parent.done.source} review=${parent.done.review})` : 'no' };
  })
  : [];

function forbiddenPaths() {
  if (!task) return [];
  const own = new Set(scopeList);
  const other = new Set();
  for (const item of parsed.tasks) {
    if (item.id === task.id) continue;
    for (const scope of item.scope) if (!own.has(scope)) other.add(scope);
  }
  const out = [...other].sort();
  if (fs.existsSync(changeDir)) out.unshift(`${path.relative(repo, changeDir)}/ (frozen contract: read-only for every child)`);
  return out;
}

const values = {
  change: effectiveChange,
  'question / change-id': goalArg || effectiveChange,
  ...(taskId ? { task: taskId, 'T-id': taskId } : {}),
  id: taskId || effectiveChange,
  base: base || '',
  sha: base || '',
  'change-dir': path.relative(repo, changeDir),
  'integration-worktree': integrationWorktree || repo,
  workspace: taskWorktree || integrationWorktree || repo,
  'absolute path': taskWorktree || repo,
  'integration-branch': integrationBranch,
  branch: taskBranch || (isGit ? (git(['branch', '--show-current']) || integrationBranch) : integrationBranch),
  'full commit SHA': base || '',
  'exact frozen scope': scopeList.length ? scopeList.join(', ') : '',
  'explicit test file paths within frozen Write scope': testPaths.join(', '),
  'tasks.md + spec paths': contractPaths()?.filter((file) => /(?:tasks|spec)\.md$/.test(file)).join(', ') || '',
  'spec/tasks paths': contractPaths()?.filter((file) => /(?:tasks|spec)\.md$/.test(file)).join(', ') || '',
  'task + spec sections': contractPaths()?.filter((file) => /(?:tasks|spec)\.md$/.test(file)).join(', ') || '',
  ...(task?.verify ? { command: task.verify } : {}),
  'provided role': 'the Pipeline-Role value you were dispatched with (gongbu, gaogong or jiangzuo)',
  scenarios: task ? (task.scenarios.join(', ') || 'none') : '',
  SCENs: task ? (task.scenarios.join(', ') || 'none') : '',
  'paths / base / tip': `contract: ${path.relative(repo, changeDir)}; base: ${base || '(resolved by the main session)'}; tip: the dispatch-time branch tip`,
};

function substitute(text) {
  return text.replace(/<([^<>\n]+)>/g, (match, key) => {
    const value = values[key];
    return value ? value : match;
  });
}
let prompt = substitute(template);

if (task && ['worker', 'tester'].includes(role)) {
  const extrasForTask = extras.get(task.id) || {};
  const lines = ['', '## Frozen task contract (from tasks.md)'];
  lines.push(`- Task: ${task.id} — ${task.title}`);
  lines.push(`- Branch: ${taskBranch} (integration: ${integrationBranch})`);
  lines.push(`- Integration worktree: ${integrationWorktree}`);
  lines.push(`- Base: ${base || '<base>'}`);
  lines.push(`- Depends on: ${task.depends.join(', ') || 'none'}`);
  lines.push(`- Write scope: ${task.scope.join(', ')}`);
  if (extrasForTask.uses) lines.push(`- Uses: ${extrasForTask.uses}`);
  if (extrasForTask.reads) lines.push(`- Reads: ${extrasForTask.reads}`);
  lines.push(`- Review: ${task.review}`);
  if (extrasForTask.est) lines.push(`- Est: ${extrasForTask.est}`);
  if (extrasForTask['risk-surface']) lines.push(`- Risk-surface: ${extrasForTask['risk-surface']}`);
  lines.push(`- Verify with: ${task.verify}`);
  lines.push(`- Scenarios: ${task.scenarios.join(', ') || 'none'}`);
  const adversarial = role === 'worker' ? checklistForSurfaces(extrasForTask['risk-surface']) : [];
  if (adversarial.length) {
    lines.push('', `## Adversarial cases (required, Risk-surface: ${extrasForTask['risk-surface']})`);
    for (const item of adversarial) lines.push(`- [ ] ${item}`);
  }
  lines.push('', '## Dependency state');
  if (dependencyStates.length === 0) lines.push('- No dependencies.');
  for (const state of dependencyStates) lines.push(`- ${state.id}: Done=${state.done}`);
  lines.push('', '## Files you must not touch');
  const forbidden = forbiddenPaths();
  if (!forbidden.length) lines.push('- None outside your Write scope.');
  for (const file of forbidden) lines.push(`- ${file}`);
  lines.push('', '## Toolchain');
  lines.push('- Linked worktree: install dependencies per lockfile if Verify fails with a missing package. Run `pipeline-run.mjs worker-check` before reporting.');
  lines.push('- Resolve runtime settings via `list_profiles`; never guess model IDs.');
  prompt = `${prompt.trimEnd()}\n${lines.join('\n')}\n`;
}

if (['reviewer', 'final', 'tier2-review'].includes(role) && !task) {
  const merged = parsed.tasks.filter((item) => item.done);
  if (merged.length) {
    const lines = ['', '## Merged tasks (each passed only the mechanical gate)'];
    for (const item of merged) {
      lines.push(`- ${item.id} ${item.title}: source ${item.done.source}; scope ${item.scope.join(', ')}; Verify ${item.verify}; scenarios ${item.scenarios.join(', ') || 'none'}`);
    }
    prompt = `${prompt.trimEnd()}\n${lines.join('\n')}\n`;
  }
  if (isGit && base) {
    try {
      const scan = scanRepo({ cwd: repo, base, workingTree: true });
      if (scan.reviewRequired) {
        const lines = ['', '## Deterministic risk-scan summary'];
        if (scan.classes.length) lines.push(`- Classes: ${scan.classes.join(', ')}`);
        for (const hit of scan.hits) lines.push(`- [${hit.class}] ${hit.file}: ${hit.reason}`);
        for (const mut of scan.testMutations) lines.push(`- [test-oracle] ${mut.file}: ${mut.reason}`);
        for (const cav of scan.caveatRemovals || []) lines.push(`- [doc-caveat] ${cav.file}: ${cav.reason}`);
        prompt = `${prompt.trimEnd()}\n${lines.join('\n')}\n`;
      }
    } catch {
      // Skip if base/workingTree cannot be scanned in synthetic fixture
    }
  }
}

if (role === 'tier2' && parsed.tasks.length) {
  const lines = ['', '## Derived Slices (from tasks.md)'];
  parsed.tasks.forEach((item, idx) => {
    lines.push(`S${idx + 1} (${item.id}): ${item.scenarios.join(',') || 'R'} | ${item.scope.join(', ')} | ${item.verify}`);
  });
  prompt = `${prompt.trimEnd()}\n${lines.join('\n')}\n`;
}

if (/(?<!\.)\b(?:claude|gpt|codex|anthropic|openai|gemini|opus|sonnet|haiku)[-/][\w.-]+/i.test(prompt)) {
  console.error('[brief] refusing to emit a concrete model id; resolve profiles with list_profiles');
  process.exit(1);
}

const RUNTIME = /^(?:your-|agent-id$|reviewer-id$|reviewed-HEAD-sha(?:-7-chars)?$|reviewed-commit-sha$|tip$|new[-_]tip$|old[-_]tip$|child-full-uuid$|this file$|capability$|seconds$)/;
const missing = [...new Set([...prompt.matchAll(/<([^<>\n]+)>/g)].map((match) => match[1]))]
  .filter((key) => !RUNTIME.test(key))
  .filter((key) => Object.prototype.hasOwnProperty.call(values, key));

const result = { prompt, missing };
if (json) console.log(JSON.stringify(result, null, 2));
else {
  process.stdout.write(prompt.endsWith('\n') ? prompt : `${prompt}\n`);
  if (missing.length) console.error(`[brief] unresolved placeholders: ${missing.join(', ')}`);
}

if (missing.length) {
  if (json) console.error(`[brief] unresolved placeholders: ${missing.join(', ')}`);
  process.exit(1);
}
