#!/usr/bin/env node
// Render a complete, copy-pasteable child prompt from a role template plus the
// frozen contract. No model is chosen here: the caller resolves provider/model
// with `list_profiles`, so this script never emits a model id.

import fs from 'node:fs';
import path from 'node:path';
import { parseTasks, isTestPath } from './lib/tasks.mjs';
import { checklistForSurfaces } from './lib/adversarial.mjs';
import { gitMaybe } from './lib/git.mjs';
import { argValue, positionalArgs } from './lib/cli.mjs';

const TEMPLATES = ['author', 'worker', 'reviewer'];
const usage = 'Usage: brief.mjs <role> --change <name> --repo <path> [--task <id>] [--base <sha>] [--json]';
const args = process.argv.slice(2);
const json = args.includes('--json');
const positional = positionalArgs(args, ['change', 'repo', 'task', 'base']);
const role = positional[0];
const change = argValue(args, 'change');
const repoArg = argValue(args, 'repo');
const taskId = argValue(args, 'task');
const baseArg = argValue(args, 'base');
if (!role || !change || !repoArg) {
  console.error(usage);
  process.exit(2);
}
const repo = path.resolve(repoArg);
if (!TEMPLATES.includes(role)) {
  console.error(`[brief] unknown role "${role}"; expected one of ${TEMPLATES.join(', ')}`);
  process.exit(2);
}
const templateFile = path.join(repo, 'skills', 'paseo-pipeline', 'templates', `${role}.md`);
const fallbackTemplate = new URL(`./templates/${role}.md`, import.meta.url);
let template;
try { template = fs.readFileSync(templateFile, 'utf8'); } catch {
  try { template = fs.readFileSync(fallbackTemplate, 'utf8'); } catch {
    console.error(`[brief] template not found: ${templateFile}`);
    process.exit(2);
  }
}

const git = (gitArgs, cwd = repo) => gitMaybe(cwd, gitArgs);
const isGit = git(['rev-parse', '--is-inside-work-tree']) === 'true';

const changeDir = path.join(repo, 'openspec', 'changes', change);
const tasksFile = path.join(changeDir, 'tasks.md');
let tasksMarkdown = null;
try { tasksMarkdown = fs.readFileSync(tasksFile, 'utf8'); } catch { tasksMarkdown = null; }

const integrationBranch = `integration/${change}`;
const taskBranch = taskId ? `task/${change}/${taskId}` : null;

// Extra metadata lib/tasks.mjs does not model (Uses/Reads/Est/Risk-surface).
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
// The Lead normally creates task/integration workspaces before dispatch. When they do
// not exist yet, the repository checkout is the only honest fallback: never invent a
// workspace path.
const integrationWorktree = worktreeFor(integrationBranch)
  || (isGit && git(['branch', '--show-current']) === integrationBranch ? repo : repo);
const taskWorktree = taskBranch ? worktreeFor(taskBranch) : null;

function resolveBase() {
  // A supplied base must name a real commit; an unverifiable one is not resolved.
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
  // The commit that froze the contract is the review base when the integration
  // branch does not exist yet.
  return git(['log', '-1', '--format=%H', '--', path.relative(repo, changeDir)]);
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

// Everything a task may not touch: every other task's Write scope, plus the frozen
// contract (children read it; only the authors and the Lead's merge write it).
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
  change,
  // A task placeholder only exists when a task was requested. A package brief
  // keeps the template's literal `<T-id>`: the caller fills it per dispatch.
  ...(taskId ? { task: taskId, 'T-id': taskId } : {}),
  id: taskId || change,
  base: base || '',
  'change-dir': path.relative(repo, changeDir),
  'integration-worktree': integrationWorktree || repo,
  workspace: taskWorktree || integrationWorktree || repo,
  'integration-branch': integrationBranch,
  branch: taskBranch || integrationBranch,
  'exact frozen scope': scopeList.length ? scopeList.join(', ') : '',
  'tasks.md + spec paths': contractPaths()?.filter((file) => /(?:tasks|spec)\.md$/.test(file)).join(', ') || '',
  'spec/tasks paths': contractPaths()?.filter((file) => /(?:tasks|spec)\.md$/.test(file)).join(', ') || '',
  command: task?.verify || '',
  'provided role': 'the Pipeline-Role value you were dispatched with (gongbu, gaogong or jiangzuo)',
  'scenarios': task ? (task.scenarios.join(', ') || 'none') : '',
  'paths / base / tip': `contract: ${path.relative(repo, changeDir)}; base: ${base || '(resolved by the main session)'}; tip: the dispatch-time branch tip`,
};

function substitute(text) {
  return text.replace(/<([^<>\n]+)>/g, (match, key) => {
    const value = values[key];
    return value ? value : match;
  });
}
let prompt = substitute(template);

// Task briefs append the frozen contract so the child never needs to re-derive it.
if (task) {
  const extrasForTask = extras.get(task.id) || {};
  const lines = [];
  lines.push('');
  lines.push('## Frozen task contract (from tasks.md)');
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
  // Required adversarial cases come from the frozen risk surface, so the worker does
  // not have to re-derive them and the final review can check them.
  const adversarial = role === 'worker' ? checklistForSurfaces(extrasForTask['risk-surface']) : [];
  if (adversarial.length) {
    lines.push('');
    lines.push(`## Adversarial cases (required, Risk-surface: ${extrasForTask['risk-surface']})`);
    for (const item of adversarial) lines.push(`- [ ] ${item}`);
  }
  lines.push('');
  lines.push('## Dependency state');
  if (dependencyStates.length === 0) lines.push('- No dependencies.');
  for (const state of dependencyStates) lines.push(`- ${state.id}: Done=${state.done}`);
  lines.push('');
  lines.push('## Files you must not touch');
  const forbidden = forbiddenPaths();
  if (!forbidden.length) lines.push('- None outside your Write scope.');
  for (const file of forbidden) lines.push(`- ${file}`);
  lines.push('');
  lines.push('## Toolchain');
  lines.push('- This is a git worktree, not a clone: if Verify cannot resolve a package, install per lockfile in this workspace and rerun. A missing dependency is an environment fault, not a Red result.');
  lines.push('- Resolve the agent profile (provider/model, modeId, thinkingOptionId, featureValues) with list_profiles; this brief deliberately contains no model id.');
  prompt = `${prompt.trimEnd()}\n${lines.join('\n')}\n`;
}

// A FINAL review is the only code-quality gate: every task merged through the
// mechanical gate, so the brief carries each Done task's merged diff range.
if (role === 'reviewer' && !task) {
  const merged = parsed.tasks.filter((item) => item.done);
  if (merged.length) {
    const lines = ['', '## Merged tasks (each passed only the mechanical gate)'];
    for (const item of merged) {
      lines.push(`- ${item.id} ${item.title}: source ${item.done.source}; scope ${item.scope.join(', ')}; Verify ${item.verify}; scenarios ${item.scenarios.join(', ') || 'none'}`);
    }
    prompt = `${prompt.trimEnd()}\n${lines.join('\n')}\n`;
  }
}

// Concrete model ids never belong in a generated brief.
if (/\b(?:claude|gpt|codex|anthropic|openai|gemini|opus|sonnet|haiku)[-/][\w.-]+/i.test(prompt)) {
  console.error('[brief] refusing to emit a concrete model id; resolve profiles with list_profiles');
  process.exit(1);
}

// Placeholders the child fills at runtime are intentional. Every other placeholder is
// one this script promises to resolve, so an empty value is a hard failure: a brief
// with `<base>` or `<integration-worktree>` left in it sends the child hunting.
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
