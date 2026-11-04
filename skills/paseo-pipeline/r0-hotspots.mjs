#!/usr/bin/env node
// Read only declared contract metadata; never execute Verify commands.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseTasks } from './lib/tasks.mjs';

const args = process.argv.slice(2);
if (!((args.length === 1 || (args.length === 3 && args[1] === '--final')) && !args[0].startsWith('-'))) {
  console.error('Usage: r0-hotspots.mjs <change-dir> [--final <full-sha>]');
  process.exit(2);
}

try {
  if (args[1] === '--final') {
    const git = (...argv) => {
      const result = spawnSync('git', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } });
      if (result.error || result.status !== 0) throw new Error(`git ${argv[0]} failed: ${result.error?.message || result.stderr.trim()}`);
      return result.stdout;
    };
    const repo = fs.realpathSync(git('rev-parse', '--show-toplevel').trim());
    const relative = path.relative(repo, fs.realpathSync(path.resolve(args[0]))).split(path.sep).join('/');
    const match = /^openspec\/changes\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(relative);
    if (!match || match[1].includes('..')) throw new Error('FINAL change path must be openspec/changes/<name> in the current repository');
    const format = git('rev-parse', '--show-object-format').trim();
    const sha = args[2];
    const length = format === 'sha1' ? 40 : format === 'sha256' ? 64 : 0;
    if (!length || sha.length !== length || !/^[0-9a-f]+$/.test(sha)) throw new Error('FINAL requires a full lowercase commit SHA');
    if (git('rev-parse', '--verify', `${sha}^{commit}`).trim() !== sha) throw new Error('SHA must identify a commit');
    const ref = `refs/heads/integration/${match[1]}`;
    const tip = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8', env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } });
    if (tip.status !== 0) throw new Error(`local branch ${ref} does not exist; FINAL summary needs the integration branch`);
    if (tip.stdout.trim() !== sha) throw new Error(`reviewed SHA must equal ${ref} tip`);
    const source = `${relative}/tasks.md`;
    const entry = git('ls-tree', '-z', sha, '--', source);
    const treeEntry = /^(100644|100755) blob ([0-9a-f]+)\t([^\0]+)\0$/.exec(entry);
    if (!treeEntry || treeEntry[3] !== source) throw new Error(`commit lacks regular file ${source}`);
    const { tasks, errors } = parseTasks(git('cat-file', 'blob', treeEntry[2]));
    console.log(JSON.stringify({
      notice: 'Declared task metadata only, not validation or a review verdict. Manually assess cross-task interactions and undeclared risks; mechanical never exempts semantic review. Fields are normalized by parseTasks; review defaults to standard. No UI inference.',
      sha, source,
      tasks: tasks.map(({ id, title, line, checked, done, scenarios, scope, reads, depends, uses, interface: interfaces, riskSurface, verify, review }) =>
        ({ id, title, line, checked, done, scenarios, scope, reads, depends, uses, interface: interfaces, riskSurface, verify, review })),
      errors,
    }, null, 2));
    if (errors.length) process.exitCode = 1;
  } else {
  const root = path.resolve(args[0]);
  const tasksPath = path.join(root, 'tasks.md');
  if (!fs.lstatSync(tasksPath).isFile()) throw new Error('tasks.md must be a regular file');
  const { tasks, errors } = parseTasks(fs.readFileSync(tasksPath, 'utf8'));
  const specsRoot = path.join(root, 'specs');
  if (!fs.lstatSync(specsRoot).isDirectory()) throw new Error('specs must be a directory');
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink in specs: ${path.relative(root, file)}`);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name === 'spec.md') files.push(file);
    }
  }
  walk(specsRoot);
  if (!files.length) throw new Error('no specs/**/spec.md found');
  const requirements = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    let section = null;
    let fence = null;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
        continue;
      }
      if (fence) continue;
      const heading = line.match(/^ {0,3}##\s+(.+?)\s*#*\s*$/);
      if (heading) section = /^(MODIFIED|REMOVED) Requirements$/i.exec(heading[1])?.[1].toUpperCase() ?? null;
      const requirement = line.match(/^ {0,3}###\s+Requirement:\s*(.+?)\s*#*\s*$/i);
      if (section && requirement) requirements.push({ file: path.relative(root, file).split(path.sep).join('/'), line: i + 1, change: section, requirement: requirement[1] });
    }
  }
  console.log(JSON.stringify({
    notice: 'Unbound worktree draft, not tied to any commit. Declared metadata only; not complete analysis, call-site discovery, validation or a substitute for R0.',
    tasks: tasks.map(({ id, title, line, uses, interface: interfaces, riskSurface, verify }) => ({ id, title, line, uses, interface: interfaces, riskSurface, verify })),
    requirements,
    errors,
  }, null, 2));
  if (errors.length) process.exitCode = 1;
  }
} catch (error) {
  console.error(`r0-hotspots: ${error.message}`);
  process.exitCode = 2;
}
