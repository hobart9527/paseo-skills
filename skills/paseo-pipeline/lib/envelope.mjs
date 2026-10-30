// 阶段信封的机器校验（零依赖）。
//
// 为什么需要：SKILL 规定信封 ≤20 行、固定七个字段（task/attempt/phase/result/
// reviewed_sha/blockers/next_action），但**没有任何代码读过它**。执行器只把子 Agent
// 的最后一段回复当人话读，于是：
//   - 写漏 `next_action` 的信封照样被当成「阶段完成」，Lead 只能自己猜是 merge 还是 rework；
//   - 信封里写了 `blockers` 但 `kind: phase-complete`，两个字段互相矛盾，没人发现；
//   - 「≤20 行」这条上限从未被测量过，超长的信封把上下文撑爆时也归因不到信封本身。
// 结果是「信封」退化成了散文标题，下游所有依赖它的判断（打回、合流、重派）都变成自由心证。
//
// 本模块只做**结构**判定：字段齐备、枚举合法、行数上限、内部不自相矛盾。
// 内容是否真实（reviewed_sha 是否真是本任务的 tip、结果是否真的通过）由
// check-evidence 与 merge-task 各自核验——结构合法不等于事实成立，这点与证据闸门同一条界线。

/** 信封必须有的字段（顺序即模板顺序）。 */
export const ENVELOPE_REQUIRED_FIELDS = [
  'kind', 'task', 'attempt', 'phase', 'result', 'reviewed_sha', 'blockers', 'next_action',
];

/** kind 的合法取值。 */
export const ENVELOPE_KINDS = new Set(['phase-complete', 'blocked', 'turn-idle']);

/** next_action 的合法取值。 */
export const ENVELOPE_NEXT_ACTIONS = new Set(['merge', 'rework', 'blocked', 'wait', 'none']);

/**
 * 行数上限：写手/测试 20 行，审计/仲裁 25 行。
 *
 * 上限不是审美：它是「一份信封能否在不压缩上下文的前提下被完整读进编排回合」的实测边界。
 * 按角色给不同上限，因为审计员要逐场景写结论；给同一个数字会逼审计员把场景结论压成
 * 一句「all-pass」，反而丢掉了唯一的逐场景证据。
 */
export const ENVELOPE_MAX_LINES = 20;
export const ENVELOPE_MAX_LINES_AUDIT = 25;

const FIELD_LINE = /^([a-z][a-z0-9_]*):\s*(.*)$/;

/**
 * 解析信封文本。
 *
 * 只认识顶层 `key: value` 行与缩进续行（blockers 是列表）。不做语义解释：
 * `blockers: none` 与 `blockers:` + 列表都合法，内容由消费方判。
 *
 * @returns {{fields: Map<string, string>, lines: number, problems: string[]}}
 */
export function parseEnvelope(text) {
  const raw = String(text ?? '').split(/\r?\n/);
  const fields = new Map();
  const problems = [];
  let current = null;
  // 统计有效行：忽略首尾空行与围栏（```）。围栏是 Markdown 代码块标记，不是信封内容，
  // 把它算进行数会让『贴模板』的合规信封因为多了两个 ``` 而越界。
  let lines = 0;
  for (const line of raw) {
    if (/^\s*(?:```|~~~)\s*$/.test(line)) continue;
    if (line.trim() === '') continue;
    lines += 1;
    const match = line.match(FIELD_LINE);
    if (match) {
      const [, name, value] = match;
      // 同名字段只允许出现一次：重复出现说明信封里混进了两段（例如粘贴了两轮回复），
      // 取第一段会静默丢掉后一段，取最后一段会丢掉前一段，两种都不可接受。
      if (fields.has(name)) problems.push(`字段 ${name} 重复出现；信封里只能有一段`);
      fields.set(name, value.trim());
      current = name;
      continue;
    }
    // 缩进续行只允许挂在 blockers 下；其它字段的续行说明信封结构坏了。
    if (/^\s+[-*]\s+/.test(line) && current === 'blockers') continue;
    if (/^\s+\S/.test(line) && current !== null) continue;
    problems.push(`无法解析的行（既不是 key: value，也不是缩进续行）：${line.slice(0, 60)}`);
  }
  return { fields, lines, problems };
}

/**
 * 校验信封。
 *
 * @param {string} text 信封原文
 * @param {{maxLines?: number}} options 审计类用 ENVELOPE_MAX_LINES_AUDIT
 * @returns {{problems: string[], fields: Map<string,string>, lines: number}}
 */
export function validateEnvelope(text, { maxLines = ENVELOPE_MAX_LINES } = {}) {
  const { fields, lines, problems } = parseEnvelope(text);
  if (fields.size === 0) {
    problems.push('信封为空或没有任何 key: value 行');
    return { problems, fields, lines };
  }
  for (const name of ENVELOPE_REQUIRED_FIELDS) {
    if (!fields.has(name)) problems.push(`缺少必填字段 ${name}`);
  }
  const kind = fields.get('kind');
  if (kind !== undefined && !ENVELOPE_KINDS.has(kind)) {
    problems.push(`kind=${JSON.stringify(kind)} 不是合法取值（${[...ENVELOPE_KINDS].join('/')}）`);
  }
  const next = fields.get('next_action');
  if (next !== undefined && !ENVELOPE_NEXT_ACTIONS.has(next)) {
    problems.push(`next_action=${JSON.stringify(next)} 不是合法取值（${[...ENVELOPE_NEXT_ACTIONS].join('/')}）`);
  }
  // 自相矛盾的两组组合。不做更多语义推断：信封只说「我这个阶段结束了」，
  // 「结果是否真的通过」需要看证据，不在这里判。
  if (kind === 'blocked' && next !== undefined && next === 'merge') {
    problems.push('kind=blocked 但 next_action=merge：阻断的信封不能要求合流');
  }
  if (kind === 'phase-complete' && next === 'blocked') {
    problems.push('kind=phase-complete 但 next_action=blocked：自相矛盾（要求阻断应写 kind=blocked）');
  }
  const attempt = fields.get('attempt');
  if (attempt !== undefined && !/^\d+$/.test(attempt)) {
    problems.push(`attempt=${JSON.stringify(attempt)} 必须是正整数`);
  }
  if (lines > maxLines) {
    problems.push(`信封 ${lines} 行，超过上限 ${maxLines} 行；压缩到字段本身，把细节放进证据文件`);
  }
  return { problems, fields, lines };
}
