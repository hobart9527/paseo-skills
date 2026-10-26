// 角色与阶段集合的唯一定义点（single source of truth）。
// reconcile.mjs / merge-task.mjs / hotfix.sh 一律从此处引用，禁止各自复制集合。
// （`dispatch.mjs` 已于 2026-10-26 删除；hotfix.sh 用 node -e 内联读 profile，
//   不复制角色表，只是引用同一份 config.json。）
//
// 实测依据（2026-10-25，68 个 pipeline agent 的真实标签分布）：
//   role:   anchasi 36, gongbu 9, gaogong 8, ceshi 7, yushi 5, qingqibing 1, lead 1, 缺失 1
//   phase:  impl 11, audit 10, test 6, TEST_FIRST 1, AUDITING 1, spec 1, spec-review 1, 缺失 37
// 即：真实数据同时存在大小写两套 phase 与 reconcile 未识别的 role（lead/yushi）。

/** 控制面：不持 task 身份、不占写范围、不计入 cap。 */
export const CONTROL_ROLES = new Set([
  'shangshu', 'xunjian', 'yushi', 'mige', 'lead', 'orchestrator', 'hanlin', 'chanpin',
]);

/** 任务面写入者：持写范围、计入 cap、合流时校验作者血统。 */
// `qingqibing` 只为识别历史标签保留：它对应的 profile 已不在派发路径上，
// 新任务不得再以它下发；删掉会让带该标签的历史 agent 被判成 UNMAPPED 而无法对账。
export const WRITER_ROLES = new Set(['gongbu', 'gaogong', 'ceshi', 'jiangzuo', 'qingqibing']);

/** 任务面只读：需要 task/attempt/phase 身份，但不持写范围。 */
export const READONLY_ROLES = new Set(['anchasi']);

/** 全部被识别的角色（未识别角色按 fail-closed 处理为 UNMAPPED）。 */
export const KNOWN_ROLES = new Set([
  ...CONTROL_ROLES, ...WRITER_ROLES, ...READONLY_ROLES,
]);

/** dalisi* 为历史别名族（dalisi / dalisi_gemini），一律归控制面。 */
export function isControlRole(role) {
  if (typeof role !== 'string') return false;
  return CONTROL_ROLES.has(role) || role.startsWith('dalisi');
}

/**
 * 阶段归一化：接受大小写两套写法，未知阶段返回 null（调用方 fail closed）。
 *
 * 真实取值（2026-10-25 实测 68 个 agent）里出现过别名以外的两种写法：
 *   `execution`（gongbu 写手，等价 impl）与 `review`（anchasi 审计，等价 audit）。
 * 它们此前落到「未知 phase」→ agent 被判 UNMAPPED → 整个 change 派发被冻结。
 * 别名只做等价映射，不改变判定强度：映射结果仍然参与 attempt/phase 排序与最新态选取。
 */
const PHASE_ALIASES = new Map([
  ['test', 'test'], ['test_first', 'test'], ['test-first', 'test'], ['testfirst', 'test'],
  ['spec', 'spec'], ['spec-review', 'spec'], ['spec_review', 'spec'], ['specification', 'spec'],
  ['impl', 'impl'], ['implementing', 'impl'], ['implementation', 'impl'],
  ['execution', 'impl'], ['executing', 'impl'], ['coding', 'impl'], ['build', 'impl'],
  ['review', 'audit'], ['audit', 'audit'], ['auditing', 'audit'], ['reviewing', 'audit'],
  ['merge', 'merge'], ['merging', 'merge'],
]);

export function normalizePhase(raw) {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  if (key === '') return null;
  return PHASE_ALIASES.get(key) ?? null;
}

/**
 * 阶段序：用于在多个终态 agent 中选出「最新」的一条。
 * spec/test 同属最早阶段（Tester 先写 Red 测试或 spec 复核）。
 */
export const PHASE_ORDER = { spec: 0, test: 0, impl: 1, audit: 2, merge: 3 };

/** 处置枚举：只有这些取值能让终态 agent 视为「已了结」。 */
export const DISPOSITIONS = new Set(['handed-off', 'merged', 'rejected', 'abandoned', 'superseded']);

/**
 * 处置语义表——这是 disposition 的唯一消费规则，reconcile 不得在别处再推导一遍。
 *
 * 关键在于「agent 自报的处置」与「账本事实」是两回事：
 *   continue  handed-off / superseded —— 阶段交接或已被更新的 attempt 取代，任务可继续推进。
 *   verify    merged               —— agent 自称已合流。自报不构成验收，必须由 first-parent
 *                                     合流账本证明；账本没有就必须挂起，不能直接 READY。
 *   retry     rejected / abandoned —— 本轮产出未被接受，计入打回预算。
 */
export const DISPOSITION_EFFECT = {
  'handed-off': 'continue',
  superseded: 'continue',
  merged: 'verify',
  rejected: 'retry',
  abandoned: 'retry',
};

/** 该处置是否消耗打回预算。 */
export function consumesRetryBudget(disposition) {
  return DISPOSITION_EFFECT[disposition] === 'retry';
}

/** 常规打回预算：≤2 次打回仍按原角色重派。 */
export const MAX_REJECTIONS = 2;

/** 打回耗尽的升级目标角色：最后一次机会改派更深模型。 */
export const ESCALATION_ROLE = 'gaogong';

/** 升级后允许的重派次数（本次仍被打回即转 BLOCKED）。 */
export const MAX_ESCALATED_RETRIES = 1;

/**
 * 打回预算策略——这是「还能不能再派一次、派给谁」的唯一判定点。
 *
 * 口径（SKILL「重试与返工预算」）：每任务最多打回 2 轮 + 升级高工 1 次，超出即 Blocked。
 * 换成计数即：rejections 0–1 → 常规重派；2 → 升级重派；≥3 → 耗尽。
 *
 * 之所以要把「升级」做成机器可读的返回值而不是文档里的一句话：派发角色若只写在
 * 提示词里，执行器仍会按默认角色重派，第 3 次尝试用的还是同一个模型——「换更深模型
 * 再试一次」这个承诺就没有任何执行载体（2026-10-26 复核发现的历史缺陷）。
 */
export function retryPolicy(rejections) {
  if (rejections < MAX_REJECTIONS) {
    return { allowed: true, escalate: false, role: null, rejections };
  }
  if (rejections < MAX_REJECTIONS + MAX_ESCALATED_RETRIES) {
    return { allowed: true, escalate: true, role: ESCALATION_ROLE, rejections };
  }
  return {
    allowed: false,
    escalate: false,
    role: null,
    rejections,
    reason: `打回预算耗尽（${rejections} 次 rejected/abandoned，已含 ${MAX_ESCALATED_RETRIES} 次升级重派）；须人类裁决是否继续`,
  };
}
