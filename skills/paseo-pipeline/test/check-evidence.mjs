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
//                            [--sha <expected-40-or-7>] [--require-scenario SCEN-1,SCEN-2] <file>
//   --gate 默认 structure（留档用）；收尾验收必须显式 --gate acceptance。
import fs from 'node:fs';

const PASSING_VERDICTS = new Set(['pass', 'pass_with_nits', 'passed']);
const FAILING_VERDICTS = new Set(['fail', 'failed', 'blocked', 'skipped', 'unknown', 'inconclusive']);

const args = process.argv.slice(2);
let kind = 'smoke';
let gate = 'structure';
let expectedSha = null;
const requiredScenarios = [];
let filePath = null;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--kind') {
    kind = args[++i];
  } else if (arg === '--gate') {
    gate = args[++i];
  } else if (arg === '--sha') {
    expectedSha = args[++i] ?? null;
  } else if (arg === '--require-scenario') {
    // 逗号或空白分隔；可重复给出。
    for (const token of (args[++i] ?? '').split(/[,\s]+/).filter(Boolean)) requiredScenarios.push(token);
  } else if (!arg.startsWith('--')) {
    filePath = arg;
  }
}

if (!filePath) {
  console.error('Usage: node check-evidence.mjs [--kind smoke|audit] [--gate structure|acceptance|all]'
    + ' [--sha <sha>] [--require-scenario SCEN-1,SCEN-2] <file>');
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
const PLACEHOLDER_RE = /(?:PLACEHOLDER|TODO|FIXME|TBD|CHANGEME|DUMMY|SAMPLE|EXAMPLE|LOST|UNKNOWN_|_TEST_|NOT[_-]?COLLECTED)/i;
const ALL_SAME_CHAR_RE = /^([0-9a-f])\1{7,}$/i;

function placeholderFields() {
  const problems = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][\w.-]*):\s*(\S.*)$/);
    if (!match) continue;
    const [, name, rawValue] = match;
    const value = rawValue.trim();
    if (PLACEHOLDER_RE.test(value)) {
      problems.push(`${name} 是占位值而不是采集值（${value.slice(0, 40)}）；采集不到请写「未采集」并说明原因`);
    } else if (ALL_SAME_CHAR_RE.test(value)) {
      problems.push(`${name} 是退化值（${value}），不是真实标识`);
    }
  }
  return problems;
}

// --- 结构闸门 ---
function structureErrors() {
  const missing = [];
  if (kind === 'audit') {
    if (!/(?:^|\n)\s*verdict:\s*\S+/i.test(content)) missing.push('verdict:');
    if (!/(?:^|\n)\s*reviewed_sha:\s*[0-9a-f]{7,40}/i.test(content)) missing.push('reviewed_sha:');
    missing.push(...placeholderFields());
    return missing;
  }
  const parentMatch = content.match(/(?:^|\n)\s*parent_agent_id:\s*(\S+)/i);
  if (!parentMatch || !UUID_RE.test(parentMatch[1])) missing.push('parent_agent_id (valid UUID required)');
  const childMatch = content.match(/(?:^|\n)\s*child_agent_id:\s*(\S+)/i);
  if (!childMatch || !UUID_RE.test(childMatch[1])) missing.push('child_agent_id (valid UUID required)');
  if (!/(?:^|\n)\s*notification_message_id:\s*(\S+)/i.test(content)) missing.push('notification_message_id');
  const dispatched = field('dispatched_at');
  if (!dispatched || !ISO_RE.test(dispatched)) missing.push('dispatched_at (valid ISO timestamp required)');
  const notify = field('notification_at');
  if (!notify || !ISO_RE.test(notify)) missing.push('notification_at (valid ISO timestamp required)');
  if (!/(?:^|\n)\s*result:\s*(PASS|FAIL)\b/i.test(content)) missing.push('result (PASS|FAIL required)');
  if (!/(?:^|\n)\s*relay_case:\s*(\S+)/i.test(content)) missing.push('relay_case');
  if (!/(?:^|\n)\s*unverified:\s*/i.test(content)) missing.push('unverified: list');
  missing.push(...placeholderFields());
  return missing;
}

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

// --- 验收闸门 ---
// 只认约定的通过结论；未知结论不得当成通过。FAIL/BLOCKED/SKIPPED/未验证项之一即拒绝。
function acceptanceErrors() {
  const problems = [];
  // 验收必须先满足结构闸门：否则「字段齐全但结论为空」的文件会被 acceptance 单独放行
  // （实测：只含 result/dispatched_at/notification_at/unverified 的 smoke 曾 exit 0，
  // 连 child_agent_id、relay_case 都没有，却当成收据通过验收）。
  for (const missing of structureErrors()) problems.push(`结构不合格（缺 ${missing}）`);
  const sha = field('reviewed_sha');

  if (kind === 'audit') {
    const verdict = (field('verdict') ?? '').trim().toLowerCase();
    if (verdict === '') {
      problems.push('缺少 verdict');
    } else if (FAILING_VERDICTS.has(verdict)) {
      problems.push(`verdict=${verdict} 不是通过结论（验收只接受 ${[...PASSING_VERDICTS].join('/')}）`);
    } else if (!PASSING_VERDICTS.has(verdict)) {
      problems.push(`verdict=${verdict} 不是已约定的通过结论；未知结论不得折算为通过`);
    }
    if (expectedSha === null) {
      problems.push('验收闸门必须给 --sha <集成 HEAD>：无 revision 绑定的审计记录不能证明当前代码被审过');
    } else if (!sha) {
      problems.push('缺少 reviewed_sha');
    } else if (!shasAgree(sha, expectedSha)) {
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

  for (const scenario of requiredScenarios) {
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
