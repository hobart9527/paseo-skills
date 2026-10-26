// 状态观测适配器的契约防漂移测试（单一适配器 lib/paseo-state.mjs）。
//
// 为什么单独一个测试文件：2026-10-25 的 P0 断裂不是逻辑写错，而是**测试替身脱离了真实契约**——
// 旧 reconcile.test.mjs 把 labels 塞进 `paseo ls --json` 的输出，而真实 CLI 0.12.0 从不输出该字段。
// 于是 110 个用例全绿，生产上却把所有 agent 都过滤掉了。任何测试替身都必须源自真实录制，
// 本文件用 test/fixtures/paseo-state/ 下的真实录制样本把这条规则钉死：
//   1. 录制样本的形状被断言（字段集合、status 取值、labels 存在性）；
//   2. 适配器直接吃录制样本，产出可预期的规范化结果与 runtime 判定；
//   3. 替身构造出的形状必须与录制样本一致，否则测试自己失败（而不是等到生产才发现）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readPaseoState, selectChange, attributeAgent, belongsToChange, hasPipelineMarker,
  LIVE_STATUSES, KNOWN_STATUSES,
} from '../lib/paseo-state.mjs';
import { CONTROL_ROLES, WRITER_ROLES, READONLY_ROLES, KNOWN_ROLES, isControlRole, normalizePhase, PHASE_ORDER, DISPOSITIONS } from '../lib/roles.mjs';

const fixtureDir = fileURLToPath(new URL('./fixtures/paseo-state', import.meta.url));
const sample = (name) => JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8'));

const LS_ALL = sample('ls-json-all-label.json');
const LS_PLAIN = sample('ls-json-plain.json');
const TAGGED_WRITER = sample('tagged-closed-writer.json');
const UNTAGGED_WRITER = sample('untagged-pipeline-writer.json');
const UNRELATED = sample('unrelated-session.json');

/** 真实 `paseo ls --json` 一行的字段集合；任何替身/解析都不允许假设更多。 */
const LS_ROW_KEYS = ['created', 'cwd', 'id', 'name', 'provider', 'shortId', 'status', 'thinking'];

// ---------------------------------------------------------------------------
// 1. 录制样本本身的契约
// ---------------------------------------------------------------------------

test('recorded ls samples keep the 8-field row shape and carry no labels', () => {
  for (const recorded of [LS_ALL, LS_PLAIN]) {
    assert.equal(recorded.paseoVersion, '0.12.0', '录制样本必须标注采集时的 CLI 版本');
    assert.ok(recorded.recordedAt, '录制样本必须带采集时间');
    assert.deepEqual(recorded.rowKeys, LS_ROW_KEYS);
    assert.ok(recorded.rows.length > 0);
    for (const row of recorded.rows) {
      assert.deepEqual(Object.keys(row).sort(), [...LS_ROW_KEYS].sort(), '每行字段必须与 rowKeys 一致');
      assert.ok(!('labels' in row), '`paseo ls --json` 不含 labels —— 这正是旧实现的断裂点');
    }
  }
});

test('recorded persistent samples carry pipeline.* labels and the real status field', () => {
  assert.equal(TAGGED_WRITER.lastStatus, 'closed');
  assert.equal(TAGGED_WRITER.labels['pipeline.change'], 'eas-substitute-phase3-phase4');
  assert.equal(TAGGED_WRITER.labels['pipeline.role'], 'ceshi');
  assert.equal(TAGGED_WRITER.labels['pipeline.task'], 'T-05');
  assert.equal(TAGGED_WRITER.labels['pipeline.attempt'], '1');
  // 真实数据里 phase 是 TEST_FIRST（大写 + 下划线），不是小写 impl/test/audit。
  assert.equal(TAGGED_WRITER.labels['pipeline.phase'], 'TEST_FIRST');
  assert.equal(normalizePhase(TAGGED_WRITER.labels['pipeline.phase']), 'test');
  assert.ok(!('status' in TAGGED_WRITER), '持久记录用 lastStatus，不是 status');

  // 标题通道真实存在且格式自由：labels 里没有任何 pipeline.* 键，只有 [Pipeline] 前缀标题。
  assert.equal(UNTAGGED_WRITER.lastStatus, 'closed');
  assert.equal(Object.keys(UNTAGGED_WRITER.labels).filter((key) => key.startsWith('pipeline.')).length, 0);
  assert.equal(attributeAgent(UNTAGGED_WRITER).source, 'title');
  assert.match(UNTAGGED_WRITER.title, /^\[Pipeline\]/);
  assert.ok(hasPipelineMarker(UNTAGGED_WRITER), '标题前缀本身就是流水线标记');

  // 无关人类会话：标题不是 [Pipeline]，也没有 pipeline.* 标签。
  assert.ok(!hasPipelineMarker(UNRELATED));
});

test('recorded samples only use statuses the adapter claims to know', () => {
  for (const record of [TAGGED_WRITER, UNTAGGED_WRITER, UNRELATED]) {
    assert.ok(KNOWN_STATUSES.has(record.lastStatus), `未收录的状态: ${record.lastStatus}`);
  }
  for (const status of ['running', 'initializing', 'idle', 'closed', 'error']) {
    assert.ok(KNOWN_STATUSES.has(status));
  }
  assert.deepEqual([...LIVE_STATUSES].sort(), ['initializing', 'running']);
});

// ---------------------------------------------------------------------------
// 2. 适配器吃真实录制样本
// ---------------------------------------------------------------------------

/**
 * 由持久记录派生 `paseo ls` 行 —— 形状**逐字段照抄**录制样本 LS_ROW_KEYS，
 * 不引入 labels 等真实 CLI 不输出的字段。这就是「替身必须源自真实录制」的落地方式：
 * 本体形状来自 fixture，取值来自用例数据。
 */
function lsRowsFor(records) {
  return records.map((record, index) => {
    const row = {
      id: record.id,
      shortId: String(record.id).slice(0, 7),
      name: record.title ?? record.id,
      provider: 'codex/gpt',
      thinking: 'high',
      status: record.lastStatus,
      cwd: record.cwd,
      created: `${index + 1} minutes ago`,
    };
    assert.deepEqual(Object.keys(row).sort(), [...LS_ROW_KEYS].sort(), '派生行必须与录制样本字段一致');
    return row;
  });
}

/** 用录制样本搭一个临时 ~/.paseo 与 `paseo` 替身，返回适配器读数。 */
function adapterOn(t, { persistent = [], rows, permits = [], mode = 'ok', noHome = false }) {
  const root = mkdtempSync(path.join(tmpdir(), 'pipeline-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'paseo-home');
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  if (!noHome) {
    const agentsDir = path.join(home, 'agents', '-recorded-slug');
    mkdirSync(agentsDir, { recursive: true });
    for (const record of persistent) {
      writeFileSync(path.join(agentsDir, `${record.id}.json`), JSON.stringify(record, null, 2));
    }
  }
  const payload = path.join(root, 'payload.json');
  const resolvedRows = rows === undefined ? lsRowsFor(persistent) : rows;
  writeFileSync(payload, JSON.stringify({ rows: resolvedRows, permits, mode }));
  writeFileSync(path.join(bin, 'paseo'), `#!${process.execPath}
import { readFileSync } from 'node:fs';
const payload = JSON.parse(readFileSync(${JSON.stringify(payload)}, 'utf8'));
const argv = process.argv.slice(2);
if (payload.mode === 'exit') { process.stderr.write('daemon unavailable\\n'); process.exit(1); }
const emit = (value) => process.stdout.write(payload.mode === 'garbage' ? 'not JSON' : JSON.stringify(value));
if (argv[0] === 'permit') {
  if (payload.mode === 'permit-broken') { process.stderr.write('permission source down\\n'); process.exit(1); }
  emit(payload.permits);
}
else if (argv[0] === 'ls') emit(payload.rows);
else process.exit(2);
`, { mode: 0o755 });
  const saved = { home: process.env.PIPELINE_PASEO_HOME, bin: process.env.PIPELINE_PASEO_BIN };
  process.env.PIPELINE_PASEO_HOME = home;
  process.env.PIPELINE_PASEO_BIN = path.join(bin, 'paseo');
  t.after(() => {
    if (saved.home === undefined) delete process.env.PIPELINE_PASEO_HOME;
    else process.env.PIPELINE_PASEO_HOME = saved.home;
    if (saved.bin === undefined) delete process.env.PIPELINE_PASEO_BIN;
    else process.env.PIPELINE_PASEO_BIN = saved.bin;
  });
  return readPaseoState();
}

test('adapter normalizes real recorded samples: persistent + CLI agree → runtime ok', (t) => {
  const state = adapterOn(t, { persistent: [TAGGED_WRITER, UNTAGGED_WRITER, UNRELATED] });
  assert.equal(state.runtime, 'ok', state.runtimeEvidence.join(' | '));
  assert.equal(state.agents.length, 3);
  assert.equal(state.cliIds.length, 3);

  const writer = state.agents.find((a) => a.id === TAGGED_WRITER.id);
  assert.equal(writer.status, 'closed');
  assert.equal(writer.live, false);
  assert.equal(writer.labelsPresent, true);
  assert.equal(attributeAgent(writer).trusted, true, '有 pipeline.change 标签 → 标签通道可信');

  const untagged = state.agents.find((a) => a.id === UNTAGGED_WRITER.id);
  assert.equal(untagged.labelsPresent, true);
  const attribution = attributeAgent(untagged);
  assert.equal(attribution.source, 'title', '无 pipeline 标签时退化为标题通道');
  assert.equal(attribution.trusted, false, '标题通道不可信 —— 标题会被截断到 60 字符');
});

test('live status is derived from lastStatus, the field the persistent record actually uses', (t) => {
  const running = { ...TAGGED_WRITER, id: 'running-writer', lastStatus: 'running' };
  const state = adapterOn(t, { persistent: [running, TAGGED_WRITER] });
  const member = state.agents.find((a) => a.id === 'running-writer');
  assert.equal(member.live, true);
  assert.equal(state.agents.find((a) => a.id === TAGGED_WRITER.id).live, false);
});

test('SCEN-PS-LIVE-CLI a CLI live status outranks a stale closed persistent snapshot', (t) => {
  // 持久文件是落盘快照，daemon 才是活态。persistent=closed 但 CLI=running 意味着
  // 这个 agent 正在写文件；只信持久文件会把它算成终态写手 → cap 放行 → 同 scope 双写。
  const rows = lsRowsFor([TAGGED_WRITER]).map((row) => ({ ...row, status: 'running' }));
  const state = adapterOn(t, { persistent: [TAGGED_WRITER], rows });
  assert.equal(state.agents[0].live, true, state.runtimeEvidence.join(' | '));
  assert.match(state.runtimeEvidence.join(' | '), /状态不一致/);
});

test('adapter reports degraded when a persistent record lacks the labels key', (t) => {
  const { labels, ...withoutLabels } = TAGGED_WRITER;
  assert.ok(labels, 'fixture 必须真的带 labels，否则这个用例什么也没测');
  const state = adapterOn(t, { persistent: [withoutLabels, UNTAGGED_WRITER] });
  assert.equal(state.runtime, 'degraded', state.runtimeEvidence.join(' | '));
  assert.match(state.runtimeEvidence.join(' | '), /缺 labels 键/);
});

test('adapter reports degraded when the CLI answer contradicts the persistent source', (t) => {
  // 主源有记录，daemon 却一条都不知道 → 两源讲的不是同一件事，CLI 不可用于交叉校验。
  const state = adapterOn(t, { persistent: [TAGGED_WRITER], rows: [] });
  assert.equal(state.runtime, 'degraded', state.runtimeEvidence.join(' | '));
  assert.match(state.runtimeEvidence.join(' | '), /不存在的 agent id|主源/);
});

test('adapter reports degraded when the CLI knows agents absent from the persistent source', (t) => {
  const state = adapterOn(t, { persistent: [TAGGED_WRITER], rows: LS_ALL.rows });
  assert.equal(state.runtime, 'degraded', state.runtimeEvidence.join(' | '));
  assert.match(state.runtimeEvidence.join(' | '), /不存在的 agent id/);
});

test('adapter reports unavailable when both sources are unreadable', (t) => {
  const state = adapterOn(t, { persistent: [], noHome: true, mode: 'exit' });
  assert.equal(state.runtime, 'unavailable', state.runtimeEvidence.join(' | '));
  assert.match(state.runtimeEvidence.join(' | '), /主源不可读/);
});

test('empty-but-consistent sources are a real state, not a degradation', (t) => {
  // 主源可读且为空、CLI 一致为空：确实没有 agent。此时没有 labels 需要判定，不该降级——
  // 否则任何干净环境都会被判 degraded，fail-closed 就变成了永远不放行。
  const state = adapterOn(t, { persistent: [], rows: [] });
  assert.equal(state.runtime, 'ok', state.runtimeEvidence.join(' | '));
  assert.equal(state.agents.length, 0);
});

test('empty persistent source with an unusable CLI fails closed as unavailable', (t) => {
  // 空 + 读不到 CLI → 无法确认「确实没有 agent」，必须 unavailable。
  const state = adapterOn(t, { persistent: [], rows: [], mode: 'exit' });
  assert.equal(state.runtime, 'unavailable');
});

// ---------------------------------------------------------------------------
// 3. 归属双通道
// ---------------------------------------------------------------------------

test('attribution distinguishes label channel, truncated-title channel and foreign change', (t) => {
  const state = adapterOn(t, { persistent: [TAGGED_WRITER, UNTAGGED_WRITER, UNRELATED], rows: [] });
  const byId = new Map(state.agents.map((a) => [a.id, a]));

  const own = selectChange(state, 'eas-substitute-phase3-phase4');
  assert.deepEqual(own.members.map((a) => a.id).sort(), [TAGGED_WRITER.id, UNTAGGED_WRITER.id].sort());
  assert.deepEqual(own.suspicious, [], '两条都属于本 change，不该进 suspicious');

  // 无关人类会话既不是成员也不是嫌疑：否则任何旁路会话都会永久冻死派发。
  assert.ok(!own.members.some((a) => a.id === UNRELATED.id));
  assert.ok(!own.suspicious.some((a) => a.id === UNRELATED.id));

  // 换成完全不同的 change，两条 pipeline agent 的归属都不可判定（标题被截断），必须 fail closed。
  const other = selectChange(state, 'some-other-change-entirely');
  assert.equal(other.members.length, 0);
  assert.ok(!byId.get(TAGGED_WRITER.id).live, '本用例的样本是终态，suspicious 只看活体');

  // 标题通道截断兼容：60 字符截断后的 slug 是 change 的**前缀**，仍能指向同一 change。
  const truncated = { ...TAGGED_WRITER, labels: {}, title: '[Pipeline] ceshi T-06 eas-substitute-phase3-phas' };
  assert.equal(belongsToChange(truncated, 'eas-substitute-phase3-phase4').belongs, true);
});

// ---------------------------------------------------------------------------
// 3b. slug 归属方向（F4）与中文/自由格式标题的排除路径（F2）
// ---------------------------------------------------------------------------

test('F4: a superset slug (foo-bar) does not bind to change foo, and vice versa stays one-directional', (t) => {
  // 旧 slugMatches 双向匹配让 change `foo` 与 `foo-bar` 互相归属、互占 cap。
  // 修复后 token 比 change 长（`foo-bar` 是另一个 change 的完整 slug）不成立归属；
  // 反向（token 是本 change 的截断前缀）仍成立。
  const foreign = {
    ...TAGGED_WRITER, id: 'foreign-foo-bar', lastStatus: 'running', archivedAt: null,
    labels: {}, title: '[Pipeline] gongbu T-01 foo-bar',
  };
  const state = adapterOn(t, { persistent: [foreign] });
  const sel = selectChange(state, 'foo');
  assert.equal(sel.members.length, 0, '`foo-bar` 不得归属到 change `foo`');
  assert.equal(sel.suspicious.length, 0, '能证明属于另一个 change，应排除出 suspicious（不互冻）');
  assert.equal(belongsToChange({ ...foreign, title: '[Pipeline] gongbu T-01 foo' }, 'foo-bar').belongs, true,
    'token 是 change 的截断前缀（60 字符截断形态）仍成立归属');
});

test('F2: a Chinese tail token with a foreign change slug mid-title does not freeze dispatch', (t) => {
  // 自由格式标题 `[Pipeline] 巡检 复核 <change> 进行中`：尾 token 是中文，旧的尾 token
  // 判定必然失配 → suspicious → UNMAPPED → 别 change 的正常 agent 冻死本 change 派发。
  const agent = {
    ...TAGGED_WRITER, id: 'cn-foreign', lastStatus: 'running', archivedAt: null,
    labels: {}, title: '[Pipeline] 巡检 复核 other-change-v2 进行中',
  };
  const state = adapterOn(t, { persistent: [agent] });
  const sel = selectChange(state, 'reconcile-contract');
  assert.equal(sel.members.length, 0);
  assert.equal(sel.suspicious.length, 0, '中段 slug token 足以证明属于另一个 change，不得冻结本 change');
});

test('F2: a mid-title token prefix-related to the current change cannot prove foreignness', (t) => {
  // 中段 token 与本 change 同名（或是它的截断前缀）：可能是本 change 自己的 agent 用了
  // 自由格式标题，归属不可判定，必须保持 fail closed。
  const agent = {
    ...TAGGED_WRITER, id: 'cn-ambiguous', lastStatus: 'running', archivedAt: null,
    labels: {}, title: '[Pipeline] 巡检 复核 reconcile-contract 进行中',
  };
  const state = adapterOn(t, { persistent: [agent] });
  const sel = selectChange(state, 'reconcile-contract');
  assert.equal(sel.suspicious.length, 1, '与本 change 前缀相关的中段 token 不得用来排除嫌疑');
});

test('F2: bare title verbs (dispatch/hotfix/review) never count as foreign change slugs', (t) => {
  // 中段 token 缺少位置锚点，必须比尾 token 更强的形态证据（含 `-`、`.` 或数字），
  // 否则 `dispatch`/`hotfix`/`review` 这些标题动词会被当成「另一个 change 的 slug」，
  // 把真正归属不可判定的 agent 放出 suspicious —— 那是放松 fail closed，绝不允许。
  for (const verb of ['dispatch', 'hotfix', 'review']) {
    const agent = {
      ...TAGGED_WRITER, id: `cn-verb-${verb}`, lastStatus: 'running', archivedAt: null,
      labels: {}, title: `[Pipeline] 总控 ${verb} 进行中`,
    };
    const state = adapterOn(t, { persistent: [agent] });
    const sel = selectChange(state, 'reconcile-contract');
    assert.equal(sel.suspicious.length, 1, `标题动词 ${verb} 不得被当成外部 change slug`);
  }
});

// ---------------------------------------------------------------------------
// 4. 角色集合单点定义
// ---------------------------------------------------------------------------

test('role sets are single-sourced and match the observed production distribution', () => {
  // 2026-10-25 实测 68 个 pipeline agent 的 role 分布：
  //   anchasi36, gongbu9, gaogong8, ceshi7, yushi5, qingqibing1, lead1, 缺失1
  // 其中 yushi 与 lead 曾被 reconcile/merge-task/dispatch 三处各自的集合漏掉。
  for (const role of ['anchasi', 'gongbu', 'gaogong', 'ceshi', 'qingqibing']) {
    assert.ok(KNOWN_ROLES.has(role), `${role} 必须被识别`);
  }
  for (const role of ['yushi', 'lead', 'shangshu', 'xunjian', 'mige', 'hanlin', 'chanpin']) {
    assert.ok(isControlRole(role), `${role} 必须归控制面`);
  }
  for (const role of ['dalisi', 'dalisi_gemini']) {
    assert.ok(isControlRole(role), 'dalisi* 别名族必须归控制面');
  }
  assert.ok(WRITER_ROLES.has('jiangzuo'), 'jiangzuo 曾是三处定义不一致的漏网角色');
  assert.ok(READONLY_ROLES.has('anchasi'));
  assert.equal(CONTROL_ROLES.size + WRITER_ROLES.size + READONLY_ROLES.size, KNOWN_ROLES.size, '集合不得重叠');

  // 未知角色不能被当成控制面静默放行。
  for (const role of [undefined, null, '', 'unknown-role', 'T-01']) {
    assert.equal(isControlRole(role), false, `${String(role)} 不得被视为控制面`);
  }
});

test('phase normalization accepts the two real case styles and rejects the rest', () => {
  // 真实数据同时存在 impl/test/audit 与 TEST_FIRST/AUDITING 两套写法。
  for (const [raw, expected] of [
    ['impl', 'impl'], ['IMPL', 'impl'],
    ['test', 'test'], ['TEST_FIRST', 'test'], ['test-first', 'test'],
    ['audit', 'audit'], ['AUDITING', 'audit'],
    ['spec', 'spec'], ['spec-review', 'spec'],
    ['merge', 'merge'],
  ]) {
    assert.equal(normalizePhase(raw), expected, `${raw} → ${expected}`);
  }
  for (const raw of [undefined, null, '', '  ', 'totally-unknown']) {
    assert.equal(normalizePhase(raw), null, `${String(raw)} 必须返回 null 让调用方 fail closed`);
  }
  // 阶段序用于在多个终态 agent 中选「最新」：spec/test 同属最早，merge 最晚。
  assert.ok(PHASE_ORDER.test === PHASE_ORDER.spec);
  assert.ok(PHASE_ORDER.test < PHASE_ORDER.impl && PHASE_ORDER.impl < PHASE_ORDER.audit && PHASE_ORDER.audit < PHASE_ORDER.merge);

  // disposition 枚举：实测只出现过 rejected，但枚举必须覆盖监察与合流会写的全部取值。
  assert.deepEqual([...DISPOSITIONS].sort(), ['abandoned', 'handed-off', 'merged', 'rejected', 'superseded']);
});

// --- 以下三条来自 2026-10-26 真实缺口复核（修复前均可绕过） ---

test('an unusable permission source degrades runtime while agents are present', (t) => {
  // 权限源挂掉时 pendingPermission 恒为 false，一个卡在权限上的 agent 会被当成正常推进，
  // 人永远不知道该去批。有 agent 在场就是实质降级。
  const state = adapterOn(t, { persistent: [TAGGED_WRITER], mode: 'permit-broken' });
  assert.equal(state.runtime, 'degraded', state.runtimeEvidence.join(' | '));
  assert.match(state.runtimeEvidence.join(' | '), /权限源不可用且有 agent 在场/);
});

test('an unusable permission source does not degrade a genuinely empty workspace', (t) => {
  // 没有 agent 就没有权限暂停可隐藏；否则任何干净环境都会被判降级，fail-closed 变成永不放行。
  const state = adapterOn(t, { persistent: [], rows: [], mode: 'permit-broken' });
  assert.equal(state.runtime, 'ok', state.runtimeEvidence.join(' | '));
});

test('an archived record still marked running counts live only when the CLI still knows it', (t) => {
  const archivedRunning = { ...TAGGED_WRITER, id: 'archived-running', lastStatus: 'running', archivedAt: '2026-10-25T00:00:00.000Z' };
  // CLI 仍报它 running：两条来源一致说「在跑」，按 live 保守占位（漏算写手会放开 cap 双写）。
  const known = adapterOn(t, { persistent: [archivedRunning] });
  assert.equal(known.agents[0].live, true, known.runtimeEvidence.join(' | '));

  // CLI 完全不认识它：archive 已生效，不能再永久占住 cap 把任务卡死。
  const forgotten = adapterOn(t, { persistent: [archivedRunning], rows: [] });
  assert.equal(forgotten.agents[0].live, false, forgotten.runtimeEvidence.join(' | '));
  assert.match(forgotten.runtimeEvidence.join(' | '), /已归档且 CLI 不认识/);
});
