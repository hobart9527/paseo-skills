// Shared deterministic command runner for worker-check, merge-task, tier2-verify, and acceptance-run.
// Runs under `set -o pipefail`, checks worktree cleanliness before/after, and detects missing dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runGit } from './git.mjs';
import { missingDependency, dependencyMessage } from './toolchain.mjs';

export function worktreeFingerprint(cwd) {
  const res = runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']);
  if (res.status !== 0) return null;
  return res.stdout;
}

export function runShell(command, { cwd = process.cwd(), timeout = 120_000, capture = true, streamToStdout = false, maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn('/bin/bash', ['-c', `set -o pipefail; ${command}`], {
      cwd,
      env: childEnv,
      detached: true,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let overflow = false;
    let error = null;

    const killTree = (sig = 'SIGKILL') => {
      try { process.kill(-child.pid, sig); } catch {
        try { child.kill(sig); } catch {}
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 2000).unref();
    }, timeout);

    if (capture) {
      const append = (which, chunk) => {
        if (streamToStdout && Buffer.byteLength(stdout) + Buffer.byteLength(stderr) <= maxBytes) {
          process.stdout.write(chunk);
        }
        if (which === 'stdout') stdout += chunk;
        else stderr += chunk;
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBytes) {
          overflow = true;
          killTree('SIGKILL');
        }
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => append('stdout', chunk));
      child.stderr.on('data', (chunk) => append('stderr', chunk));
    }

    child.on('error', (err) => { error = err.message; });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      const output = `${stdout}${stderr}`;
      const missing = status !== 0 ? missingDependency(output, cwd) : null;
      resolve({
        status,
        signal,
        timedOut,
        overflow,
        error,
        stdout: stdout.slice(0, maxBytes),
        stderr: stderr.slice(0, maxBytes),
        output,
        missingDependency: missing,
        missingMessage: missing ? dependencyMessage(missing, cwd) : null,
      });
    });
  });
}

export async function runVerifyCommand(command, { cwd = process.cwd(), timeout = 120_000, streamToStdout = false, checkDirty = true } = {}) {
  const before = checkDirty ? worktreeFingerprint(cwd) : null;
  const startedAt = Date.now();
  const res = await runShell(command, { cwd, timeout, capture: true, streamToStdout });
  const durationMs = Date.now() - startedAt;
  const after = checkDirty ? worktreeFingerprint(cwd) : null;
  const dirtyChanged = checkDirty && before !== null && after !== null && after !== before;
  const ok = !res.error && res.status === 0 && !res.signal && !res.timedOut && !res.overflow && !dirtyChanged;
  return {
    ...res,
    durationMs,
    dirtyChanged,
    ok,
  };
}

export function discoverPackageVerifyCommands(rootDir, baseRef) {
  const diffRes = runGit(rootDir, ['diff', '--name-only', `${baseRef}...HEAD`]);
  const changed = diffRes.status === 0 ? diffRes.stdout.split(/\r?\n/).filter(Boolean) : [];
  if (!changed.length) return [];
  const pkgDirs = new Set();
  for (const rel of changed) {
    let dir = path.dirname(path.resolve(rootDir, rel));
    while (dir.startsWith(rootDir)) {
      const pkg = path.join(dir, 'package.json');
      if (fs.existsSync(pkg)) { pkgDirs.add(dir); break; }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const cmds = [];
  for (const dir of [...pkgDirs].sort()) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const testScript = pkg?.scripts?.test;
      if (typeof testScript === 'string' && testScript.trim() && !/no test specified/i.test(testScript)) {
        const relDir = path.relative(rootDir, dir) || '.';
        cmds.push(relDir === '.' ? 'npm test' : `npm --prefix ${JSON.stringify(relDir)} test`);
      }
    } catch {}
  }
  return cmds;
}
