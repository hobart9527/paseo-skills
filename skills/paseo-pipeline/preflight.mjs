#!/usr/bin/env node
// Contract-phase capability probe. Runs BEFORE the contract is authored and never
// mutates the repository: it only reads manifests, lockfiles, configs and test paths.
//
// A UI package with no DOM test environment is the expensive late discovery this
// catches: the Wave 0 skeleton has to install jsdom/happy-dom and a testing library
// before any UI task can write a behavioral Red test.

import fs from 'node:fs';
import path from 'node:path';
import { dependencyHint } from './lib/toolchain.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const strict = args.includes('--strict');
const positional = args.filter((arg) => !arg.startsWith('--'));
const repo = path.resolve(positional[0] || '.');
if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) {
  console.error('Usage: preflight.mjs <repo> [--json] [--strict]');
  process.exit(2);
}

const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'go.mod', 'Cargo.toml'];
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', 'env', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '.cache', 'target', 'vendor', '__pycache__', '.tox', '.mypy_cache',
]);
const MAX_DEPTH = 3;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function exists(...parts) {
  return fs.existsSync(path.join(...parts));
}
function walkFiles(dir, depth, visit) {
  if (depth > MAX_DEPTH + 2) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkFiles(full, depth + 1, visit);
    } else if (entry.isFile()) {
      visit(entry.name, full);
    }
  }
}

// Package roots: every directory (within depth 3) that owns a manifest. Root always
// counts, even when empty, so a bare checkout still gets an actionable report.
function packageDirs() {
  const found = new Set([repo]);
  const visit = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (depth > 0 && entries.some((entry) => entry.isFile() && MANIFESTS.includes(entry.name))) found.add(dir);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP_DIRS.has(entry.name)) continue;
      visit(path.join(dir, entry.name), depth + 1);
    }
  };
  visit(repo, 0);
  return [...found].sort((a, b) => (a === repo ? -1 : b === repo ? 1 : a.localeCompare(b)));
}

const rel = (dir) => (path.relative(repo, dir) || '.');

const UI_DEPS = ['react', 'react-dom', 'vue', 'svelte', 'solid-js', 'preact', '@angular/core', 'lit', 'next', 'nuxt'];
const DOM_DEPS = ['jsdom', 'happy-dom', '@testing-library/react', '@testing-library/dom', '@testing-library/vue', '@vue/test-utils'];
const DOM_CONFIG = /(?:environment|testEnvironment)\s*[:=]\s*['"](jsdom|happy-dom)['"]/i;
const TEST_FILE = {
  '*.test.*': /\.(?:test|spec)\.(?:mjs|cjs|js|jsx|ts|tsx)$/,
  'test_*.py': /^test_.*\.py$/,
  '*_test.py': /.*_test\.py$/,
  '*_test.go': /.*_test\.go$/,
};

function testConventions(dir) {
  const patterns = new Set();
  walkFiles(dir, 0, (name) => {
    for (const [label, regex] of Object.entries(TEST_FILE)) if (regex.test(name)) patterns.add(label);
  });
  for (const dirName of ['test', 'tests', '__tests__', 'e2e', 'fixtures', 'testdata']) {
    if (fs.existsSync(path.join(dir, dirName))) patterns.add(`${dirName}/`);
  }
  return [...patterns].sort();
}

function depSet(pkg) {
  return {
    ...(pkg?.dependencies || {}),
    ...(pkg?.devDependencies || {}),
    ...(pkg?.peerDependencies || {}),
    ...(pkg?.optionalDependencies || {}),
  };
}

function domEnvironment(dir, pkg) {
  const deps = depSet(pkg);
  const evidence = DOM_DEPS.filter((name) => Object.prototype.hasOwnProperty.call(deps, name));
  if (pkg?.jest?.testEnvironment && /^(jsdom|happy-dom)$/i.test(pkg.jest.testEnvironment)) evidence.push(`jest.testEnvironment=${pkg.jest.testEnvironment}`);
  for (const config of ['vitest.config.js', 'vitest.config.mjs', 'vitest.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.ts', 'jest.config.js', 'jest.config.mjs', 'jest.config.ts']) {
    const file = path.join(dir, config);
    if (!fs.existsSync(file)) continue;
    try {
      if (DOM_CONFIG.test(fs.readFileSync(file, 'utf8'))) evidence.push(`${config}: DOM environment`);
    } catch { /* unreadable config is not a DOM environment */ }
  }
  return { present: evidence.length > 0, evidence };
}

function isUiPackage(dir, pkg, deps) {
  if (UI_DEPS.some((name) => Object.prototype.hasOwnProperty.call(deps, name))) return true;
  let uiSource = false;
  walkFiles(dir, 0, (name) => {
    if (/\.(?:jsx|tsx|vue|svelte)$/i.test(name)) uiSource = true;
  });
  return uiSource;
}

function nodeTestRunners(dir, pkg, conventions) {
  const deps = depSet(pkg);
  const scripts = pkg?.scripts || {};
  const testScript = String(scripts.test || '');
  const runners = new Set();
  if (/node\s+--test/.test(testScript) || conventions.includes('*.test.*')) runners.add('node --test');
  if (deps.vitest || /\bvitest\b/.test(testScript) || ['vitest.config.js', 'vitest.config.mjs', 'vitest.config.ts'].some((f) => exists(dir, f))) runners.add('vitest');
  if (deps.jest || /\bjest\b/.test(testScript) || ['jest.config.js', 'jest.config.mjs', 'jest.config.ts'].some((f) => exists(dir, f))) runners.add('jest');
  if (deps.mocha || /\bmocha\b/.test(testScript)) runners.add('mocha');
  if (deps.ava || /\bava\b/.test(testScript)) runners.add('ava');
  return [...runners].sort();
}

function pythonRunners(dir, conventions) {
  const runners = new Set();
  const configFiles = ['pytest.ini', 'tox.ini', 'setup.cfg', 'pyproject.toml'];
  const declaresPytest = configFiles.some((file) => {
    const full = path.join(dir, file);
    try { return fs.existsSync(full) && /pytest|\btest\b/i.test(fs.readFileSync(full, 'utf8')); } catch { return false; }
  });
  if (declaresPytest || conventions.includes('test_*.py') || conventions.includes('*_test.py')) runners.add('pytest');
  return [...runners].sort();
}

function packageManager(root) {
  const has = (file) => fs.existsSync(path.join(root, file));
  if (has('pnpm-lock.yaml')) return { add: 'pnpm add -D', bootstrap: 'pnpm install --frozen-lockfile' };
  if (has('yarn.lock')) return { add: 'yarn add -D', bootstrap: 'yarn install --immutable' };
  if (has('bun.lockb') || has('bun.lock')) return { add: 'bun add -d', bootstrap: 'bun install --frozen-lockfile' };
  if (has('package-lock.json')) return { add: 'npm install -D', bootstrap: 'npm ci' };
  return { add: 'npm install -D', bootstrap: 'npm install' };
}

function hasLockfile(dir, kind) {
  const has = (file) => fs.existsSync(path.join(dir, file));
  if (kind === 'node') return ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'].some(has);
  if (kind === 'python') return ['requirements.txt', 'pyproject.toml', 'Pipfile', 'poetry.lock', 'uv.lock'].some(has);
  if (kind === 'go') return has('go.sum') || has('go.mod');
  if (kind === 'cargo') return has('Cargo.lock') || has('Cargo.toml');
  return false;
}

function installed(dir, kind) {
  const has = (name) => fs.existsSync(path.join(dir, name));
  if (kind === 'node') return has('node_modules') || fs.existsSync(path.join(repo, 'node_modules'));
  if (kind === 'python') return has('.venv') || has('venv') || fs.existsSync(path.join(repo, '.venv'));
  return true; // Go/Cargo resolve modules from a shared cache, not a worktree-local tree.
}

function bootstrapFor(dir, kind) {
  if (!hasLockfile(dir, kind)) {
    // A workspace package may rely on the repository root's lockfile.
    if (dir !== repo && hasLockfile(repo, kind)) return dependencyHint(repo);
    return null;
  }
  return dependencyHint(dir);
}

const findings = [];
const packages = [];

for (const dir of packageDirs()) {
  const pkgPath = path.join(dir, 'package.json');
  const pkg = fs.existsSync(pkgPath) ? readJson(pkgPath) : null;
  const hasGo = fs.existsSync(path.join(dir, 'go.mod'));
  const hasPython = ['pyproject.toml', 'requirements.txt', 'setup.py'].some((file) => fs.existsSync(path.join(dir, file)));
  const hasCargo = fs.existsSync(path.join(dir, 'Cargo.toml'));
  if (!pkg && !hasGo && !hasPython && !hasCargo && dir !== repo) continue;
  if (!pkg && !hasGo && !hasPython && !hasCargo) continue;

  const kind = pkg ? 'node' : hasGo ? 'go' : hasPython ? 'python' : 'cargo';
  const name = pkg?.name || path.basename(dir);
  const conventions = testConventions(dir);
  const deps = depSet(pkg);
  let runners;
  if (kind === 'node') runners = nodeTestRunners(dir, pkg, conventions);
  else if (kind === 'python') runners = pythonRunners(dir, conventions);
  else if (kind === 'go') runners = ['go test'];
  else runners = ['cargo test'];

  const dom = kind === 'node' ? domEnvironment(dir, pkg) : { present: false, evidence: [] };
  const ui = kind === 'node' && isUiPackage(dir, pkg, deps);
  const depsInstalled = installed(dir, kind);
  const bootstrap = bootstrapFor(dir, kind);

  const entry = {
    name,
    path: rel(dir),
    kind,
    testRunners: runners,
    testConventions: conventions,
    domEnvironment: dom.present,
    domEvidence: dom.evidence,
    ui,
    dependenciesInstalled: depsInstalled,
    lockfileImpliesBootstrap: bootstrap,
  };
  packages.push(entry);

  if (ui && !dom.present) {
    const manager = packageManager(repo);
    const extras = ['jsdom'];
    if (Object.prototype.hasOwnProperty.call(deps, 'react') || Object.prototype.hasOwnProperty.call(deps, 'react-dom')) extras.push('@testing-library/react');
    if (Object.prototype.hasOwnProperty.call(deps, 'vue')) extras.push('@vue/test-utils');
    const command = entry.path === '.' ? `${manager.add} ${extras.join(' ')}` : `cd ${entry.path} && ${manager.add} ${extras.join(' ')}`;
    findings.push({
      code: 'WAVE0_BASELINE',
      package: entry.path,
      detail: `UI package "${name}" has no DOM test environment (no jsdom, happy-dom or @testing-library in its dependencies)`,
      fix: command,
    });
  }
  if (runners.length === 0 && (conventions.length > 0 || String(pkg?.scripts?.test || '').trim())) {
    findings.push({
      code: 'MISSING_TEST_RUNNER',
      package: entry.path,
      detail: `no test runner detected for "${name}"`,
      fix: kind === 'node'
        ? 'declare vitest/jest in devDependencies or add a "test" script (node --test)'
        : 'add a pytest/go/cargo test entry point and a narrow test path',
    });
  }
  // A workspace aggregator with no dependency tree of its own (only `workspaces`)
  // is not an install target; the leaf packages are.
  const declaresDependencies = Object.keys(deps).length > 0;
  if (!depsInstalled && declaresDependencies) {
    findings.push({
      code: 'MISSING_DEPENDENCIES',
      package: entry.path,
      detail: `"${name}" has no installed dependency tree in this checkout`,
      fix: bootstrap
        ? `install once in this worktree: ${bootstrap}`
        : `install the workspace dependencies (${dependencyHint(dir)}) before any Verify runs`,
    });
  }
}

const report = { ok: findings.length === 0, packages, findings };

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[preflight] ${repo}`);
  for (const pkg of packages) {
    console.log(`PACKAGE ${pkg.path} (${pkg.kind})${pkg.name ? ` name=${pkg.name}` : ''}`);
    console.log(`  runners=${pkg.testRunners.join(',') || 'none'} tests=${pkg.testConventions.join(',') || 'none'}`);
    console.log(`  ui=${pkg.ui ? 'yes' : 'no'} dom=${pkg.domEnvironment ? 'yes' : 'no'} deps=${pkg.dependenciesInstalled ? 'installed' : 'missing'}${pkg.lockfileImpliesBootstrap ? ` bootstrap=${pkg.lockfileImpliesBootstrap}` : ''}`);
  }
  for (const finding of findings) {
    console.log(`FINDING ${finding.code} ${finding.package}: ${finding.detail}`);
    console.log(`  fix: ${finding.fix}`);
  }
  console.log(report.ok ? 'RESULT preflight ok' : `RESULT ${findings.length} finding(s)${strict ? '; strict mode fails' : ''}`);
}

process.exit(strict && findings.length ? 1 : 0);
