// 证据字段契约的唯一定义点。
//
// 为什么单独成模块：字段清单过去只活在 check-evidence.mjs 的 structureErrors() 里，
// 而写证据的人读的是 SKILL.md 的散文描述。实测后果是 smoke 的 8 个必填字段里
// 只有 3 个在文档中出现过（parent_agent_id、child_agent_id、notification_message_id、
// relay_case 在 SKILL 中命中 0 次），而且没有任何模板——写的人只能靠猜，
// 猜错的代价是收尾时才发现收据不合格。
//
// 现在：脚本按这里的清单校验，templates/evidence-{smoke,audit}.md 按这里的清单列字段，
// test/docs.test.mjs 断言两者一致。三处指向同一份定义，改了一处不会静默漂移。

/** smoke 证据的必填字段（顺序即模板中的顺序）。 */
export const SMOKE_REQUIRED_FIELDS = [
  'parent_agent_id',
  'child_agent_id',
  'notification_message_id',
  'dispatched_at',
  'notification_at',
  'result',
  'relay_case',
  'unverified',
];

/** audit 证据的必填字段。 */
export const AUDIT_REQUIRED_FIELDS = [
  'verdict',
  'reviewed_sha',
];

/**
 * 时间线字段：acceptance 闸门要求单调不减。
 *
 * 独立列出而不是混进必填字段，因为它们的约束不是「存在」而是「相对顺序」：
 * dispatched_at ≤ notification_at，且都不得早于该 agent 的真实 createdAt。
 * （这两个名字已经被 SMOKE_REQUIRED_FIELDS 覆盖，这里只用于给判据读的人指路，
 * 所以不单独导出——导出过一版，模块外零引用，是死导出。）
 */
const SMOKE_TIMELINE_FIELDS = ['dispatched_at', 'notification_at'];

/**
 * 验收闸门额外要求的字段：缺了它照样能留档，但不能当收据。
 *
 * reviewed_sha 在 smoke 里不是必填——冒烟可以不带 revision 留档——但收尾验收时
 * 必须有，且必须等于被测的集成 HEAD。
 */
export const ACCEPTANCE_REQUIRED_FIELDS = ['reviewed_sha'];

/** 写「未采集」合法、但不得作为验收收据的字段。 */
export const NOT_COLLECTED_BLOCKING_FIELDS = [
  'parent_agent_id',
  'child_agent_id',
  'notification_message_id',
  'dispatched_at',
  'notification_at',
  'relay_case',
];

/**
 * 场景结论段：验收闸门按场景读 `<ID>: PASS`，不是自由文本。
 *
 * 单列为「段落」而不是必填字段：冒烟可以一个场景都不挂，但一旦挂了就必须有结论。
 * 列在这里是为了让模板与闸门的字段集合可以机械比对——模板写了闸门不读的段、
 * 或闸门读的段模板里没有，都属于三环漂移。
 */
export const SCENARIO_RESULTS_FIELD = 'scenario_results';

/**
 * 占位值判据只作用于「闸门拥有的字段」：契约字段 + 命令型字段。
 *
 * 为什么不扫全文件：`notes: the TEST harness was restored, for example …` 是一句人话，
 * 它既不是采集值也不是闸门读的字段，却会被 TEST/EXAMPLE 的子串判据命中而拒绝整份收据
 * （实测 rc=1）。判据的作用范围必须与「谁读这个字段」一致——闸门不读的字段，
 * 它的措辞不该决定收据存亡。
 *
 * 不导出：唯一读者是本模块的 `isContractField`。消费方要判断某个字段受不受约束，
 * 走的都是那个函数；直接拿集合会在两个地方各判一套。
 */
const CONTRACT_FIELDS = new Set([
  ...SMOKE_REQUIRED_FIELDS,
  ...AUDIT_REQUIRED_FIELDS,
  ...SMOKE_TIMELINE_FIELDS,
  'reviewed_sha',
  'reviewer_agent_id',
  'base_sha',
]);

/** 命令型字段的形态判据：值本身是一条 shell 命令，走整值判据。 */
export const COMMAND_FIELD_RE = /(?:^|_)(?:command|cmd)$/i;

/** 该字段是否受占位值判据约束。 */
export function isContractField(name) {
  return CONTRACT_FIELDS.has(name) || COMMAND_FIELD_RE.test(name);
}
