#!/usr/bin/env node
// 证据校验器：结构合法 ≠ 能力验收通过。
//
// 旧实现只校验字段存在性，于是 `result: FAIL` 与 `verdict: anything` 都能 exit 0，
// 收尾时「跑了一遍 check-evidence 且通过」被当成验收完成。真实反例见 pipelinenative-closure：
// T-08/T-09 已勾选并挂 pass review，但 smoke 是 FAIL、audit 是 PASS_SCRIPT_FAIL_NATIVE_RELAY。
//
// 因此这里有两道**语义不同**的闸门：
//   structure  字段与格式齐全，FAIL 也是合法的调查留档（exit 0）
//   acceptance 只接受约定的通过结论 + 未过期的 revision + 无未验证项（FAIL 一律 exit 1）
//
// 用法:
//   node check-evidence.mjs [--kind smoke|audit] [--gate structure|acceptance|all]
//                            [--sha <expected-40-or-7>] [--matrix <acceptance.md>]
//                            [--require-scenario SCEN-1,SCEN-2] <file>
//   --gate 默认 structure（留档用）；收尾验收必须显式 --gate acceptance。
//   --matrix 从冻结的验收矩阵读必需场景：调用者只能追加（--require-scenario），不能减少。
import fs from 'node:fs';
import { findAgentRecord } from '../lib/paseo-state.mjs';
import { NOT_COLLECTED_BLOCKING_FIELDS, SMOKE_REQUIRED_FIELDS, isContractField, COMMAND_FIELD_RE } from '../lib/evidence-contract.mjs';

const PASSING_VERDICTS = new Set(['pass', 'pass_with_nits', 'passed']);
const FAILING_VERDICTS = new Set(['fail', 'failed', 'blocked', 'skipped', 'unknown', 'inconclusive']);

const args = process.argv.slice(2);
let kind = 'smoke';
let gate = 'structure';
let expectedSha = null;
const requiredScenarios = [];
let filePath = null;
let matrixPath = null;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--kind') {
    kind = args[++i];
  } else if (arg === '--gate') {
    gate = args[++i];
  } else if (arg === '--sha') {
    expectedSha = args[++i] ?? null;
  } else if (arg === '--matrix') {
    matrixPath = args[++i] ?? null;
  } else if (arg === '--require-scenario') {
    // 逗号或空白分隔；可重复给出。
    for (const token of (args[++i] ?? '').split(/[,\s]+/).filter(Boolean)) requiredScenarios.push(token);
  } else if (!arg.startsWith('--')) {
    filePath = arg;
  }
}

if (!filePath) {
  console.error('Usage: node check-evidence.mjs [--kind smoke|audit] [--gate structure|acceptance|all]'
    + ' [--sha <sha>] [--matrix <acceptance.md>] [--require-scenario SCEN-1,SCEN-2] <file>');
  process.exit(1);
}
if (!['structure', 'acceptance', 'all'].includes(gate)) {
  console.error(`[check-evidence] Unknown gate: ${gate} (structure|acceptance|all)`);
  process.exit(1);
}
if (!fs.existsSync(filePath)) {
  console.error(`Error: File not found: ${filePath}`);
  process.exit(1);
}

const content = fs.readFileSync(filePath, 'utf8');

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/;
const field = (name) => content.match(new RegExp(`(?:^|\\n)\\s*${name}:\\s*(\\S*)`, 'i'))?.[1] ?? null;

/** `unverified:` 段落下的列表项（缩进的 `-` 行）。空列表即无未验证项。 */
function unverifiedItems() {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*unverified:\s*$/i.test(line));
  if (start === -1) return null;
  const items = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (!/^\s+[-*]\s+/.test(line)) break;
    items.push(line.trim().replace(/^[-*]\s+/, ''));
  }
  return items;
}

/**
 * 占位值检测。
 *
 * 结构闸门原本只校验字段「存在且格式合法」，于是 `notification_message_id: msg_01JAX_LOST_NOTIFICATION`
 * 这种明显是编造的占位符也能当合法收据留档——而它恰好出现在真实事故记录里，
 * 让「通知丢失」这个结论看起来有收据支撑，实际没有任何采集值。
 * 编造的值不是格式错误，是数据来源错误：必须与缺失同等对待。
 */
// 通用词（LOST/UNKNOWN/TEST/NOT_COLLECTED）必须带词边界：真实采集值可能把它们作为
// 子串嵌在标识里（如 ULID 片段 `01JAXLOSTFOUND`、英文词 `LATEST`/`TESTING`），无边界
// 子串匹配会误伤合法值；但编造收据惯用的分隔形态（`msg_01JAX_LOST_NOTIFICATION`）
// 仍必须命中。边界只认空白/下划线/字符串边缘——`.` 与 `/` 不算，否则合法值
// `a.test.mjs`、`bash test/run-all.sh` 会被 `.test.`、`test/` 误伤。
// PLACEHOLDER/TODO/FIXME/TBD/CHANGEME/DUMMY/SAMPLE/EXAMPLE 是占位专用词，保持子串匹配。
const PLACEHOLDER_BOUNDED = ['LOST', 'UNKNOWN', 'TEST', 'NOT[_-]?COLLECTED']
  .map((word) => `(?:^|[\\s_])${word}(?=[\\s_]|$)`)
  .join('|');
const PLACEHOLDER_RE = new RegExp(
  `(?:PLACEHOLDER|TODO|FIXME|TBD|CHANGEME|DUMMY|SAMPLE|EXAMPLE|${PLACEHOLDER_BOUNDED})`, 'i');
// 命令型字段的值本身就是一条 shell 命令，判据完全不同：`npm test`、`pytest -k test_`、
// `grep -q FOO .env.example`、`npm run test:sample`、`pytest tests/test_todo_api.py` 里的
// TEST/EXAMPLE/SAMPLE/TODO 是命令名或路径的一段，不是占位标记。对这类字段只拒**整值**
// 就是占位词的形态（`<verify>、PLACEHOLDER、TODO…`），其余一律按命令放行。
// 这比逐词加豁免更窄：子串形态的命令永远合法，编造的整值占位仍然拦得住。
const BARE_PLACEHOLDER_RE = new RegExp(
  `^(?:<[^>]*>|PLACEHOLDER|TODO|FIXME|TBD|CHANGEME|DUMMY|SAMPLE|EXAMPLE|LOST|UNKNOWN|NOT[_-]?COLLECTED)$`, 'i');
const ALL_SAME_CHAR_RE = /^([0-9a-f])\1{7,}$/i;

function placeholderFields() {
  const problems = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][\w.-]*):\s*(\S.*)$/);
    if (!match) continue;
    const [, name, rawValue] = match;
    // 只判闸门自己拥有的字段：`notes:` 之类的人话不是采集值，它的措辞不该决定收据存亡。
    if (!isContractField(name)) continue;
    const value = rawValue.trim();
    // 命令型字段（acceptance_command / verify_command / …）走整值判据，不走子串。
    const isPlaceholder = COMMAND_FIELD_RE.test(name)
      ? BARE_PLACEHOLDER_RE.test(value)
      : PLACEHOLDER_RE.test(value);
    if (isPlaceholder) {
      problems.push(`${name} 是占位值而不是采集值（${value.slice(0, 40)}）；采集不到请写「未采集」并说明原因`);
    } else if (ALL_SAME_CHAR_RE.test(value)) {
      problems.push(`${name} 是退化值（${value}），不是真实标识`);
    }
  }
  return problems;
}

// --- 结构闸门 ---
// 字段清单来自 lib/evidence-contract.mjs（模板与 docs 测试共用同一份），
// 这里只提供每个字段的判据。新增字段必须同时改那份清单——漏改会让模板与闸门漂移。
const SMOKE_VALIDATORS = {
  parent_agent_id: () => UUID_FIELD.test(content) && UUID_RE.test(field('parent_agent_id') ?? ''),
  child_agent_id: () => UUID_RE.test(field('child_agent_id') ?? ''),
  notification_message_id: () => /\S/.test(field('notification_message_id') ?? ''),
  dispatched_at: () => ISO_RE.test(field('dispatched_at') ?? ''),
  notification_at: () => ISO_RE.test(field('notification_at') ?? ''),
  result: () => /^(PASS|FAIL)$/i.test((field('result') ?? '').trim()) && /\b(PASS|FAIL)\b/i.test(content),
  relay_case: () => /\S/.test(field('relay_case') ?? ''),
  unverified: () => /(?:^|\n)\s*unverified:\s*/i.test(content),
};

function structureErrors() {
  const missing = [];
  if (kind === 'audit') {
    if (!/(?:^|\n)\s*verdict:\s*\S+/i.test(content)) missing.push('verdict:');
    if (!/(?:^|\n)\s*reviewed_sha:\s*[0-9a-f]{7,40}/i.test(content)) missing.push('reviewed_sha:');
    missing.push(...placeholderFields());
    return missing;
  }
  for (const name of SMOKE_REQUIRED_FIELDS) {
    const validate = SMOKE_VALIDATORS[name];
    // 清单里列了字段却没有判据 = 契约与校验漂移，必须当场暴露而不是静默跳过。
    if (!validate) throw new Error(`evidence-contract 列了 ${name}，但 structureErrors 没有它的判据`);
    if (!validate()) missing.push(`${name}${SMOKE_FIELD_HINTS[name] ? ` (${SMOKE_FIELD_HINTS[name]})` : ''}`);
  }
  missing.push(...placeholderFields());
  return missing;
}

const UUID_FIELD = /(?:^|\n)\s*parent_agent_id:\s*(\S+)/i;
const SMOKE_FIELD_HINTS = {
  parent_agent_id: 'valid UUID required',
  child_agent_id: 'valid UUID required',
  dispatched_at: 'valid ISO timestamp required',
  notification_at: 'valid ISO timestamp required',
  result: 'PASS|FAIL required',
  unverified: 'list',
};

/**
 * 必需场景的结论。
 *
 * `--require-scenario` 过去只要求该 ID「在证据里被提到」，于是注释、待办、或一句
 * 「SCEN-X 未验证」都能满足必需项——「被提到」与「被验证通过」是两件事。
 * 现在要求它在 `scenario_results:` 段落里有一条 `<ID>: PASS` 记录，
 * 且该 ID 不得同时出现在 unverified 列表里（自相矛盾必须拒绝）。
 */
function scenarioResults() {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*scenario_results:\s*$/i.test(line));
  const results = new Map();
  if (start === -1) return results;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const item = line.match(/^\s+[-*]\s+(\S+?)\s*[:=]\s*(\S+)/);
    if (!item) break;
    results.set(item[1].toUpperCase(), item[2].toUpperCase());
  }
  return results;
}

// --- 冻结的业务验收矩阵 ---
//
// 必需场景清单过去由调用者用 `--require-scenario` 现场给：漏传就等于没验，而漏传不会
// 产生任何报错。这里改为从冻结的 acceptance.md 读 Required=yes 的行，`--require-scenario`
// 只能**追加**（与 merge-task 对冻结 Verify 的口径一致：调用者只能收紧，不能放宽）。
function matrixRequiredScenarios(matrixFile) {
  const text = fs.readFileSync(matrixFile, 'utf8');
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^\s*\|/.test(line) && /\bScenario\b/i.test(line));
  if (headerIndex === -1) {
    throw new Error(`${matrixFile} 没有可解析的表格（表头须含 Scenario 列）`);
  }
  const header = lines[headerIndex].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const scenCol = header.indexOf('Scenario');
  const reqCol = header.indexOf('Required');
  const resCol = header.indexOf('Result');
  if (scenCol === -1 || reqCol === -1) {
    throw new Error(`${matrixFile} 表格缺 Scenario 或 Required 列`);
  }
  const required = [];
  const notPassed = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    if ((cells[reqCol] ?? '').toLowerCase() !== 'yes') continue;
    const scen = (cells[scenCol] ?? '').match(/SCEN-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/i)?.[0];
    if (!scen) continue;
    required.push(scen);
    const result = (cells[resCol] ?? '').toUpperCase();
    if (result !== 'PASS') notPassed.push(`${scen}=${result || '(空)'}`);
  }
  return { required, notPassed };
}

// --- 验收闸门 ---
// 只认约定的通过结论；未知结论不得当成通过。FAIL/BLOCKED/SKIPPED/未验证项之一即拒绝。
function acceptanceErrors() {
  const problems = [];
  // 验收必须先满足结构闸门：否则「字段齐全但结论为空」的文件会被 acceptance 单独放行
  // （实测：只含 result/dispatched_at/notification_at/unverified 的 smoke 曾 exit 0，
  // 连 child_agent_id、relay_case 都没有，却当成收据通过验收）。
  for (const missing of structureErrors()) problems.push(`结构不合格（缺 ${missing}）`);
  const sha = field('reviewed_sha');

  // 冻结的验收矩阵是必需场景的权威来源。
  const required = [...requiredScenarios];
  if (matrixPath !== null) {
    try {
      const matrix = matrixRequiredScenarios(matrixPath);
      for (const scenario of matrix.required) {
        if (!required.some((entry) => entry.toUpperCase() === scenario.toUpperCase())) required.push(scenario);
      }
      // 矩阵自己就是「算不算交付」的定义：Required 行没通过，收尾不得宣布验收完成。
      if (matrix.notPassed.length > 0) {
        problems.push(`验收矩阵里 Required 行未通过：${matrix.notPassed.join(', ')}；`
          + '须在收尾实测后回填 PASS（外部依赖接不通标 BLOCKED 并说明原因）');
      }
    } catch (error) {
      problems.push(error.message);
    }
  }

  // 证据必须能对上一个真实创建过的 agent，且时间线自洽。
  // 旧实现只校验 child_agent_id 是格式合法的 UUID：native-closure 的 smoke 写了一个
  // 不存在的 UUID（前 8 位与真实 agent 相同），dispatched_at 还早于真实 createdAt 十分钟，
  // 两道闸门都放行。「收据里有 UUID」与「这个 agent 真的被创建过」是两件事。
  const childId = (field('child_agent_id') ?? '').trim();
  if (kind === 'smoke' && childId !== '' && !PLACEHOLDER_RE.test(childId)) {
    if (process.env.PIPELINE_SKIP_PASEO_LOOKUP === '1') {
      // 显式豁免：Paseo 目录不在本机（CI 或另一台机器）时无法核对，必须显式声明。
      problems.push('PIPELINE_SKIP_PASEO_LOOKUP=1 跳过了 child_agent_id 真实性核对；'
        + '该证据只能作为结构留档，不能作为本机验收收据');
    } else {
      const record = findAgentRecord(childId);
      if (record === null) {
        problems.push(`child_agent_id ${childId} 在 Paseo 持久记录中不存在：`
          + '这不是一次真实派发的收据（读不到记录一律视为不可信，不做「无记录即通过」）');
      } else {
        const created = record.createdAt ? Date.parse(record.createdAt) : NaN;
        const dispatched = field('dispatched_at');
        const notify = field('notification_at');
        if (!Number.isFinite(created)) {
          problems.push(`agent ${childId} 的持久记录没有 createdAt，无法核对时间线`);
        } else {
          if (ISO_RE.test(dispatched ?? '') && Date.parse(dispatched) < created) {
            problems.push(`dispatched_at ${dispatched} 早于该 agent 的真实创建时间 ${record.createdAt}：收据时间线不成立`);
          }
          if (ISO_RE.test(notify ?? '') && Date.parse(notify) < created) {
            problems.push(`notification_at ${notify} 早于该 agent 的真实创建时间 ${record.createdAt}: 收据时间线不成立`);
          }
        }
      }
    }
  }

  // 「未采集」是合法的留档值，但不是可验收值。
  //
  // 采集不到时如实写「未采集」是对的（不许编造），structure 闸门必须放行——否则人只
  // 有一个选择：编一个值。但把这些字段当验收证据同样不成立：验收要的是「这份收据证明
  // 了某件真事」，而「未采集」证明的是没采到。实测：`notification_message_id: 未采集`
  // 与 `relay_case: 未采集` 的文件两道闸门都 rc=0。
  if (kind === 'smoke') {
    for (const name of NOT_COLLECTED_BLOCKING_FIELDS) {
      const value = (field(name) ?? '').trim();
      if (value === '未采集' || /^未采集[（(，,。.\s]/.test(value)) {
        problems.push(`${name} 是「未采集」：可以作为留档，不能作为验收收据；采到真实值后再验收`);
      }
    }
  }

  // 验收必须绑定 revision：没有 `--sha` 就无法证明这份证据对应的是当前集成分支。
  // 该要求对 smoke 与 audit 同等适用。旧实现只对 audit 要求 --sha，于是冒烟证据可以
  // 完全脱离 revision 通过验收——「验证通过了」与「验证的是哪份代码」脱钩，
  // 节点在合流推进后仍是绿的。smoke 已带 reviewed_sha 时还要与该 revision 相符。
  if (expectedSha === null) {
    problems.push('验收闸门必须给 --sha <集成 HEAD>：无 revision 绑定的证据不能证明当前代码被验证过');
  }

  if (kind === 'audit') {
    const verdict = (field('verdict') ?? '').trim().toLowerCase();
    if (verdict === '') {
      problems.push('缺少 verdict');
    } else if (FAILING_VERDICTS.has(verdict)) {
      problems.push(`verdict=${verdict} 不是通过结论（验收只接受 ${[...PASSING_VERDICTS].join('/')}）`);
    } else if (!PASSING_VERDICTS.has(verdict)) {
      problems.push(`verdict=${verdict} 不是已约定的通过结论；未知结论不得折算为通过`);
    }
    if (!sha) {
      problems.push('缺少 reviewed_sha');
    } else if (expectedSha !== null && !shasAgree(sha, expectedSha)) {
      problems.push(`reviewed_sha=${sha} 与验收 revision ${expectedSha} 不符（审查记录已过期）`);
    }
  } else {
    const result = (field('result') ?? '').trim().toUpperCase();
    if (result !== 'PASS') {
      problems.push(`result=${result || '(缺失)'} 不是 PASS；调查完成不等于被调查能力通过`);
    }
    const dispatched = field('dispatched_at');
    const notify = field('notification_at');
    if (dispatched && notify && ISO_RE.test(dispatched) && ISO_RE.test(notify)) {
      const from = Date.parse(dispatched);
      const to = Date.parse(notify);
      if (Number.isFinite(from) && Number.isFinite(to) && to < from) {
        problems.push(`notification_at ${notify} 早于 dispatched_at ${dispatched}：时间线不可能，收据不可信`);
      }
    }
    const unverified = unverifiedItems();
    if (unverified === null) {
      problems.push('缺少 unverified 段：无法判定是否存在未验证项');
    } else if (unverified.length > 0) {
      problems.push(`存在 ${unverified.length} 项未验证：${unverified.slice(0, 3).join('; ')}；未验证不能折算 PASS`);
    }
    if (expectedSha !== null && sha && !shasAgree(sha, expectedSha)) {
      problems.push(`reviewed_sha=${sha} 与验收 revision ${expectedSha} 不符`);
    }
  }

  for (const scenario of required) {
    // 按 token 边界匹配，不用裸子串：`SCEN-1` 会命中 `SCEN-10`，
    // 于是拿一条无关场景的证据就能满足必需项（实测验证过）。
    const boundary = new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(scenario)}(?![A-Za-z0-9-])`, 'i');
    if (!boundary.test(content)) {
      problems.push(`必需场景 ${scenario} 在本证据中没有任何引用`);
      continue;
    }
    // 「被提到」不等于「被验证通过」：注释、TODO、甚至一句「SCEN-X 未验证」都能满足引用。
    const results = scenarioResults();
    const outcome = results.get(scenario.toUpperCase());
    if (outcome === undefined) {
      problems.push(`必需场景 ${scenario} 只在正文里被提到，没有 scenario_results 中的 PASS 结论`);
    } else if (outcome !== 'PASS') {
      problems.push(`必需场景 ${scenario} 的结论是 ${outcome}，不是 PASS`);
    }
    const unverified = unverifiedItems() ?? [];
    const contradicted = unverified.find((item) => {
      const token = new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(scenario)}(?![A-Za-z0-9-])`, 'i');
      return token.test(item);
    });
    if (contradicted) {
      problems.push(`必需场景 ${scenario} 同时出现在 unverified 列表（${contradicted}）：结论自相矛盾`);
    }
  }
  return problems;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 允许 7 位前缀与完整 sha 互比，但要求短的一方是长的一方的前缀。 */
function shasAgree(reported, expected) {
  const a = reported.trim().toLowerCase();
  const b = expected.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(a) || !/^[0-9a-f]{7,40}$/.test(b)) return false;
  return a.startsWith(b) || b.startsWith(a);
}

const failures = [];
if (gate === 'structure' || gate === 'all') {
  const missing = structureErrors();
  if (missing.length > 0) failures.push(`结构不合格（缺 ${missing.join(', ')}）`);
}
if (gate === 'acceptance' || gate === 'all') {
  failures.push(...acceptanceErrors());
}

const label = kind === 'audit' ? 'Audit' : 'Smoke';
if (failures.length > 0) {
  console.error(`[check-evidence] ${label} evidence rejected (gate=${gate}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`[check-evidence] ${label} evidence valid (gate=${gate}): ${filePath}`);
if (gate === 'structure') {
  console.log('[check-evidence] 注意：structure 闸门只证明字段齐全，不构成验收通过。');
}
process.exit(0);
