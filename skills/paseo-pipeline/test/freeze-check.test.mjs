// freeze-check 回归：冻结预检必须在写侧就挡住下游才会暴露的问题。
//
// 用例全部来自实测过的真实返工：
//   - 按上游 OpenSpec 模板写的 tasks.md 解析出 0 个任务（validate --strict 却通过）
//   - 场景不带 SCEN- 编号时 contract-check 静默跳过，rc=0
//   - `pipeline-gate-slimming` 归档后才发现 19 条 BAD_DONE_LINE
//   - `hardening-governance-contracts` 冻结后补了两次任务格式提交
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTasks } from '../lib/tasks.mjs';

const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FREEZE = path.join(SKILL_DIR, 'freeze-check.mjs');
const SCHEMA_TEMPLATES = path.join(SKILL_DIR, 'openspec-schema', 'templates');

const SPEC = `## Purpose

Test capability long enough to satisfy the purpose length check comfortably.

## ADDED Requirements

### Requirement: Demo works
The system SHALL demo.

#### Scenario: SCEN-DMO-01 happy path
- **WHEN** demo runs
- **THEN** it works

#### Scenario: SCEN-DMO-02 failure path
- **WHEN** demo fails
- **THEN** it reports
`;

const TASKS = `## 1. Demo

- [ ] 1.1 T-01 first task
  - Depends on: none
  - Write scope: src/a.mjs
  - Risk-surface: [none]
  - Review: mechanical
  - Verify with: \`node --test src/a.test.mjs\`
  - Scenarios: SCEN-DMO-01

- [ ] 1.2 T-02 second task
  - Depends on: T-01
  - Write scope: src/b.mjs
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: \`node --test src/b.test.mjs\`
  - Scenarios: SCEN-DMO-02
`;

const ACCEPTANCE = `# Acceptance Matrix

| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| SCEN-DMO-01 | GET /api/demo | T-01 | node scripts/probe.mjs | yes | PENDING | pending |
| SCEN-DMO-02 | GET /api/demo?fail=1 | T-02 | node scripts/probe.mjs --fail | yes | PENDING | pending |
`;

/** 建一个临时 change 目录；overrides 里的键覆盖默认文件内容，值为 null 表示不写该文件。 */
function makeChange(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-check-'));
  const dir = path.join(root, 'openspec', 'changes', 'demo');
  fs.mkdirSync(path.join(dir, 'specs', 'cap'), { recursive: true });
  const files = {
    'specs/cap/spec.md': SPEC,
    'tasks.md': TASKS,
    'acceptance.md': ACCEPTANCE,
    ...overrides,
  };
  for (const [name, content] of Object.entries(files)) {
    if (content === null) continue;
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return { root, dir };
}

function run(dir, extra = []) {
  try {
    const stdout = execFileSync(process.execPath, [FREEZE, dir, ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? -1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

// MODIFIED 替换整个 Requirement 块，所以 delta 必须把基线原有场景原样抄回（抄漏会被
// openspec validate 拒绝）。抄回来的编号出现在 delta 里不代表本 change 新增了它们，
// 双向核对不能要求本 change 的任务认领它们——否则任何含 MODIFIED 的 change 都冻结不了。
test('SCEN-CON-25 scenarios copied back from the baseline are not claimed obligations', () => {
  const { root, dir } = makeChange({
    // 夹具编号复用本文件已有的存量债编号（SCEN-DMO-77 / -99）：这里构造的是 spec 形状的
    // 输入，不是场景引用，凭空造一个新编号只会让 skill 级 phantom 预算无故上涨。
    'specs/cap/spec.md': `${SPEC}\n#### Scenario: SCEN-DMO-77 inherited scenario\n- **WHEN** inherited\n- **THEN** it stays\n`,
  });
  try {
    // 不带 --baseline：抄回来的编号既没人认领、也不在本 change 的任务里 → 阻断。
    assert.equal(run(dir).code, 1, 'without a baseline the inherited scenario looks unclaimed');
    // 带 --baseline：同一份 delta 判可冻结。
    const withBaseline = run(dir, ['--baseline', path.join(root, 'openspec', 'changes', 'demo', 'specs')]);
    assert.equal(withBaseline.code, 0, withBaseline.out);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SCEN-CON-25 a scenario declared nowhere is still blocked even with a baseline', () => {
  const { root, dir } = makeChange({
    'tasks.md': TASKS.replace('  - Scenarios: SCEN-DMO-02', '  - Scenarios: SCEN-DMO-99'),
  });
  try {
    const result = run(dir, ['--baseline', path.join(root, 'openspec', 'changes', 'demo', 'specs')]);
    assert.equal(result.code, 1, 'a baseline must not excuse a typo');
    assert.match(result.out, /SCEN-DMO-99/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SCEN-CON-05 schema templates parse clean with the production parser', () => {
  const markdown = fs.readFileSync(path.join(SCHEMA_TEMPLATES, 'tasks.md'), 'utf8');
  const parsed = parseTasks(markdown);
  // 模板本身必须零错误，否则「照模板写」等于「照错写」。
  assert.deepEqual(parsed.errors.map((error) => `${error.code}: ${error.message}`), []);
  assert.equal(parsed.tasks.length, 2);
  assert.deepEqual(parsed.tasks.map((task) => task.id), ['T-01', 'T-02']);
  for (const task of parsed.tasks) {
    assert.ok(task.scope.length > 0, `${task.id} template must declare a write scope`);
    assert.ok(task.verify?.command, `${task.id} template Verify with must be executable`);
  }
});

test('SCEN-CON-05 acceptance template declares the exact columns the parser reads', () => {
  const markdown = fs.readFileSync(path.join(SCHEMA_TEMPLATES, 'acceptance.md'), 'utf8');
  const header = markdown.split(/\r?\n/).find((line) => /^\s*\|/.test(line) && /Scenario/.test(line));
  const columns = header.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
  assert.deepEqual(columns, ['Scenario', 'Entry', 'Tasks', 'Verify', 'Required', 'Result', 'Evidence']);
  // 冻结时只能 PENDING：模板里写 PASS 会教人提前宣布验收通过。
  assert.ok(!/\|\s*PASS\s*\|/.test(markdown), 'template must not ship a PASS result');
  assert.match(markdown, /\|\s*PENDING\s*\|/);
});

test('SCEN-CON-17 an archived change is a read-only diagnosis, not a freeze verdict', () => {
  // 归档目录是历史记录。实测四个归档 change 在当前规则下全部判「不得冻结」
  // （contract-alignment 14、wakeup-budget 30、gate-slimming 31、native-closure 1），
  // 而多数是「写的时候规则还不存在」——例如更早的 Done 行用 `review=main-session`。
  // 追溯执法只会让只读诊断永远红着，红到最后没人再看它。
  const { root } = makeChange();
  const archived = path.join(root, 'openspec', 'changes', 'archive', '2026-01-01-demo');
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  fs.renameSync(path.join(root, 'openspec', 'changes', 'demo'), archived);
  // 制造一个在当前规则下必然阻断的历史形态：手写 Done 行。
  const tasksPath = path.join(archived, 'tasks.md');
  fs.writeFileSync(tasksPath, fs.readFileSync(tasksPath, 'utf8')
    .replace('- [ ] 1.1 T-01 first task', '- [x] 1.1 T-01 first task')
    .replace('  - Scenarios: SCEN-DMO-01', '  - Done: source=abcdef0 review=main-session\n  - Scenarios: SCEN-DMO-01'));

  const result = run(archived);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /已归档：历史记录只读诊断/);
  assert.match(result.out, /HINT  \[已归档，仅记录\] tasks\.md BAD_DONE_LINE/,
    '历史缺陷仍要如实列出，只是不阻断');
});

test('SCEN-CON-04 a clean change passes freeze check', () => {
  const { dir } = makeChange();
  const result = run(dir);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /tasks=2 scenarios=2 acceptanceRows=2/);
});

test('SCEN-CON-04 task line without an id is blocking', () => {
  // 上游 OpenSpec 模板的形状：`- [ ] 1.1 描述`
  const { dir } = makeChange({ 'tasks.md': TASKS.replace(/T-01 first task/, 'first task without id') });
  const result = run(dir);
  assert.equal(result.code, 1);
  assert.match(result.out, /MALFORMED_LINE/);
});

test('SCEN-CON-04 spec scenario without a SCEN id is blocking, not silently skipped', () => {
  const { dir } = makeChange({
    'specs/cap/spec.md': SPEC.replace('#### Scenario: SCEN-DMO-02 failure path', '#### Scenario: failure path'),
  });
  const result = run(dir);
  assert.equal(result.code, 1);
  assert.match(result.out, /场景缺少 SCEN- 编号/);
});

test('SCEN-CON-04 a declared scenario that no task claims is blocking', () => {
  const { dir } = makeChange({
    'tasks.md': TASKS.replace('  - Scenarios: SCEN-DMO-02\n', ''),
  });
  const result = run(dir);
  assert.equal(result.code, 1);
  assert.match(result.out, /SCEN-DMO-02.*没有任何任务认领/);
});

test('SCEN-CON-04 a task claiming an undeclared scenario is blocking', () => {
  const { dir } = makeChange({
    'tasks.md': TASKS.replace('Scenarios: SCEN-DMO-02', 'Scenarios: SCEN-DMO-99'),
  });
  const result = run(dir);
  assert.equal(result.code, 1);
  assert.match(result.out, /引用了未声明的场景 SCEN-DMO-99/);
});

test('SCEN-CON-04 acceptance matrix may not be pre-filled with PASS at freeze time', () => {
  const { dir } = makeChange({
    'acceptance.md': ACCEPTANCE.replace('| yes | PENDING | pending |', '| yes | PASS | evidence/smoke.md |'),
  });
  const result = run(dir);
  assert.equal(result.code, 1);
  assert.match(result.out, /冻结时只能是 PENDING/);
});

// 演练回归：`! node x` 以 `!` 开头被 parseVerify 判成自然语言，冻结时没人拦，收尾 acceptance-run exit 2。
test('SCEN-CON-04 a Required matrix row whose Verify is not an executable command is blocking', () => {
  const negated = makeChange({
    'acceptance.md': ACCEPTANCE.replace('node scripts/probe.mjs --fail', "! node scripts/probe.mjs --fail"),
  });
  const result = run(negated.dir);
  assert.equal(result.code, 1);
  assert.match(result.out, /Verify 不是可执行命令/);
  assert.match(result.out, /sh -c/);

  const prose = makeChange({
    'acceptance.md': ACCEPTANCE.replace('node scripts/probe.mjs --fail', '手工打开页面确认'),
  });
  assert.equal(run(prose.dir).code, 1);
});

test('SCEN-CON-04 sh -c wrapping makes a negated Verify pass, and a non-required prose row only records', () => {
  const wrapped = makeChange({
    'acceptance.md': ACCEPTANCE.replace('node scripts/probe.mjs --fail', "sh -c '! node scripts/probe.mjs --fail'"),
  });
  assert.equal(run(wrapped.dir).code, 0);

  const optional = makeChange({
    'acceptance.md': ACCEPTANCE
      .replace('node scripts/probe.mjs --fail | yes', '手工打开页面确认 | no'),
  });
  assert.equal(run(optional.dir).code, 0);
});

test('SCEN-CON-04 missing acceptance matrix is blocking', () => {
  const { dir } = makeChange({ 'acceptance.md': null });
  const result = run(dir);
  assert.equal(result.code, 1);
  assert.match(result.out, /业务验收矩阵/);
});

test('SCEN-CON-04 a matrix with no Required=yes row is blocking', () => {
  const { dir } = makeChange({ 'acceptance.md': ACCEPTANCE.replace(/\| yes \|/g, '| no |') });
  const result = run(dir);
  assert.equal(result.code, 1);
  assert.match(result.out, /Required=yes/);
});

test('SCEN-CON-04 matrix referencing an unknown task or scenario is blocking', () => {
  const { dir } = makeChange({
    'acceptance.md': ACCEPTANCE.replace('| T-02 |', '| T-42 |').replace('SCEN-DMO-02 | GET', 'SCEN-DMO-77 | GET'),
  });
  const result = run(dir);
  assert.equal(result.code, 1);
  assert.match(result.out, /不存在的任务 T-42/);
  assert.match(result.out, /未声明的场景 SCEN-DMO-77/);
});

test('SCEN-CON-04 an illegal write scope is blocking', () => {
  const { dir } = makeChange({ 'tasks.md': TASKS.replace('Write scope: src/a.mjs', 'Write scope: ../escape/a.mjs') });
  const result = run(dir);
  assert.equal(result.code, 1);
  assert.match(result.out, /非法路径/);
});

test('SCEN-CON-04 cross-change write scope overlap is advisory only', () => {
  // 顺序是人类在确认点 1 的决定，脚本不替人拦截。
  const { root, dir } = makeChange();
  const other = path.join(root, 'openspec', 'changes', 'other');
  fs.mkdirSync(path.join(other, 'specs', 'cap'), { recursive: true });
  fs.writeFileSync(path.join(other, 'specs', 'cap', 'spec.md'), SPEC.replace(/SCEN-DMO-0/g, 'SCEN-OTH-0'));
  fs.writeFileSync(path.join(other, 'tasks.md'), TASKS.replace(/T-0/g, 'T-1').replace(/SCEN-DMO-0/g, 'SCEN-OTH-0'));
  fs.writeFileSync(path.join(other, 'acceptance.md'), ACCEPTANCE.replace(/SCEN-DMO-0/g, 'SCEN-OTH-0').replace(/T-0/g, 'T-1'));
  const result = run(dir);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /HINT.*与活跃 change other 的写范围重叠/);
});

test('SCEN-CON-04 pod members are read from the field the consumers actually read', () => {
  // 冻结检查曾读 `taskIds`，而 reconcile.mjs 与 merge-task.mjs 都读 `tasks`。同一份文件在
  // 冻结时被判「没有成员」（只是 HINT），在执行时又被正确读取——冻结报告说没问题，
  // 两个入口对同一字段名的理解却不同。这条把名称固定到消费方那一侧。
  const ok = makeChange({ 'pod-members.json': JSON.stringify({ tasks: ['T-01', 'T-02'] }) });
  const okResult = run(ok.dir);
  assert.equal(okResult.code, 0, okResult.out);
  assert.doesNotMatch(okResult.out, /没有 tasks 成员/);

  // 旧字段名必须阻断，而不是留一条 HINT 让 Pod 到合流时才因空成员集失败。
  const legacy = makeChange({ 'pod-members.json': JSON.stringify({ taskIds: ['T-01', 'T-02'] }) });
  const legacyResult = run(legacy.dir);
  assert.equal(legacyResult.code, 1, legacyResult.out);
  assert.match(legacyResult.out, /旧字段名 taskIds/);

  // 未知任务仍要拦。
  const ghost = makeChange({ 'pod-members.json': JSON.stringify({ tasks: ['T-99'] }) });
  const ghostResult = run(ghost.dir);
  assert.equal(ghostResult.code, 1, ghostResult.out);
  assert.match(ghostResult.out, /不存在的任务 T-99/);
});

test('SCEN-CON-14 freeze check says up front whether pod members can merge in one go', () => {
  // Pod 是单次整体合流：成员之间的依赖由那一次合流一并满足。旧实现既不在冻结时
  // 说明，也不在合流时豁免，于是「Pod 成员间有依赖」只会在合流口变成 exit 35。
  const inside = makeChange({
    // T-02 本来就依赖 T-01：两者都在成员集内，属「同批可满足」。
    'pod-members.json': JSON.stringify({ tasks: ['T-01', 'T-02'] }),
  });
  const insideResult = run(inside.dir);
  assert.equal(insideResult.code, 0, insideResult.out);
  assert.match(insideResult.out, /依赖闭包完全落在成员集内/);

  // 依赖落在成员集之外：不会被同批豁免，冻结时就要说明合流前必须已被 first-parent 证明。
  const withThird = `${TASKS}
- [ ] 1.3 T-03 third task
  - Depends on: none
  - Write scope: src/c.mjs
  - Risk-surface: [none]
  - Review: mechanical
  - Verify with: \`node --test src/c.test.mjs\`
  - Scenarios: SCEN-DMO-02
`;
  const outside = makeChange({
    'tasks.md': withThird.replace('Depends on: none\n  - Write scope: src/a.mjs', 'Depends on: T-03\n  - Write scope: src/a.mjs'),
    'pod-members.json': JSON.stringify({ tasks: ['T-01', 'T-02'] }),
  });
  const outsideResult = run(outside.dir);
  assert.equal(outsideResult.code, 0, outsideResult.out);
  assert.match(outsideResult.out, /依赖 Pod 成员集之外的 T-03/);
});

test('SCEN-CON-04 --json emits the same verdict as the text form', () => {
  const { dir } = makeChange({ 'acceptance.md': null });
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [FREEZE, dir, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    stdout = error.stdout;
    assert.equal(error.status, 1);
  }
  const summary = JSON.parse(stdout);
  assert.ok(summary.blocking.some((item) => item.includes('acceptance.md')));
  assert.equal(summary.tasks, 2);
});

test('SCEN-CON-26 freeze check names the orchestrator routing in its own output', () => {
  // 2026-10-27 `eas-filing-and-local-ocr`：8 个任务够交 Shangshu，但冻结输出里只有 `tasks=8`，
  // 主会话在确认点 1 之后自己估「可以开工」，直接在本机写了实现。路由是冻结时数得出来的
  // 事实，必须由命令写出，不留给模型估算。
  //
  // 默认夹具：T-01 mechanical（1 次派发）+ T-02 standard（写手 + 审计 2 次）= 3 次 → pod。
  const pod = makeChange({});
  const podResult = run(pod.dir);
  assert.equal(podResult.code, 0, podResult.out);
  assert.match(podResult.out, /\[ROUTE\] pod：预计派发 3 次（<6）/);

  // 加一个 standard 任务补到 4 次仍不够；再加两个到 6 次必须转 lead。strict 档另算一次 Tester。
  const extra = ['1.3 T-03 third task', '1.4 T-04 fourth task', '1.5 T-05 fifth task']
    .map((title, index) => `
- [ ] ${title}
  - Depends on: none
  - Write scope: src/e${index}.mjs
  - Risk-surface: [none]
  - Review: standard
  - Verify with: \`node --test src/e${index}.test.mjs\`
  - Scenarios: SCEN-DMO-02
`).join('');
  const lead = makeChange({ 'tasks.md': `${TASKS}${extra}` });
  const leadResult = run(lead.dir);
  assert.equal(leadResult.code, 0, leadResult.out);
  // 3 + 3×2 = 9 次。
  assert.match(leadResult.out, /\[ROUTE\] lead：预计派发 9 次（≥6）/);
  assert.match(leadResult.out, /agent_profile_shangshu/);

  // --json 侧同一结论，便于编排器直接读取。
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [FREEZE, lead.dir, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    stdout = error.stdout;
  }
  const summary = JSON.parse(stdout);
  assert.equal(summary.route, 'lead');
  assert.equal(summary.dispatches, 9);
});
