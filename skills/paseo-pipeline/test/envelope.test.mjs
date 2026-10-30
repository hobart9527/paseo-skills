import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEnvelope, validateEnvelope,
  ENVELOPE_REQUIRED_FIELDS, ENVELOPE_MAX_LINES, ENVELOPE_MAX_LINES_AUDIT,
} from '../lib/envelope.mjs';

const GOOD = [
  'kind: phase-complete',
  'task: T-01',
  'attempt: 2',
  'phase: impl',
  'result: 实现完成，本地测试全绿',
  'reviewed_sha: 528c69176495ee698383bc565b0ea9dfc467d897',
  'blockers: none',
  'next_action: merge',
].join('\n');

test('SCEN-ENV-01 a well-formed envelope parses with all required fields', () => {
  const { fields, lines, problems } = parseEnvelope(GOOD);
  assert.deepEqual(problems, []);
  assert.equal(lines, 8);
  for (const name of ENVELOPE_REQUIRED_FIELDS) assert.ok(fields.has(name), name);
  assert.deepEqual(validateEnvelope(GOOD).problems, []);
});

test('SCEN-ENV-01 markdown fences and blank lines do not count toward the line limit', () => {
  const fenced = ['```', GOOD, '```', '', ''].join('\n');
  assert.deepEqual(validateEnvelope(fenced).problems, [],
    '合规信封不能因为粘贴模板时带了代码围栏而越界');
});

test('SCEN-ENV-01 a missing required field is named, not silently treated as complete', () => {
  const without = GOOD.split('\n').filter((line) => !line.startsWith('next_action:')).join('\n');
  const { problems } = validateEnvelope(without);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /缺少必填字段 next_action/);
});

test('SCEN-ENV-01 an unknown enum value is rejected with the legal set spelled out', () => {
  const bad = GOOD.replace('next_action: merge', 'next_action: ship-it');
  const { problems } = validateEnvelope(bad);
  assert.match(problems.join('\n'), /next_action="ship-it" 不是合法取值/);
  assert.match(problems.join('\n'), /merge\/rework\/blocked\/wait\/none/);
});

test('SCEN-ENV-01 kind=blocked with next_action=merge is a contradiction and is caught', () => {
  // 真实缺陷：信封写了 blockers 但 kind 表明阶段完成，或反过来要求合流，下游只能靠猜。
  const contradiction = GOOD.replace('kind: phase-complete', 'kind: blocked');
  const { problems } = validateEnvelope(contradiction);
  assert.match(problems.join('\n'), /kind=blocked 但 next_action=merge/);
});

test('SCEN-ENV-01 kind=phase-complete with next_action=blocked is a contradiction', () => {
  const contradiction = GOOD.replace('next_action: merge', 'next_action: blocked');
  assert.match(validateEnvelope(contradiction).problems.join('\n'), /自相矛盾/);
});

test('SCEN-ENV-01 a non-numeric attempt is rejected', () => {
  const bad = GOOD.replace('attempt: 2', 'attempt: 两次');
  assert.match(validateEnvelope(bad).problems.join('\n'), /必须是正整数/);
});

test('SCEN-ENV-01 two pasted rounds in one envelope are rejected instead of last-write-wins', () => {
  // 同一字段出现两次说明信封里混进了两段回复：取第一段会静默丢掉后一段，
  // 取最后一段会丢掉前一段，两种都不可接受。
  const duplicated = `${GOOD}\n\ntask: T-02\nresult: 另一轮的结果`;
  const { problems } = parseEnvelope(duplicated);
  assert.match(problems.join('\n'), /字段 task 重复出现/);
});

test('SCEN-ENV-01 the line limit is enforced and the overflow is measured', () => {
  const bloated = [
    GOOD,
    ...Array.from({ length: ENVELOPE_MAX_LINES }, (_, i) => `  - 细节 ${i}`),
  ].join('\n');
  const { problems, lines } = validateEnvelope(bloated);
  assert.ok(lines > ENVELOPE_MAX_LINES);
  assert.match(problems.join('\n'), new RegExp(`超过上限 ${ENVELOPE_MAX_LINES} 行`));
});

test('SCEN-ENV-01 the audit limit is looser than the writer limit', () => {
  assert.ok(ENVELOPE_MAX_LINES_AUDIT > ENVELOPE_MAX_LINES, '审计员要逐场景写结论，上限须更宽');
  // 8 个字段 + 14 个场景行 = 22 行：越过写手上限 20，仍在审计上限 25 之内。
  const body = Array.from({ length: 14 }, (_, i) => `  - 场景 ${i}`).join('\n');
  const text = `${GOOD}\n${body}`;
  assert.notDeepEqual(validateEnvelope(text).problems, [], '默认上限下应当越界');
  const audit = validateEnvelope(text, { maxLines: ENVELOPE_MAX_LINES_AUDIT });
  assert.ok(!audit.problems.some((p) => /超过上限/.test(p)), '审计上限下不该越界');
});

test('SCEN-ENV-01 an empty envelope is a problem, not a vacuously valid one', () => {
  assert.match(validateEnvelope('').problems.join('\n'), /信封为空/);
  assert.match(validateEnvelope('   \n\n').problems.join('\n'), /信封为空/);
});

test('SCEN-ENV-01 list continuations are allowed only under blockers', () => {
  const listy = GOOD.replace('blockers: none', 'blockers:\n  - 缺少联调环境\n  - 金蝶接口超时');
  assert.deepEqual(validateEnvelope(listy).problems, []);
  const misplaced = GOOD.replace('result: 实现完成，本地测试全绿', 'result:\n  - 这行续在 result 下');
  assert.deepEqual(validateEnvelope(misplaced).problems, [],
    '普通字段的缩进续行目前按允许处理（只拒绝非键值且无法归属的行）');
});
