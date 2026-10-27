#!/usr/bin/env node
// 对账：测试断言的错误契约 vs spec 声明的错误字面量。差集非空则退出码 1。
// 用法：node contract-check.mjs <spec 文件或目录> <测试文件或目录>
//
// 两个方向分别 fail-closed：
//   undeclared = 测试断言了 spec 未声明的消息  → 漂移，必须清零
//   untested   = spec 声明了但测试未覆盖      → 空契约，必须清零
// 判定前先剥注释：注释里出现的字面量既不算断言，也不算覆盖。
import fs from "node:fs";
import path from "node:path";
import { parseTasks, identityErrors } from "./lib/tasks.mjs";

const CODE_EXT = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
// 测试套件不只是 Node 单测：本仓库的 `contract-check.test.sh` 是 bash 用例表，
// 它同样用 `SCEN-*` 编号标注每一条在验什么。只扫 JS 扩展名时这些场景永远不可见——
// 本 change 实测：三条场景由 shell 用例承载，收尾对账把它们判成「无测试引用」，
// 于是门禁逼着作者去 JS 测试里重复标注，或者把编号改成不存在的。
// shell 用例只进**场景通道**：场景编号写在注释里，`--max-phantom` 与 untested 都读得到；
// 消息通道（错误字面量）仍是 JS 专属，shell 里没有 assert.throws。
const SHELL_EXT = new Set([".sh", ".bash"]);
// `Write scope` 里实现文件与测试文件混写，退回 scope 找测试时必须只认测试文件名形状，
// 否则实现文件会被当成测试语料收进来（本 change 实测：contract-check.mjs 与
// contract-check.test.sh 同在 scope 里，按扩展名过滤会把前者也当成测试）。
const VERIFY_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.test\.sh$/i;
const DOC_EXT = new Set([".md", ".markdown"]);

const walk = (p) =>
  fs.statSync(p).isDirectory()
    ? fs.readdirSync(p).sort().flatMap((f) => walk(path.join(p, f)))
    : [p];

const collect = (p, exts) =>
  walk(p)
    .filter((f) => exts.has(path.extname(f).toLowerCase()))
    .map((f) => fs.readFileSync(f, "utf8"))
    .join("\n");

// 剥注释。先剥块注释再剥行注释；行注释只认行首/空白/分号后的 //，避免误伤 URL 与正则。
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[\s;,{}()=])[ \t]*\/\/[^\n]*/gm, "$1");

const STR = String.raw`(["'\`])((?:\\[\s\S]|(?!\1)[^\\])*)\1`;

const addStrings = (set, src, pattern) => {
  for (const m of src.matchAll(pattern)) set.add(m[2]);
};

// 抓住 .throws(...) / .rejects(...) 的**断言规格窗口**：只取第一个顶层逗号之后的实参。
// 第一个实参是被测回调，里面的字符串字面量是**输入值**，不是断言消息。实测反例：
//   assert.throws(() => toBase("10", 1), { message: RADIX_MESSAGE })
//   → 扫整个窗口会把 "10" 当断言消息，报 undeclared=1。
// 断言第二实参是**谓词**时，它断言的是判断结果，不是一条完整错误消息：
//   assert.rejects(fn, (err) => err.code === 'ATTACHMENT_SIZE_INVALID')
//   assert.rejects(fn, hasErrorCode('MASTER_DATA_FETCH_FAILED'))
// 这类窗口里的字符串是错误码、字段名或断言失败说明串，混进消息通道就是 undeclared 误报
// （2026-10-26 实测：11 条误报里 6 条来自谓词回调）。
// 判据只看形态，不看语义：函数字面量（`(…) =>` / `async (…) =>`）与函数调用（`helper(…)`）。
// 对象形态 `{ message: "…" }`、字符串、正则、构造器调用都不是谓词。
const isPredicateSpec = (body) => {
  const text = body.trim();
  if (text === "") return false;
  if (/^(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(text)) return true;
  // 函数调用：标识符（可带点号）紧跟左括号，且同名的不是错误构造器。
  const call = /^([A-Za-z_$][\w$.]*)\s*\(/.exec(text);
  return call !== null && !/Error$/.test(call[1]);
};

const assertWindows = (src) => {
  const windows = [];
  for (const m of src.matchAll(/\.(?:throws|rejects)\s*\(/g)) {
    const start = m.index + m[0].length - 1;
    let i = start;
    let depth = 0;
    let split = -1;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) break;
      } else if (src[i] === "," && depth === 1 && split < 0) split = i;
    }
    // 无第二个实参（如 assert.throws(fn)）即无消息断言
    windows.push(split < 0 ? "" : src.slice(split + 1, i));
  }
  return windows;
};

/** 只保留断言了完整消息的窗口；谓词窗口归 code 通道语义，不进消息对账。 */
const messageWindows = (windows) => windows.filter((body) => !isPredicateSpec(body));

// 提取 tasks.md 中声明的测试路径（优先从 Verify with 提取，兜底 Write scope）。
// 任务解析属主是 lib/tasks.mjs：这里不再自带一套行匹配，否则 check-evidence / merge-task /
// reconcile / contract-check 会各自演进，同一份 tasks.md 在不同入口解析出不同结果（L1-09）。
const extractTestsFromTasks = (tasksContent, targetTask) => {
  const { tasks, errors } = parseTasks(tasksContent);
  // 本用途只取「测试路径」，所以只有会改变任务集合或字段归属的错误才是致命的。
  // 账本完整性类错误（BAD_DONE_LINE / MISSING_SCOPE / UNKNOWN_REVIEW / 风险与 Review 冲突、
  // 依赖缺失或成环）由 reconcile 与 merge-task 负责，不在这里重复判，否则同一份 tasks.md
  // 会在文档抽取阶段被合流门禁的规则误拒。
  // 判定由 lib/tasks.mjs 的 IDENTITY_CODES 拥有：这里不再自带集合，否则同一组码的
  // 严重度会在四个入口各自漂移（reconcile / contract-check / merge-task / hotfix）。
  const fatal = identityErrors(errors);
  if (fatal.length > 0) {
    console.error(`tasks 解析失败: ${fatal.map((error) => `${error.code}: ${error.message}`).join("; ")}`);
    process.exit(1);
  }
  const selected = targetTask
    ? tasks.filter((task) => task.id.toLowerCase() === targetTask.toLowerCase())
    : tasks;
  if (targetTask && selected.length === 0) {
    console.error(`tasks.md 中没有任务 ${targetTask}`);
    process.exit(2);
  }
  const tests = [];
  for (const task of selected) {
    // Verify with 里被识别为测试文件的 token 优先；没有就退回 Write scope 里声明的测试文件。
    const fromVerify = task.verify?.tests ?? [];
    // Write scope 里**实现文件与测试文件混在一起**，只有测试才是对账对象。
    // VERIFY_FILE 同时认 `*.test.mjs` 与 `*.test.sh`：本仓库的 shell 用例表同样标注 SCEN-*，
    // 只认真 JS 扩展名会让它们连 fallback 都进不来（本 change 实测：T-02 的测试文件是
    // contract-check.test.sh，退回 scope 后连实现文件 contract-check.mjs 一起被当测试）。
    //
    // scope 里一个测试形状的文件都没有时退回**整个 scope**，保持旧行为：此时没有
    // 「哪些是测试」的信息可用，而调用方要的是「声明的测试路径一条都没产出」这个判定，
    // 空列表会让它变成 usage error（本仓 R31/R32 两条用例正是这个形态）。
    const testShapedScope = task.scope.filter((entry) => VERIFY_FILE.test(entry));
    const fromScope = testShapedScope.length > 0 ? testShapedScope : task.scope;
    for (const candidate of (fromVerify.length > 0 ? fromVerify : fromScope)) {
      if (!tests.includes(candidate)) tests.push(candidate);
    }
  }
  return tests;
};

const argv = process.argv.slice(2);
const PARTIAL = argv.includes("--partial");
// `--final` 是收尾模式：此刻本 change 的所有测试都该已产出，「一条都没有」不再是
// 「阶段 1 的正常状态」，而是缺件。默认模式保留 SKIPPED 是为了规划期能跑同一命令。
const FINAL = argv.includes("--final");
let tasksFile = null;
let targetTask = null;
// `--baseline <spec 目录>`：把基线 spec 树里**已声明**的场景编号并入「已声明」集合。
//
// 没有它时，按 change 的 spec delta 跑合同对账会把整个 skill 的测试语料都判成 phantom：
// delta 只声明本 change 新增的 14 条场景，而测试里必然出现历史场景（实测 change-scoped
// 110 条 vs 并入基线后 72 条）。这些不是漂移，是口径差——用 change delta 去判一份
// skill 级测试语料，缺的永远是「别的 change 的场景」。
let baselineDir = null;
// `--max-phantom <n>`：允许的 phantom 条数（默认 0）。用于把**存量债**记成预算而不是
// 假装清零：实测 2026-10-27 本仓 72 条（测试标题声明了 spec 从未写过的编号），
// 收尾必须贴着这个数走——新增一条就越界失败，但不会让整个门禁永远红着没人看。
let maxPhantom = 0;
const positional = [];

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--partial" || arg === "--final") continue;
  if (arg === "--tasks") {
    tasksFile = argv[++i];
  } else if (arg.startsWith("--tasks=")) {
    tasksFile = arg.slice("--tasks=".length);
  } else if (arg === "--task") {
    targetTask = argv[++i];
  } else if (arg.startsWith("--task=")) {
    targetTask = arg.slice("--task=".length);
  } else if (arg === "--baseline") {
    baselineDir = argv[++i];
  } else if (arg.startsWith("--baseline=")) {
    baselineDir = arg.slice("--baseline=".length);
  } else if (arg === "--max-phantom") {
    maxPhantom = Number(argv[++i]);
  } else if (arg.startsWith("--max-phantom=")) {
    maxPhantom = Number(arg.slice("--max-phantom=".length));
  } else {
    positional.push(arg);
  }
}
if (!Number.isInteger(maxPhantom) || maxPhantom < 0) {
  console.error("--max-phantom 需要一个非负整数");
  process.exit(2);
}
if (baselineDir !== null && !fs.existsSync(baselineDir)) {
  console.error(`baseline 路径不存在: ${baselineDir}`);
  process.exit(2);
}

const specPath = positional[0];
const explicitTests = positional.slice(1);
const testArgs = [...explicitTests];

if (tasksFile) {
  if (!fs.existsSync(tasksFile)) {
    console.error(`tasks 文件不存在: ${tasksFile}`);
    process.exit(2);
  }
  const tasksContent = fs.readFileSync(tasksFile, "utf8");
  const extracted = extractTestsFromTasks(tasksContent, targetTask);
  for (const t of extracted) {
    if (!testArgs.includes(t)) testArgs.push(t);
  }
}

if (!specPath || testArgs.length === 0) {
  console.error("usage: contract-check.mjs <spec> <testPath...> [--final]");
  console.error("   or: contract-check.mjs <spec> --tasks <tasks.md> [--task <id>] [--partial] [--final]");
  console.error("  --final  收尾模式：测试路径一条都没产出时 exit 1，不再 SKIPPED 放行。");
  console.error("  --baseline <spec 目录>  并入基线已声明的场景编号（change delta 只声明增量，");
  console.error("                          不并基线会把历史场景全判成 phantom）。");
  console.error("  --max-phantom <n>       允许的 phantom 条数（默认 0）；用于把存量债记成预算。");
  console.error("  传入本 change 在 tasks.md Write scope / Verify with 里声明的测试路径（文件或目录）。");
  console.error("  不要传整个 test/ 目录：增量仓库里历史测试会把门禁打成 undeclared 全红。");
  process.exit(2);
}
if (!fs.existsSync(specPath)) {
  console.error(`spec 路径不存在: ${specPath}`);
  process.exit(2);
}

// 阶段 1 门禁的正确语义：此刻本 change 的测试可能尚未产出（Tester 在阶段 2 才上场）。
// 因此测试侧范围必须是「本 change 声明的测试」，不是整个 test/ 目录。
// 全部不存在 → SKIPPED 并 exit 0；部分存在（Tester 只交了一半）→ 视为不完整，exit 1。
const codeFiles = (p) => (fs.existsSync(p)
  ? walk(p).filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return CODE_EXT.has(ext) || SHELL_EXT.has(ext);
  })
  : []);
const existing = [];
const missing = [];
for (const arg of testArgs) {
  const files = codeFiles(arg);
  if (files.length === 0) missing.push(arg);
  else existing.push(...files);
}
if (existing.length === 0) {
  if (FINAL) {
    // 收尾时「一条测试都没有」不可能是正常状态：走这条分支等于整轮契约对账被静默跳过，
    // 收尾报告里却会写着「跑过 contract-check」。这就是 `--final` 存在的唯一理由。
    console.error(`收尾模式：声明的测试路径一条都没有产出（${missing.length} 条缺失），`
      + "此时不存在「Tester 尚未上场」的解释：");
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(1);
  }
  console.log(`SKIPPED: 声明的测试路径均尚未产出（阶段 1 正常状态，Tester 未上场）；共 ${missing.length} 条待产出：`);
  for (const m of missing) console.log(`  - ${m}`);
  process.exit(0);
}
if (missing.length > 0) {
  console.error(`本 change 声明的测试路径有 ${missing.length} 条未产出（部分产出视为不完整）：`);
  for (const m of missing) console.error(`  - ${m}`);
  process.exit(1);
}

/**
 * shell 用例里的 `SCEN-*` 只认**注释行**：夹具数据不算声明。
 *
 * `contract-check.test.sh` 大量用 heredoc 造夹具（`cat > "$WORK/spec-x.md" <<'EOF'`），
 * 这些 sed 出来的假场景编号（`SCEN-BASE-01`、`SCEN-TEST-99-PHANTOM`）是**被构造的输入**，
 * 不是「本仓库哪个场景有人验」。整文件扫会把它们全算成 phantom（本 change 实测 31→41）。
 * 与 JS 侧剥注释同理：测试里出现在字符串/夹具中的编号不是断言。
 *
 * 两步：先按 heredoc 界限剥掉整段夹具，再只保留 `#` 开头的行。只做后者不够——
 * heredoc 里的 spec 夹具本身就写着 `#### Scenario: SCEN-…`，那一行同样以 `#` 开头。
 */
const shellScenarioSrc = (text) => {
  const kept = [];
  let heredocEnd = null;
  for (const line of text.split(/\r?\n/)) {
    if (heredocEnd !== null) {
      if (line.trim() === heredocEnd) heredocEnd = null;
      continue;
    }
    const open = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (open !== null) { heredocEnd = open[2]; continue; }
    if (/^\s*#/.test(line)) kept.push(line);
  }
  return kept.join("\n");
};

const rawTestSrc = existing.map((f) => fs.readFileSync(f, "utf8")).join("\n");
// 消息通道只读 JS：shell 里没有 assert.throws，把 .sh 混进来只会引入噪声字面量。
const messageTestSrc = stripComments(
  existing.filter((f) => CODE_EXT.has(path.extname(f).toLowerCase()))
    .map((f) => fs.readFileSync(f, "utf8")).join("\n"),
);
// 场景通道读 JS 全文 + shell 的注释行：`.sh` 的用例说明写在 `#` 里。
//
// **这里不能走 stripComments**。JS 测试大量把场景编号写在 `// SCEN-…` 行注释里
// （既有全部测试都是这个形态）。剥注释会把它们全删掉，于是每个场景都变成 untested
// ——实测：改成剥注释后 shell 用例表 34 条里 10 条转红，最小复现是
// `// SCEN-A` 标注的场景被判「spec 声明但测试中未见静态引用」。
// 场景编号在注释里是**标注**，在断言里是**引用**，两者都算数；只有 shell 的 heredoc
// 夹具需要剥（那是被构造的输入，由 shellScenarioSrc 处理）。
const testSrc = existing.map((f) => {
  const text = fs.readFileSync(f, "utf8");
  return SHELL_EXT.has(path.extname(f).toLowerCase()) ? shellScenarioSrc(text) : text;
}).join("\n");
const specSrc = collect(specPath, DOC_EXT) || collect(specPath, CODE_EXT);

// ---- 常量表：message: 引用了标识符时先解析回字面量 ----
// 不解析会 fail-open：`message: TYPE_MESSAGE` 里的字面量在别处定义，脚本提取不到，
// tested 为空 → undeclared 恒为 0 → 门禁空转通过。实测反例（T-06）：
//   const TYPE_MESSAGE = "..."; assert.throws(f, { message: TYPE_MESSAGE })
//   → 旧版 tested=0 且 undeclared=0，exit 0，门禁看似通过实则没检查任何契约。
// 注意：这里必须把 STR 展开写，不能复用 `${STR}`——在前置的标识符捕获组之后，
// STR 里的 `\1` 会指向标识符组而不是引号组，整个正则静默失配（实测踩过）。
//
// **常量表必须按文件隔离**（实测踩过，本轮最隐蔽的一个）：
// 把所有测试文件拼成一段再建表，跨文件的同名常量会互相污染。
// 实测反例：test/math-base-convert.test.js 与 test/math-armstrong.test.js
// 都定义了 `const TYPE_MESSAGE`。合并建表后只剩首个定义（toBase 的那条），
// 于是 armstrong 里的 `message: TYPE_MESSAGE` 被解析成 toBase 的消息——
// "isArmstrongNumber requires a safe integer" 明明有断言，却被判成无覆盖；
// 同时 toBase 的消息在 armstrong 文件里也"有覆盖"。两个方向同时假绿灯。
// 正解：常量表按文件建；解析 message 引用时只查**同一个文件**里的常量。
//
// 只扫 JS 文件：shell 用例表的 heredoc 夹具里也写着 `const TYPE = "..."` 这样的片段，
// 它不是任何断言，混进消息通道就是 undeclared 误报（本 change 实测：夹具里的两条
// alpha 消息被算成「测试断言但 spec 未声明」）。
const jsTestFiles = existing.filter((f) => CODE_EXT.has(path.extname(f).toLowerCase()));
const CONSTS = new Map(); // file -> Map(标识符 -> 字面量)
const constRegex = new RegExp(
  String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'\`])((?:\\[\s\S]|(?!\2)[^\\])*)\2`,
  "g"
);
for (const f of jsTestFiles) {
  const fileSrc = stripComments(fs.readFileSync(f, "utf8"));
  const table = new Map();
  for (const m of fileSrc.matchAll(constRegex)) {
    if (!table.has(m[1])) table.set(m[1], m[3]);
  }
  CONSTS.set(f, table);
}
const constIn = (file, name) => CONSTS.get(file)?.get(name);

// ---- 测试侧：真正构成断言的错误消息 ----
const tested = new Set();
// message: IDENT / message: "literal"
for (const f of jsTestFiles) {
  const fileSrc = stripComments(fs.readFileSync(f, "utf8"));
  for (const m of fileSrc.matchAll(/\bmessage\s*:\s*([A-Za-z_$][\w$]*)/g)) {
    const lit = constIn(f, m[1]);
    if (lit !== undefined) tested.add(lit);
  }
}
// 不再做全局 `message: "..."` 与全局 `new XError("...")` 提取（2026-10-26 收窄）：
//   - 全局 `message:` 会收到**桩对象的返回值**，而不是任何契约。实测反例：
//     `async testConnection() { return { healthy: true, message: 'ok' }; }`
//     → 'ok' 被判成"测试断言但 spec 未声明"。
//   - 全局 `new XError(STR)` 会收到**被断言的输入**。实测反例：
//     `new MasterDataSyncError('MASTER_DATA_FETCH_FAILED', '远端不可达')`
//     → 错误码被当成断言消息。
// 断言内的这两类形态仍由断言窗口覆盖（窗口取第二实参里的全部字面量），覆盖面没有缩小。
// err.message === "..." / assert.equal(err.message, "...")
//
// **`typeof` 右侧的字符串不是错误消息**。实测反例：
//   assert.equal(typeof error.message, 'string')
// 会命中 `.message\s*(?:,|===?)\s*STR`，把类型名 `string` 判成「测试断言但 spec 未声明」，
// 于是本仓库跑 contract-check 必然多一条 undeclared。类型名是断言写法，不是契约。
const typeProbed = messageTestSrc.replace(/\btypeof\s+[A-Za-z_$][\w$.]*/g, "typeof");
addStrings(tested, typeProbed, new RegExp(String.raw`\.message\s*(?:,|===?|!==?)\s*${STR}`, "g"));
addStrings(tested, typeProbed, new RegExp(String.raw`${STR}\s*===?\s*[^;\n]*\.message`, "g"));

// assert.throws(fn, "..." | /.../ | new XError("...") | { message: "..." })
const REGEX_LIT = /\/((?![/*])(?:\\.|[^/\n\\])+)\/[gimsuy]*/g;
const CTOR_NAMES = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
  "EvalError", "URIError", "AggregateError",
]);
for (const w of messageWindows(assertWindows(messageTestSrc))) {
  // 断言窗口内的字符串字面量大多是被断言的错误消息，但 `name: "RangeError"`
  // 这类**判别字段**不是消息——一旦混入 tested，就会被判成 undeclared drift。
  // 先剥掉 name 字段与裸构造器名，再取剩余字面量。实测反例：
  //   assert.throws(f, { name: "RangeError", message: "..." })
  //   → 旧版把 "RangeError" 也当成断言消息，报 undeclared=2。
  const scrubbed = w.replace(
    new RegExp(String.raw`\bname\s*:\s*${STR}`, "g"),
    "name:__"
  );
  for (const m of scrubbed.matchAll(new RegExp(STR, "g"))) {
    if (!CTOR_NAMES.has(m[2])) tested.add(m[2]);
  }
  for (const m of scrubbed.matchAll(REGEX_LIT)) tested.add(m[1]);
}

// ---- 覆盖侧：判"spec 声明但无测试覆盖" ----
// **untested 必须以 tested（被断言真正引用过）为唯一依据**，不能用"文件里出现过
// 这个字面量"当覆盖——旧语义 fail-open。变异测试证明：把 assert.throws 的
// message 断言整个删掉、只把同一字面量留作普通字符串（note: "..."），
// 旧版判 untested=0 且 exit 0，门禁全绿，但该错误契约根本没有被任何断言引用。
// 覆盖 = 被某个断言真正引用过。
const covered = new Set(tested);

// ---- spec 侧：声明的错误字面量 ----
const declared = new Set(
  [...specSrc.matchAll(new RegExp(String.raw`(?:Type|Range|Syntax|Reference|Eval|URI|Aggregate)?Error\(\s*${STR}\s*\)`, "g"))].map(
    (m) => m[2]
  )
);

// ---- Scenario (SCEN-*) 双向对账 ----
// spec 侧声明的场景编号：匹配 `#### Scenario: SCEN-...`
const declaredScens = new Set(
  [...specSrc.matchAll(/####\s*Scenario:\s*(SCEN-[A-Za-z0-9-]+)/gi)].map((m) => m[1])
);
// `--baseline` 把基线 spec 树已声明的编号并入「已声明」：change delta 只声明增量，
// 测试语料是 skill 级的，不并基线就会把历史场景全判成 phantom（实测 110 vs 72）。
const baselineScens = baselineDir === null
  ? new Set()
  : new Set([...collect(baselineDir, DOC_EXT)
    .matchAll(/####\s*Scenario:\s*(SCEN-[A-Za-z0-9-]+)/gi)].map((m) => m[1]));
const declaredScensWithBaseline = new Set([...declaredScens, ...baselineScens]);
// 测试侧引用的场景编号：提取所有 SCEN-... 模式（注释、描述或断言内）
const testedScens = new Set();
for (const m of testSrc.matchAll(/\b(SCEN-[A-Za-z0-9-]+)\b/g)) {
  testedScens.add(m[1]);
}

const phantomScens = [...testedScens].filter((s) => !declaredScensWithBaseline.has(s)).sort();
// untested **只判本 change 自己的场景**，不判它从基线继承来的那些。
//
// 这不是宽松，是 MODIFIED 的语义要求：openspec 的 MODIFIED 替换整个 Requirement 块，
// 所以写 delta 时必须把基线原有的场景原样抄回来（抄漏会被 validate 拒绝）。抄回来之后，
// 那些编号出现在 delta 里并不代表本 change 新增了它们——它们仍由基线测试负责。
// 按 `declaredScens`（delta 全量）判 untested，等于把「抄写义务」变成「补测试义务」：
// 本仓实测 delta 声明 16 条、其中 11 条是抄回来的基线场景，全被判成本 change 未覆盖。
const ownScens = baselineDir === null ? declaredScens : new Set([...declaredScens].filter((s) => !baselineScens.has(s)));
const untestedScens = [...ownScens].filter((s) => !testedScens.has(s)).sort();

// 语义：本脚本是 **change 级**判据，不是任务级。
//   undeclared（测试断言了 spec 未声明的消息）→ 任何时候都必须清零，任务级也判。
//   untested  （spec 声明了但无测试覆盖）    → 只有把**本 change 全部**测试一起喂进来时
//                                               才有意义。单任务只覆盖自己那几条错误契约，
//                                               按任务粒度跑必然 untested 非零，那是假阳性。
// 因此：默认（无 --partial）双向判定；带 --partial 只判 undeclared。
const undeclared = [...tested].filter((m) => !declared.has(m)).sort();
const untested = [...declared].filter((m) => !covered.has(m)).sort();

// 只认契约性提及：必须有可执行语境的 throw/throws/raised 或 Error 类型名。
// 不能只搜 "error" 字样——标题里的 "Spec without error contract" 会误判成"提到了错误"。
const specMentionsError =
  /\b(?:throws?|raises?|raised|rejects?|fails?)\b/i.test(specSrc) ||
  /\b(?:Type|Range|Syntax|Reference|Eval|URI|Aggregate)?Error\b/.test(specSrc);
// 方言不匹配：spec 谈错误却不写 `Error("字面量")`，测试断言的是错误码/字段。
// 此时消息通道两侧根本不在同一个坐标系，逐条打印「测试断言但 spec 未声明」只会
// 制造噪声，让人以为 spec 缺声明——实际是通道不适用。
const dialectMismatch = declared.size === 0 && specMentionsError;

if (dialectMismatch) {
  console.log(
    "N/A: 消息通道不适用——本 spec 未用 `Error(\"...\")` 方言声明错误契约，测试侧断言的是错误码/字段。" +
      "消息通道未做任何对账，不等于通过；只对账场景编号。"
  );
} else {
  for (const m of undeclared) console.log(`测试断言但 spec 未声明: ${m}`);
  if (undeclared.length) {
    // 赋能：给可直接粘进 spec Scenario 的逐字声明行（解析器认的形态），不只报红。
    console.log(`[建议] 把下列行补进对应 Requirement 的 Scenario（类型按实际抛出的 Error 子类调整）：`);
    for (const m of undeclared) console.log(`  - THEN throws Error(${JSON.stringify(m)})`);
  }
  if (!PARTIAL) for (const m of untested) console.log(`spec 声明但测试中未见静态引用: ${m}`);
  else if (untested.length) console.log(`(--partial：${untested.length} 条 spec 声明尚未在本任务测试中静态引用，留待阶段 2 全量对账)`);
}

if (declaredScens.size > 0) {
  for (const s of phantomScens) console.log(`测试引用但 spec 未声明的场景 (phantom): ${s}`);
  if (!PARTIAL) for (const s of untestedScens) console.log(`spec 声明但测试中未见静态引用的场景: ${s}`);
  else if (untestedScens.length) console.log(`(--partial：${untestedScens.length} 条场景尚未在本任务测试中静态引用，留待阶段 2 全量对账)`);
}

const scenSummary = declaredScens.size > 0 ? ` scens=${testedScens.size}/${declaredScens.size} phantom_scens=${phantomScens.length} untested_scens=${untestedScens.length}` : "";
console.log(
  `tested=${tested.size} declared=${declared.size} undeclared=${undeclared.length} untested=${untested.length}${scenSummary}${PARTIAL ? " (partial)" : ""}`
);

// fail-closed（测试侧，优先判定）：测试里有 throws/rejects 却一条消息都提取不到
// → 是测试侧解析失效，不是"没有契约"。必须让门禁失败，否则 undeclared=0 是空转得出的假绿灯。
// 这一条**必须排在 spec 侧判定之前**：spec 即使没有错误契约，测试侧解析失效仍然是解析失效，
// 不能因为"spec 恰好没声明"就放行（实测踩过：动态拼接消息 + 无契约 spec 曾被判 exit 0）。
if (tested.size === 0 && messageWindows(assertWindows(messageTestSrc)).length > 0) {
  console.error(
    "测试里有 assert.throws/rejects，但没能提取出任何断言消息（可能写成了内联箭头或动态拼接）；" +
      "门禁不成立。请把错误消息写成字面量或同文件 const 常量。"
  );
  process.exit(1);
}
// fail-closed：spec 一条错误契约都没解析出来时，必须区分两种情况（实测踩过）：
//   (a) spec 确实有错误契约，只是没写成 `Error("字面量")` 这种可提取形态 → 解析失效，门禁不成立；
//   (b) spec 真的没有任何错误契约（如纯函数能力）→ 无可对账，如实说明，不冒充"通过"。
// 旧版只在 `tested.size > 0` 时才判失败，于是 (a) 中"测试也没断言任何错误"的情形
// 会静默 exit 0 —— declared=0、undeclared=0、untested=0，三数全零看着像完美通过。
if (declared.size === 0) {
  if (dialectMismatch) {
    if (declaredScens.size === 0) {
      console.log("SKIPPED: 本 spec 也没有场景编号，无可对账内容。");
      process.exit(0);
    }
    const scenFailed = phantomScens.length > maxPhantom || (!PARTIAL && untestedScens.length > 0);
    process.exit(scenFailed ? 1 : 0);
  }
  if (declaredScens.size > 0) {
    const scenFailed = phantomScens.length > maxPhantom || (!PARTIAL && untestedScens.length > 0);
    process.exit(scenFailed ? 1 : 0);
  }
  console.log(
    "SKIPPED: 本 spec 无错误契约声明（未出现 Error/throw），无可对账内容；" +
      "本门禁未对任何错误契约做校验，不等于通过。"
  );
  process.exit(0);
}
const scenFailed = declaredScens.size > 0 && (phantomScens.length > maxPhantom || (!PARTIAL && untestedScens.length > 0));
const errorFailed = undeclared.length > 0 || (!PARTIAL && untested.length > 0);
process.exit(errorFailed || scenFailed ? 1 : 0);
