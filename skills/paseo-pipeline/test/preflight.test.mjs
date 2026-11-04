import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../preflight.mjs', import.meta.url));

function repo(files) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(cwd, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof text === 'string' ? text : JSON.stringify(text, null, 2) + '\n');
  }
  return cwd;
}
function run(cwd, extra = []) {
  const result = spawnSync('node', [script, cwd, ...extra], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, out: `${result.stdout}${result.stderr}` };
}

test('preflight: UI source belongs to its nearest package.json', () => {
  const cwd = repo({
    'package.json': { name: 'root', private: true, workspaces: ['packages/*'] },
    'node_modules/.keep': '',
    'packages/web/package.json': { name: 'web', devDependencies: { jsdom: '^24' } },
    'packages/web/src/App.tsx': 'export default () => null;\n',
    'packages/web/nested/package.json': { name: 'nested' },
    'packages/web/nested/Widget.vue': '<template />\n',
  });
  const result = run(cwd, ['--json', '--strict']);
  const report = JSON.parse(result.stdout);
  assert.equal(report.packages.find((pkg) => pkg.path === '.').ui, false);
  assert.equal(report.packages.find((pkg) => pkg.path === 'packages/web').ui, true);
  assert.equal(report.packages.find((pkg) => pkg.path === 'packages/web/nested').ui, true);
  assert.deepEqual(report.findings.filter((item) => item.code === 'WAVE0_BASELINE').map((item) => item.package), ['packages/web/nested']);
  assert.equal(result.status, 1);
});

test('preflight: root UI source outside nested packages still requires DOM', () => {
  const cwd = repo({
    'package.json': { name: 'root', workspaces: ['packages/*'] },
    'src/components/App.tsx': 'export default () => null;\n',
    'packages/web/package.json': { name: 'web', devDependencies: { jsdom: '^24' } },
    'packages/web/App.tsx': 'export default () => null;\n',
  });
  const report = JSON.parse(run(cwd, ['--json', '--strict']).stdout);
  assert.equal(report.packages.find((pkg) => pkg.path === '.').ui, true);
  assert.deepEqual(report.findings.filter((item) => item.code === 'WAVE0_BASELINE').map((item) => item.package), ['.']);
});

test('preflight: nested package UI does not make its parent UI', () => {
  const cwd = repo({
    'package.json': { name: 'root' },
    'packages/parent/package.json': { name: 'parent' },
    'packages/parent/nested/package.json': { name: 'nested', devDependencies: { jsdom: '^24' } },
    'packages/parent/nested/App.jsx': 'export default null;\n',
  });
  const report = JSON.parse(run(cwd, ['--json']).stdout);
  assert.equal(report.packages.find((pkg) => pkg.path === '.').ui, false);
  assert.equal(report.packages.find((pkg) => pkg.path === 'packages/parent').ui, false);
  assert.equal(report.packages.find((pkg) => pkg.path === 'packages/parent/nested').ui, true);
  assert.equal(report.findings.some((item) => item.code === 'WAVE0_BASELINE'), false);
});

test('preflight: a UI package with no DOM environment yields a concrete WAVE0_BASELINE finding', () => {
  const cwd = repo({
    'package.json': { name: 'root', private: true, workspaces: ['packages/*'] },
    'package-lock.json': '{}\n',
    'node_modules/.keep': '',
    'packages/ui/package.json': {
      name: '@app/ui',
      scripts: { test: 'vitest run' },
      devDependencies: { react: '^18.0.0', 'react-dom': '^18.0.0', vitest: '^2.0.0' },
    },
  });
  const result = run(cwd, ['--json', '--strict']);
  assert.equal(result.status, 1, result.out);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  const ui = report.packages.find((pkg) => pkg.path === 'packages/ui');
  assert.equal(ui.ui, true);
  assert.equal(ui.domEnvironment, false);
  assert.deepEqual(ui.testRunners, ['vitest']);
  const finding = report.findings.find((item) => item.code === 'WAVE0_BASELINE');
  assert.ok(finding, JSON.stringify(report.findings));
  assert.equal(finding.package, 'packages/ui');
  assert.match(finding.fix, /npm install -D .*jsdom/);
  assert.match(finding.fix, /@testing-library\/react/);
  assert.match(finding.detail, /no DOM test environment/);
  // Never mutates the repository.
  assert.equal(fs.existsSync(path.join(cwd, 'packages/ui/node_modules')), false);
});

test('preflight: stays silent about DOM when a DOM environment is installed', () => {
  for (const deps of [
    { 'react': '^18', 'react-dom': '^18', 'vitest': '^2', 'jsdom': '^24' },
    { 'react': '^18', 'react-dom': '^18', 'vitest': '^2', 'happy-dom': '^14' },
    { 'react': '^18', 'react-dom': '^18', 'vitest': '^2', '@testing-library/react': '^14' },
  ]) {
    const cwd = repo({
      'package.json': { name: 'ui', scripts: { test: 'vitest run' }, devDependencies: { ...deps, '@testing-library/react': deps['@testing-library/react'] || '^14' } },
      'package-lock.json': '{}\n',
      'node_modules/.keep': '',
    });
    const result = run(cwd, ['--json', '--strict']);
    assert.equal(result.status, 0, `${JSON.stringify(deps)}\n${result.out}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.packages[0].domEnvironment, true);
    assert.equal(report.findings.some((item) => item.code === 'WAVE0_BASELINE'), false);
  }
});

test('preflight: a vitest config declaring the environment counts as a DOM environment', () => {
  const cwd = repo({
    'package.json': { name: 'ui', scripts: { test: 'vitest run' }, devDependencies: { react: '^18', vitest: '^2' } },
    'vitest.config.ts': "export default { test: { environment: 'jsdom' } };\n",
    'node_modules/.keep': '',
  });
  const result = run(cwd, ['--json', '--strict']);
  assert.equal(result.status, 0, result.out);
  assert.equal(JSON.parse(result.stdout).packages[0].domEnvironment, true);
});

test('preflight: detects runners, conventions, missing dependencies and the bootstrap command', () => {
  const cwd = repo({
    'package.json': {
      name: 'svc',
      scripts: { test: 'node --test test/*.test.mjs' },
      devDependencies: { typescript: '^5.0.0' },
    },
    'package-lock.json': '{}\n',
    'test/a.test.mjs': 'import test from "node:test";\n',
    'src/a.mjs': 'export const a = 1;\n',
  });
  const result = run(cwd, ['--json']);
  assert.equal(result.status, 0, 'non-strict exits 0 with findings');
  const report = JSON.parse(result.stdout);
  const pkg = report.packages[0];
  assert.deepEqual(pkg.testRunners, ['node --test']);
  assert.ok(pkg.testConventions.includes('*.test.*'));
  assert.ok(pkg.testConventions.includes('test/'));
  assert.equal(pkg.dependenciesInstalled, false);
  assert.equal(pkg.lockfileImpliesBootstrap, 'npm ci');
  const finding = report.findings.find((item) => item.code === 'MISSING_DEPENDENCIES');
  assert.match(finding.fix, /npm ci/);
});

test('preflight: python and go packages report their own runners', () => {
  const cwd = repo({
    'pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
    'tests/test_x.py': 'def test_x(): assert True\n',
    'service/go.mod': 'module example.com/service\n',
    'service/x_test.go': 'package service\n',
  });
  const report = JSON.parse(run(cwd, ['--json']).stdout);
  const python = report.packages.find((pkg) => pkg.path === '.');
  assert.deepEqual(python.testRunners, ['pytest']);
  const go = report.packages.find((pkg) => pkg.path === 'service');
  assert.deepEqual(go.testRunners, ['go test']);
});
