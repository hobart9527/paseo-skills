import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const skillDir = path.resolve('skills/paseo-pipeline');
const skillPath = path.join(skillDir, 'SKILL.md');
const lessonsPath = path.join(skillDir, 'LESSONS.md');

const skillText = fs.readFileSync(skillPath, 'utf8');
const lessonsText = fs.readFileSync(lessonsPath, 'utf8');

/**
 * 这些测试断言的是**流程契约**：SKILL.md 必须把「哪件事发生在哪一步、由谁做、
 * 判据是什么」写清楚，而不是只要出现过某个关键词就算数。
 * 出现「禁止」二字不证明权限边界有效，出现「心跳」不证明恢复闭环存在。
 */

/**
 * 取某个标题下的正文。必须按标题层级截断：顶层 `##` 小节包含其下所有 `###` 子节，
 * 否则「执行主路径」只返回四段式引言，子节里的契约断言全部落空。
 */
function section(heading) {
  const lines = skillText.split('\n');
  // 围栏代码块里的 `# 注释` 不是标题；不跳过会把 bash 注释当成一级标题从而截断正文。
  const headings = [];
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (!inFence && /^#{1,3}\s/.test(line)) headings.push({ index, level: /^#+/.exec(line)[0].length, line });
  });
  const start = headings.findIndex((h) => h.line.includes(heading));
  assert.ok(start >= 0, `SKILL.md must contain a heading matching /${heading}/`);
  const self = headings[start];
  const end = headings.find((h) => h.index > self.index && h.level <= self.level);
  return lines.slice(self.index + 1, end ? end.index : lines.length).join('\n');
}

test('SCEN-DOC-03: 完成定义区分四种完成，且明确结构闸门不等于验收通过', () => {
  const text = section('完成定义');
  // 四种完成必须各自出现，且不得互相替代。
  assert.match(text, /阶段信封完成/);
  assert.match(text, /任务合流/);
  assert.match(text, /集成业务验收/);
  assert.match(text, /主干合入/);
  // 结构闸门对 FAIL 也放行 —— 这是「留档」与「验收」分家的关键事实，必须写出。
  assert.match(skillText, /结构闸门[\s\S]{0,120}FAIL[\s\S]{0,80}(?:exit\s*0|留档)/);
  // 收尾不得被表述成「跑单测 + 跑证据格式检查」即完成。
  assert.match(text, /单测通过只证明模块级行为|不是「跑一遍全量单测/);
});

test('SCEN-DOC-04: 验收闸门列出全部必需条件，并声明 FAIL/未验证不可折算 PASS', () => {
  const text = section('证据双闸门');
  assert.match(text, /--gate structure/);
  assert.match(text, /--gate acceptance/);
  assert.match(text, /result:\s*PASS/);
  assert.match(text, /unverified[^\n]*为空/);
  assert.match(text, /notification_at\s*>=\s*dispatched_at/);
  assert.match(text, /reviewed_sha/);
  assert.match(text, /--require-scenario/);
  assert.match(text, /FAIL、BLOCKED、SKIPPED、未验证[^\n]*不能折算 PASS/);
  // 「被提到」不等于「被验证」：脚本现在要求 scenario_results 段里的 PASS 结论。
  // 只写「必须出现」的文档会让执行者以为正文提一句就算过，与脚本行为分家。
  assert.match(text, /scenario_results[\s\S]{0,120}PASS/);
  assert.match(text, /正文提及|注释、TODO 都不算验证/);
  // 占位值不是采集值 —— 这条规则来自真实事故（`msg_01JAX_LOST_NOTIFICATION`）。
  assert.match(text, /占位值[^\n]*不是采集值/);
  assert.match(text, /与「字段缺失」同等对待|与字段缺失同等对待/);
});

test('SCEN-DOC-12: 合流超时按进程组终止，回执丢失的重试有确定处置', () => {
  const text = section('安全原子合流门禁');
  // 只杀外层 shell 会让孙进程继续写工作区；文档必须写出这一层。
  assert.match(text, /进程组[\s\S]{0,120}SIGTERM[\s\S]{0,60}SIGKILL/);
  // abort 现场保护：MERGE_HEAD 消失且 HEAD 被推进时不得静默。
  assert.match(text, /MERGE_HEAD[\s\S]{0,120}git commit[\s\S]{0,80}exit\s*40/);
  // 回执丢失的处置必须写在文档里，否则执行者会把「已合过」当成「账本被污染」去重派。
  assert.match(text, /回执丢失[\s\S]{0,120}重试/);
  assert.match(text, /禁止重派写手/);
});

test('SCEN-DOC-05: 运行账本闭环命令齐全，孤儿意图禁止自动重派', () => {
  const text = section('运行账本');
  for (const command of ['begin', 'claim', 'record', 'fail', 'status']) {
    assert.match(text, new RegExp(`run-state\\.mjs\\s+${command}`), `run-state CLI must document '${command}'`);
  }
  // 先记意图、再派发、再记回执 —— 顺序本身是契约。
  assert.match(text, /先记意图[^\n]*再派发[^\n]*再记回执/);
  // 单 owner 租约的代际语义。
  assert.match(text, /租约过期后旧 owner[^\n]*exit\s*2|旧 owner 的全部[^\n]*exit\s*2/);
  // 孤儿意图由人工/仲裁处置，自动化不得自行重派。
  assert.match(text, /ORPHAN_INTENT[\s\S]{0,200}不得自行重派|不得自行重派/);
  // heartbeat 注册入口已删（2026-10-26）：文档必须写明，而不是继续宣传生命周期命令。
  assert.match(text, /无 heartbeat 子命令/);
  assert.doesNotMatch(text, /run-state\.mjs\s+heartbeat/);
});

test('SCEN-DOC-06: 合流门禁逐因子写清，并绑定真实退出码与脚本', () => {
  const text = section('安全原子合流门禁');
  assert.match(text, /merge-task\.mjs/);
  assert.match(text, /依赖门禁[\s\S]{0,120}exit\s*35/);
  assert.match(text, /写范围封闭[\s\S]{0,120}exit\s*30/);
  assert.match(text, /作者血统[^\n]*exit\s*31/);
  assert.match(text, /非自审[\s\S]{0,200}exit\s*32/);
  assert.match(text, /祖先[\s\S]{0,80}exit\s*34/);
  // 固定 tip 与测试改树拒绝提交，是合流原子性的两个关键事实。
  assert.match(text, /固定 tip/);
  assert.match(text, /测试改写了工作树[\s\S]{0,200}git status --porcelain=v1 --untracked-files=all/);
  assert.match(text, /MERGE_TEST_TIMEOUT_MS/);
});

test('SCEN-DOC-07: 审查熔断限制轮次但不降低通过条件，R2 仍报新的严重问题', () => {
  const text = section('执行主路径');
  assert.match(text, /R2 优先复核[\s\S]{0,80}修复影响面/);
  // 新暴露的严重问题照常阻断 —— 不能因为发生在原 diff 之外而放过。
  assert.match(text, /新的[\s\S]{0,40}正确性、安全、规范问题[\s\S]{0,40}阻断/);
  // 熔断是暂停裁决，不是降低门槛。
  assert.match(text, /熔断是「暂停并裁决」，不是降低通过条件/);
  // 仲裁不按行数放行、不越权改规范。
  assert.match(text, /不按行数放行/);
  assert.match(text, /ESCALATE_HUMAN[\s\S]{0,200}人类决策/);
  // 四类 Blocker 准入。
  for (const blocker of ['SPEC_VIOLATION', 'CORRECTNESS_BUG', 'SECURITY_DEFECT', 'SCOPE_VIOLATION']) {
    assert.match(text, new RegExp(blocker));
  }
});

test('SCEN-DOC-08: DAG 就绪、资源串行化与 fail-closed 清空派发写清', () => {
  const text = section('执行主路径');
  // 需要依赖合流的下游必须等 Done，禁止提前放行。
  assert.match(text, /需要依赖合流的下游必须等 Done/);
  // cap 是上限不是目标。
  assert.match(text, /cap 是容量上限，不是要达到的目标/);
  // fail-closed 的四种清空条件。
  assert.match(text, /runtime[^\n]*非[^\n]*ok[\s\S]{0,200}UNMAPPED[\s\S]{0,200}未回执派发意图[\s\S]{0,200}cap/);
  // 共享资源不限于文件。
  assert.match(text, /共享资源不只文件/);
});

test('SCEN-DOC-09: 主会话 OpenSpec 独占与交回点写清', () => {
  assert.match(skillText, /OpenSpec CLI 主会话独占/);
  assert.match(skillText, /主会话独占执行/);
  // 子 Agent 只读产物，不调 CLI。
  assert.match(skillText, /子 Agent[\s\S]{0,120}禁止执行\s*`?openspec`?\s*命令|只读读取[^\n]*openspec\/changes/);
  // Lead 遇生命周期命令须发唯一待办并等回执。
  const text = section('验收与交回');
  assert.match(text, /唯一待办请求[\s\S]{0,200}回执/);
});

test('SCEN-EVT-01: 无法自唤醒与惰性对账的限制被如实记录，且未承诺默认看门狗', () => {
  assert.match(skillText, /无法自唤醒|无法唤醒|no-spontaneous-wakeup/i);
  assert.match(skillText, /惰性对账|lazy reconcile/i);
  assert.doesNotMatch(skillText, /默认(?:运行|启用|创建)?(?:10\s*分钟|十分钟)?(?:看门狗|watchdog|heartbeat)/i);
});

test('SCEN-EVT-02: 已撤回的错误承诺不得复活（100ms、0 次压缩、强制 rebase、reset --hard 兜底、隐式 mechanical）', () => {
  for (const [name, text] of [['SKILL.md', skillText], ['LESSONS.md', lessonsText]]) {
    assert.doesNotMatch(text, /<100ms|100ms/, `${name}: 不得承诺 100ms 响应`);
    assert.doesNotMatch(text, /0\s*次.*压缩|压缩.*0\s*次/, `${name}: 不得把 0 次压缩当作通过判据`);
    assert.doesNotMatch(text, /(?<!(?:不|无|禁止|非)(?:要求)?)(?:必须|强制)\s*rebase/i, `${name}: 不得强制 rebase`);
    // `reset --hard` 只允许出现在显式禁令里（前文有 严禁/禁止/不得/不可）。
    for (const line of text.split('\n')) {
      if (!/reset\s+--hard/.test(line)) continue;
      assert.match(line, /(?:严禁|禁止|不得|不可)[^。\n]*reset\s+--hard/,
        `${name}: reset --hard 只允许作为禁令出现，不得作为兜底手段`);
    }
    assert.doesNotMatch(text, /默认\s*mechanical|隐式\s*mechanical/i, `${name}: 不得有隐式 mechanical 放行`);
  }
});

test('SCEN-DOC-02: 权限代批与自产自审被明令禁止', () => {
  assert.match(skillText, /严禁调用\s*`?respond_to_permission`?|严禁.*respond_to_permission/);
  assert.match(skillText, /人类/);
  const text = section('硬底线');
  assert.match(text, /严禁[^\n]*自产自审/);
  assert.match(text, /严禁[^\n]*`?Write`?\/`?Edit`?|严禁[^\n]*Write.*Edit/);
  // 必须承认这只是协作契约，不是物理隔离。
  assert.match(text, /不是工具级身份隔离或可信来源证明/);
});

test('SCEN-DOC-10: SKILL.md 引用的本地脚本都真实存在（防漂移）', () => {
  const referenced = new Set(
    [...skillText.matchAll(/skills\/paseo-pipeline\/([\w./-]+\.(?:mjs|sh))/g)].map((m) => m[1]),
  );
  assert.ok(referenced.size > 0, 'SKILL.md must reference the pipeline scripts by path');
  for (const relative of referenced) {
    assert.ok(fs.existsSync(path.join(skillDir, relative)),
      `SKILL.md 引用了不存在的脚本：skills/paseo-pipeline/${relative}`);
  }
});

test('SCEN-DOC-11: 派发指令取自活态 profile，不硬编码模型名', () => {
  assert.match(skillText, /list_profiles/);
  assert.match(skillText, /featureValues\s*(?:→|->)\s*settings\.features/);
  assert.match(skillText, /notifyOnFinish/);
  // 五个身份标签是 reconcile 归属的唯一依据。
  for (const label of ['pipeline.change', 'pipeline.task', 'pipeline.attempt', 'pipeline.phase', 'pipeline.role']) {
    assert.ok(skillText.includes(label), `派发标签 ${label} 必须写明`);
  }
  const dispatch = section('角色与派发');
  assert.doesNotMatch(dispatch, /claude-\d|claude-opus|gpt-\d|glm-\d|qwen-?\d/i,
    '角色与派发一节不得硬编码模型名');
});

// --- 派发 brief 模板 ---
//
// 模板存在的理由是可证伪的：2026-10-26 的 5 任务冒烟里，Lead 因为 brief 没写
// `pipeline.disposition` 的生产者契约，只能从 `lib/roles.mjs` 反推，T-1 被
// `UNRESOLVED` 锁死一轮。模板漏掉一个字段 = 每个 change 重犯一次同样的摩擦，
// 所以这里有断言，而不只是「文档里提了一句 templates/」。
const templateDir = path.join(skillDir, 'templates');
const TEMPLATES = ['writer', 'tester', 'auditor', 'arbiter', 'lead'];

function template(name) {
  const file = path.join(templateDir, `${name}.md`);
  assert.ok(fs.existsSync(file), `缺少 brief 模板：templates/${name}.md`);
  return fs.readFileSync(file, 'utf8');
}

test('SCEN-DOC-13: 五份 brief 模板齐备且被 SKILL 引用', () => {
  for (const name of TEMPLATES) template(name);
  // SKILL 必须指向模板目录，否则模板存在也不会被用上。
  assert.match(skillText, /`?templates\/`?/, 'SKILL.md 必须指向 templates/');
  for (const name of TEMPLATES) {
    assert.ok(skillText.includes(name) || /templates\/\)/.test(skillText),
      `SKILL.md 应让调用方能定位到 ${name} 模板`);
  }
});

test('SCEN-DOC-14: 每份模板都锁定必填字段，缺一个就红', () => {
  // 固定字段集来自 SKILL §1：目标与不变式、base SHA、Write scope、Verify 命令、
  // 必填 trailers、信封格式。少任何一项，下游就无法机械消费上游产出。
  const REQUIRED = {
    writer: [/目标/, /base SHA/, /Write scope/, /Verify/, /Pipeline-Author/, /信封/, /next_action/],
    tester: [/base SHA/, /Write scope/, /Verify/, /Pipeline-Author/, /信封/, /conflicting_tests/],
    auditor: [/base SHA/, /tip SHA/, /verdict/, /reviewed_sha/, /closing_criteria/, /信封/],
    arbiter: [/base SHA/, /tip SHA/, /decision/, /reviewed_sha/, /ESCALATE_HUMAN/, /信封/, /next_action/],
    lead: [/paseo wait/, /status/, /reconcile\.mjs/, /merge-task\.mjs/, /信封/, /wall_clock/],
  };
  for (const [name, patterns] of Object.entries(REQUIRED)) {
    const text = template(name);
    for (const pattern of patterns) {
      assert.match(text, pattern, `${name}.md 必须包含 ${pattern}`);
    }
  }
});

test('SCEN-DOC-18: Lead 模板强制并行 DAG 用并发 wait，而非串行轮流', () => {
  // 2026-10-26 并行冒烟实测：串行 wait 造成 110 秒 cap 空闲（T-2 已完成但不释放名额）。
  // 并发 wait 独立性已验证（idle 探针 +0.41s 返回，busy 探针 +19.8s 返回）。
  const lead = template('lead');
  assert.match(lead, /并发\s*wait|并发起多个/, 'lead.md 必须要求并发 wait');
  assert.match(lead, /一次只(?:接受|等)一个\s*id/, 'lead.md 必须说明 paseo wait 只接受单个 id');
  assert.match(lead, /串行轮流|串行\s*wait/, 'lead.md 必须点名串行等待是错的');
  assert.match(lead, /空转|名额/, 'lead.md 必须说明串行的代价（浪费 cap 名额）');
});

test('SCEN-DOC-17: writer 模板警告 trailer 必须是最后一段（否则 merge exit 31）', () => {
  // 2026-10-26 并行冒烟实测：5 个写手里 2 个把 Co-Authored-By 用空行另起一段，
  // 前面 Pipeline-* trailer 全部失效，merge-task 以 exit 31 拒绝。
  // git 的 %(trailers) 只解析最后一个段落，这条必须在写手侧就拦住。
  const writer = template('writer');
  assert.match(writer, /最后一段/, 'writer.md 必须说明 trailer 必须在最后一段');
  assert.match(writer, /%(?:\(trailers\))?trailers|trailr?ers/,
    'writer.md 必须点名 git 的 trailers 解析机制');
  assert.match(writer, /exit\s*31/, 'writer.md 必须给出失败症状 exit 31');
  assert.match(writer, /Co-Authored-By/, 'writer.md 必须点名 Co-Authored-By 这个最常见的触发源');
  assert.match(writer, /错误/, 'writer.md 必须给出反例');
});

test('SCEN-DOC-15: Lead 模板写明 disposition 生产者契约与 wait 退出码陷阱', () => {
  const lead = template('lead');
  // 这两条是冒烟里真实付出代价的两点，不能只写在 SKILL 里。
  assert.match(lead, /pipeline\.disposition|disposition/,
    'lead.md 必须写明阶段完成后由 Lead 打 disposition');
  assert.match(lead, /handed-off/, 'lead.md 必须给出 disposition 的合法取值');
  assert.match(lead, /退出码恒为\s*0|恒为\s*0/,
    'lead.md 必须警告 paseo wait 退出码恒为 0');
  assert.match(lead, /timeout/, 'lead.md 必须写明 status=timeout 时不重派');
});

test('SCEN-DOC-16: Auditor 模板禁止自拼 review-tag，且只接受 4 类 Blocker', () => {
  const auditor = template('auditor');
  assert.match(auditor, /不要自己拼\s*review-tag|review-tag 由\s*Lead/);
  for (const cls of ['SPEC_VIOLATION', 'CORRECTNESS_BUG', 'SECURITY_DEFECT', 'SCOPE_VIOLATION']) {
    assert.ok(auditor.includes(cls), `auditor.md 必须列入 Blocker 类别 ${cls}`);
  }
  // R2 不得引入新的风格挑剔——否则「2 轮熔断」变成无限延长。
  assert.match(auditor, /禁止在\s*R2\s*提新的风格挑剔/);
});

test('SCEN-DOC-19: 冻结阶段的 spec 撰写规则五条齐备，且由 Auditor 核不靠脚本', () => {
  // 这五条来自 2026-10-26 hardening-governance-contracts 的冻结后返工，每条对应一次
  // 真实的执行期损失。它们是语义判据，故意不写成门禁脚本（见 LESSONS §12 判据 1）。
  const text = section('冻结前准备');
  const RULES = [
    [/环境独立[\s\S]{0,200}gitignore/, 'Verify with 必须在干净工作树可执行'],
    [/scope 闭环[\s\S]{0,300}SCEN-/, 'Write scope 必须覆盖 Verify 读到的文件与场景实现文件'],
    [/一场景一承载/, '每条 SCEN 必须有测试文件或写明的静态检查'],
    [/delta 先对基线/, '新增场景前先对基线同一输入看既有结论'],
    [/矩阵计数由命令生成/, '矩阵与测试计数贴命令输出，不凭印象'],
  ];
  for (const [pattern, why] of RULES) {
    assert.match(text, pattern, `缺少 spec 撰写规则：${why}`);
  }
  assert.match(text, /不写成门禁脚本/, '必须写明这类语义判据不由脚本强制');
});

test('SCEN-DOC-20: Lead 模板列出分叉核对命令，并要求 brief 事实由命令输出生成', () => {
  const text = template('lead');
  // 2026-10-26 实测：分叉（集成领先 32 / main 领先 15，4 处冲突预测）到人工确认点 2
  // 才被发现。分叉不是错误，"到最后一刻才知道"是编排缺陷。
  assert.match(text, /git merge-base --is-ancestor/);
  assert.match(text, /git merge-tree/);
  assert.match(text, /冻结时[\s\S]{0,80}确认点 2/, '分叉核对必须出现在冻结与合流两处');
  // 编排者口述数字不是真源：18 行 vs 实有 19 行导致错误 brief 白烧一轮。
  assert.match(text, /brief 里的事实必须由命令输出生成/);
});

test('SCEN-DOC-24: 返工、双轴审计与仲裁在模板之间首尾相接，且不依赖不存在的执行载体', () => {
  // 2026-10-28 排查：方法论条款曾只停在提示词层——返工要求写红灯测试，但信封没有字段承载证据、
  // 审计员也不核；「符号级 Write scope」既没有解析字段也没有门禁；Lead 模板完全没写审计结论
  // 怎样映射成 disposition，审计打回后对账仍报 MERGE。每一环缺失都会在执行期断成一次空转。
  const writer = template('writer');
  const auditor = template('auditor');
  const arbiter = template('arbiter');
  const lead = template('lead');

  // 生产者与消费者：写手产出 red_evidence，审计员在 R2 以它判闭环。
  assert.match(writer, /^red_evidence:/m, 'writer 信封必须有 red_evidence 字段');
  assert.match(auditor, /`red_evidence`[\s\S]{0,200}缺红灯证据[^\n]{0,40}未闭环/,
    'auditor 必须把缺红灯证据判为未闭环');
  // 复现测试不在 scope 时不得越界提交（否则 exit 30），必须有明确出口。
  assert.match(writer, /REPRO_OUT_OF_SCOPE/);
  // strict 档分工：写手不改 Tester 的断言。
  assert.match(writer, /不改 Tester 提交的断言/);

  // 双轴分开落在信封，Standards 轴不扩大 4 类准入。
  assert.match(auditor, /^spec_axis:/m);
  assert.match(auditor, /^standards_axis:/m);
  assert.match(auditor, /Standards 轴[\s\S]{0,200}NIT/);

  // 仲裁员不写代码；PATCH 由 Lead 派写手执行。
  assert.match(arbiter, /你不写代码/);
  assert.match(arbiter, /不扩大 4 类准入/);

  // Lead 拿得到完整的阶段链与 disposition 映射。
  assert.match(lead, /单任务阶段推进/);
  for (const verdict of ['R1 `BLOCK`', 'R2 `BLOCK`', 'OVERRULE', 'PATCH', 'ESCALATE_HUMAN']) {
    assert.ok(lead.includes(verdict), `lead.md 的映射表必须覆盖 ${verdict}`);
  }
  assert.match(lead, /--phase arbitrate --role hanlin/);
  assert.match(lead, /baseBranch:\s*"task\/<change>\/<task>"/, '返工必须从上一 attempt 的分支续改');
  assert.match(lead, /STALE_BRANCH/);
  assert.match(lead, /`MERGE` 只说明分支上有东西，不说明它审过了/);

  // 执行期不改冻结的 DAG，也不承诺不存在的符号级 scope 门禁。
  assert.match(lead, /Lead 不改 `tasks\.md` 的依赖边与 scope/);
  assert.match(lead, /只少派/);
  assert.doesNotMatch(lead, /必须在 DAG 中补全显式依赖边/);
  const freeze = section('冻结前准备');
  assert.match(freeze, /UNKNOWN_FIELD/, 'SKILL 必须写明不得发明符号级 scope 字段');
  assert.match(freeze, /Depends on/);
});

// --- 契约三环：模板 / 闸门 / 文档必须指向同一份定义（2026-10-27 包 5） ---
//
// 三环中缺任何一环，缺陷都要顺流到下游才暴露：只有模板没有闸门 → 写错也没人拦；
// 只有闸门没有模板 → 写的人靠猜；两者都有但没有测试 → 静默漂移。

test('SCEN-CON-06 SCEN-DOC-21: 证据模板的字段集等于 evidence-contract 导出的必填集', async () => {
  const contract = await import('../lib/evidence-contract.mjs');
  const fieldNames = (markdown) => new Set(
    [...markdown.matchAll(/^([a-z][a-z0-9_]*):/gm)].map((match) => match[1]),
  );
  for (const [name, required] of [
    ['evidence-smoke', contract.SMOKE_REQUIRED_FIELDS],
    ['evidence-audit', contract.AUDIT_REQUIRED_FIELDS],
  ]) {
    const declared = fieldNames(template(name));
    for (const field of required) {
      assert.ok(declared.has(field), `templates/${name}.md 缺契约字段 ${field}`);
    }
  }
  // 反向：模板里出现的每个顶层字段都必须在契约里，否则模板在教人写闸门不读的字段。
  const smokeDeclared = fieldNames(template('evidence-smoke'));
  const known = new Set([...contract.SMOKE_REQUIRED_FIELDS, ...contract.ACCEPTANCE_REQUIRED_FIELDS,
    contract.SCENARIO_RESULTS_FIELD]);
  for (const field of smokeDeclared) {
    assert.ok(known.has(field), `templates/evidence-smoke.md 含契约外的字段 ${field}`);
  }
});

test('SCEN-CON-06 SCEN-DOC-22: 证据模板含有闸门读取的各段落锚点', () => {
  // 模板里的占位尖括号会让闸门的占位值判据正确地报错，所以这里不假装「跑一遍闸门」；
  // 真实的通过路径由 check-evidence.test.mjs 的 PASSING_SMOKE 夹具证明。这一条只查
  // 「闸门读的那几个段落锚点在模板里存在」——缺一个，照模板写的人就写不出可验收的证据。
  const smoke = template('evidence-smoke');
  const audit = template('evidence-audit');
  assert.match(smoke, /^parent_agent_id:/m);
  assert.match(smoke, /^unverified:\s*$/m);
  assert.match(smoke, /^scenario_results:/m);
  assert.match(audit, /^verdict:/m);
  assert.match(audit, /^reviewed_sha:/m);
});

test('SCEN-CON-12 SCEN-DOC-23: SKILL 的 run-state 命令示例照抄即可执行（不带 --owner 在租约下必被拒）', () => {
  // 文档示例与实际行为脱节是实测过的教训：SKILL 曾把 claim 示例写成不带 --owner，
  // 而 begin 之后所有动作都要求 --owner，照抄必然 exit 2——读文档的人会以为命令写错了。
  const text = section('运行账本');
  const block = text.slice(text.indexOf('```bash') + 7, text.indexOf('```', text.indexOf('```bash') + 7));
  const lines = block.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('node '));
  assert.ok(lines.length >= 5, '运行账本节必须列出 begin/claim/record/fail/status 五条命令');
  for (const line of lines) {
    if (!/run-state\.mjs\s+(claim|record|fail)\b/.test(line)) continue;
    assert.match(line, /--owner/, `租约下的动作必须带 --owner：${line}`);
  }
  // 示例里出现的每一个 run-state 子命令都必须是脚本真正支持的命令。
  const script = fs.readFileSync(path.join(skillDir, 'run-state.mjs'), 'utf8');
  for (const match of text.matchAll(/run-state\.mjs\s+(\w+)/g)) {
    assert.match(script, new RegExp(`case '${match[1]}'`), `SKILL 写了不存在的子命令：${match[1]}`);
  }
  assert.match(text, /有租约时 `--owner` 必填/, '省略 --owner 的后果必须写明');
});

// --- 2026-10-27：schema 双副本一致性（实测缺少守护） ---
//
// `openspec-schema/` 是 OpenSpec `spec-driven` 的整份副本，安装到
// `openspec/schemas/paseo-pipeline/`。两份内容必须一字不差：安装是 `cp -R`，
// 但只要有人改了源头忘了重装（或反之），使用者拿到的就是不同版本的模板，
// 而 OpenSpec 只认安装后的那份。仓库里此前没有任何测试守护这对副本。
test('SCEN-CON-18: the packaged schema and its installed copy are byte-identical', () => {
  const packaged = path.join(skillDir, 'openspec-schema');
  const installed = path.resolve(skillDir, '..', '..', 'openspec', 'schemas', 'paseo-pipeline');
  assert.ok(fs.existsSync(installed), `缺少安装副本：${installed}（见 SKILL §2 安装步骤）`);

  const files = (root) => {
    const out = [];
    const walk = (dir, prefix) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else out.push(rel);
      }
    };
    walk(root, '');
    return out;
  };
  const packagedFiles = files(packaged);
  assert.deepEqual(files(installed), packagedFiles, '两份副本的文件列表必须相同');
  for (const rel of packagedFiles) {
    assert.equal(
      fs.readFileSync(path.join(installed, rel), 'utf8'),
      fs.readFileSync(path.join(packaged, rel), 'utf8'),
      `schema 副本漂移：${rel}（改完 openspec-schema/ 必须重跑 SKILL §2 的 cp -R）`,
    );
  }
});

// --- 2026-10-31 八项加固的文档对齐（每项都必须写进 SKILL，否则等于没落地） ---
//
// 这些门禁的共同点是「代码里有、文档里没有」就没人会用：acceptance-run 存在但 SKILL
// 只写 check-evidence，收尾仍然只跑自报矩阵；异构审查 exit 38 不写进退出码表，执行器
// 拿到 38 只能猜。断言的是**可执行示例与退出码表**，不是关键词出现。
test('SCEN-DOC-25: 合流退出码表包含异构审查 38，且写明豁免与未采集两种情形', () => {
  const text = section('安全原子合流门禁');
  assert.match(text, /38[^\n]{0,40}同 provider|同 provider[^\n]{0,40}38/,
    '退出码表必须列出 38');
  assert.match(text, /PIPELINE_ALLOW_HOMOGENEOUS_REVIEW=1/, '显式豁免必须写明');
  assert.match(text, /heterogeneity=BYPASSED\(homogeneous/, '豁免必须留痕');
  assert.match(text, /heterogeneity=unresolved/, 'provider 未采集时不阻断但必须留痕');
  assert.match(text, /heterogeneity=NOT-CHECKED\(no-run-state\)/, '无账本必须可与「通过」区分');
});

test('SCEN-DOC-26: 验收矩阵的 Verify 列由 acceptance-run 执行，且示例可照抄', () => {
  const text = skillText;
  assert.match(text, /acceptance-run\.mjs <change>|acceptance-run\.mjs <name>/,
    'SKILL 必须给出可照抄的执行器命令');
  assert.match(text, /自然语言\s*`?Verify`?\s*是硬失败|自然语言 Verify 是硬失败/,
    'prose Verify 的处置必须写明');
  assert.match(text, /--only[^\n]{0,80}不能当全量验收|窄跑不得冒充全通过|exit 3/,
    '局部重跑不得冒充全通过');
  // 收尾那一节也必须指向执行器，否则读者只会在第 6 节看到它，收尾时想不起来。
  assert.match(text, /acceptance-run\.mjs/, 'execute 器必须在收尾步骤里出现');
});

test('SCEN-DOC-27: 运行账本的 review/merge/record --envelope 都有可照抄示例', () => {
  const text = section('运行账本');
  for (const sub of ['review', 'merge']) {
    assert.match(text, new RegExp(`run-state\\.mjs ${sub}\\b`), `缺少 ${sub} 子命令示例`);
  }
  assert.match(text, /record[^\n]*--envelope/, 'record --envelope 必须在示例里');
  assert.match(text, /首次通过率/, '首次通过率的口径必须写明');
  assert.match(text, /READY 等待/, 'READY 等待的口径必须写明');
  assert.match(text, /change 名必须是位置参数形态|位置参数/, 'change 名形态校验必须写明');
});

test('SCEN-DOC-28: 写范围守卫与脏树检测都被写进 SKILL，且不宣称物理隔离', () => {
  const text = skillText;
  assert.match(text, /guard-scope\.mjs/, 'SKILL 必须指向守卫脚本');
  assert.match(text, /scope-guard-hook\.mjs/, 'PreToolUse hook 的安装入口必须写明');
  assert.match(text, /减速带/, '必须说明它是减速带而非沙箱');
  assert.match(text, /Bash[^\n]{0,60}(?:sed -i|重定向)[^\n]{0,40}拦不住|拦不住[^\n]{0,40}sed -i/,
    '已知覆盖缺口必须如实写明');
  assert.match(text, /PIPELINE_GUARD_SCOPE=off/, '关闭方式必须写明');
  const recover = section('失败处置与恢复');
  assert.match(recover, /UNEXPLAINED/, '脏树分级必须写进恢复流程');
});
