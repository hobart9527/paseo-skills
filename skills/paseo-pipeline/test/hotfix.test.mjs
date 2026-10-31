import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hotfixPath = fileURLToPath(new URL("../hotfix.sh", import.meta.url));
const runStatePath = fileURLToPath(new URL("../run-state.mjs", import.meta.url));

function fixture(context, profile) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-dispatch-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const repo = path.join(root, "repo");
  const callsFile = path.join(root, "paseo-calls.jsonl");
  for (const directory of [path.join(home, ".paseo"), bin, repo]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(home, ".paseo", "config.json"), JSON.stringify({
    daemon: { agentProfiles: [{ id: "agent_profile_gongbu", ...profile }] },
  }));
  const brief = path.join(repo, "brief.md");
  fs.writeFileSync(brief, "Fix only the assigned fixture task.\n");
  // 替身按 task-runner 的派发序列应答：`run` 真的建出任务 worktree（模拟
  // `--new-workspace worktree`），`wait` 回 idle，`inspect` 回 idle。
  // 置 PASEO_FIXTURE_COMMIT=1 时额外模拟写手交付：在 --new-branch 上落一个带
  // Pipeline-Role/Pipeline-Author trailers 的提交，这样后半段（真实 tip/base review 标签 →
  // merge-task 合流）能被真正走到。
  fs.writeFileSync(path.join(bin, "paseo"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.PASEO_CALLS_FILE, JSON.stringify(argv) + "\\n");
const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
if (argv[0] === "run") {
  const branch = value("--new-branch");
  const base = value("--base");
  const worktree = path.join(path.dirname(process.env.PASEO_CALLS_FILE), "ws");
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, worktree, base], { stdio: "ignore" });
  if (process.env.PASEO_FIXTURE_COMMIT === "1") {
    fs.appendFileSync(path.join(worktree, "brief.md"), "fixture worker change\\n");
    execFileSync("git", ["commit", "-aqm", "fix: fixture task\\n\\nPipeline-Role: gongbu\\nPipeline-Author: 0123456789abcdef0123456789abcdef"],
      { cwd: worktree, stdio: "ignore" });
  }
  if (process.env.PASEO_FIXTURE_BAD_ID === "1") {
    // 模拟 CLI 输出形态漂移：多了一行提示，末位不是 agentId。dispatch 必须拒绝错绑。
    console.log("agent created successfully");
  } else {
    console.log("01234567-89ab-cdef-0123-456789abcdef");
  }
} else if (argv[0] === "wait") {
  console.log(JSON.stringify({ id: argv[1], status: "idle" }));
} else if (argv[0] === "inspect") {
  console.log(JSON.stringify({ Status: "idle" }));
} else {
  console.error("Unexpected paseo command: " + argv[0]);
  process.exit(1);
}
`, { mode: 0o755 });
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  Object.assign(env, {
    HOME: home,
    PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
    PASEO_CALLS_FILE: callsFile,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: "Pipeline Test",
    GIT_AUTHOR_EMAIL: "pipeline-test@example.invalid",
    GIT_COMMITTER_NAME: "Pipeline Test",
    GIT_COMMITTER_EMAIL: "pipeline-test@example.invalid",
  });
  return { repo, brief, env, callsFile };
}

function run(command, argv, setup) {
  const result = spawnSync(command, argv, {
    cwd: setup.repo,
    env: setup.env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}


function optionValues(argv, option) {
  return argv.flatMap((value, index) => value === option ? [argv[index + 1]] : []);
}


const profileCases = [
  {
    name: "pi ignores declared mode and leaves missing thinking absent",
    profile: { provider: "pi", model: "fixture-pi", modeId: "fixture-mode" },
    mode: [], thinking: [],
  },
  {
    name: "pi preserves declared thinking while omitting mode",
    profile: {
      provider: "pi", model: "fixture-pi", modeId: "fixture-mode", thinkingOptionId: "high",
    },
    mode: [], thinking: ["high"],
  },
  {
    name: "non-pi omits both undeclared options",
    profile: { provider: "claude", model: "fixture-claude" },
    mode: [], thinking: [],
  },
  {
    name: "non-pi preserves thinking without inventing mode",
    profile: { provider: "claude", model: "fixture-claude", thinkingOptionId: "high" },
    mode: [], thinking: ["high"],
  },
  {
    name: "non-pi preserves mode without inventing thinking",
    profile: { provider: "claude", model: "fixture-claude", modeId: "fixture-mode" },
    mode: ["fixture-mode"], thinking: [],
  },
  {
    name: "complete claude profile preserves provider, mode and thinking",
    profile: {
      provider: "claude", model: "fixture-claude", modeId: "fixture-mode", thinkingOptionId: "high",
    },
    mode: ["fixture-mode"], thinking: ["high"],
  },
];

function hotfixFixture(context, profile) {
  const setup = fixture(context, profile);
  const tasks = path.join(setup.repo, "openspec", "changes", "fixture-change");
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, "tasks.md"), [
    "# Tasks", "", "- [ ] 1.1 T-04 fixture task",
    "  - Depends on: none", "  - Write scope: brief.md",
    "  - Risk-surface: [none]", "  - Review: mechanical", "  - Verify with: true", "",
  ].join("\n"));
  for (const argv of [
    ["init", "--initial-branch=integration/fixture-change"],
    ["add", "."],
    ["-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture baseline"],
  ]) {
    const result = run("git", argv, setup);
    assert.equal(result.status, 0, result.stderr);
  }
  const status = run("git", ["status", "--porcelain"], setup);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout, "", "hotfix fixture must have a clean working tree");
  return setup;
}

function paseoCalls(setup) {
  if (!fs.existsSync(setup.callsFile)) return [];
  return fs.readFileSync(setup.callsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("SCEN-DISP-02: hotfix announces unverified legacy callback at runtime", (context) => {
  const setup = hotfixFixture(context, { provider: "pi", model: "fixture-pi" });
  const git = run("sh", ["-c", "command -v git"], setup);
  assert.equal(git.status, 0, git.stderr);
  const bin = setup.env.PATH.split(path.delimiter)[0];
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
if [ "$1" = "worktree" ]; then exit 73; fi
exec "${git.stdout.trim()}" "$@"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "paseo"), "#!/bin/sh\nexit 73\n", { mode: 0o755 });
  const result = run("bash", [hotfixPath, "fixture-change", "T-04", setup.brief, "true"], setup);
  assert.match(`${result.stdout}\n${result.stderr}`,
    /LEGACY: completion callback not verified for this path/);
});

for (const { name, profile, mode, thinking } of profileCases) {
  test(`SCEN-DISP-03: hotfix ${name}`, (context) => {
    const setup = hotfixFixture(context, profile);
    const result = run("bash", [hotfixPath, "fixture-change", "T-04", setup.brief, "true"], setup);
    const calls = paseoCalls(setup);
    const runs = calls.filter((argv) => argv[0] === "run");
    assert.equal(runs.length, 1, `hotfix must reach paseo run: ${result.stderr}`);
    assert.deepEqual(optionValues(runs[0], "--provider"), [`${profile.provider}/${profile.model}`]);
    assert.deepEqual(optionValues(runs[0], "--mode"), mode);
    assert.deepEqual(optionValues(runs[0], "--thinking"), thinking);
  });
}

test("SCEN-DISP-04: hotfix stamps all five identity labels and a real tip/base review tag", (context) => {
  const setup = hotfixFixture(context, { provider: "claude", model: "fixture-claude" });
  setup.env.PASEO_FIXTURE_COMMIT = "1";
  const result = run("bash", [hotfixPath, "fixture-change", "T-04", setup.brief, "true"], setup);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const runs = paseoCalls(setup).filter((argv) => argv[0] === "run");
  assert.equal(runs.length, 1);
  // 五个身份标签缺一不可：reconcile 依赖它们做归属、cap 计数与 phase 排序。
  const labels = optionValues(runs[0], "--label").sort();
  assert.deepEqual(labels, [
    "pipeline.attempt=1",
    "pipeline.change=fixture-change",
    "pipeline.phase=impl",
    "pipeline.role=gongbu",
    "pipeline.task=T-04",
  ]);
  assert.deepEqual(optionValues(runs[0], "--new-branch"), ["task/fixture-change/T-04"]);

  // Done 行必须绑定真实 tip 与真实 base，而不是写死的 pass(mechanical)。
  const tasks = fs.readFileSync(
    path.join(setup.repo, "openspec", "changes", "fixture-change", "tasks.md"), "utf8");
  const doneLine = tasks.split("\n").find((line) => line.includes("Done:"));
  assert.ok(doneLine, `merge must write a Done line:\n${tasks}`);
  assert.match(doneLine, /^\s*-\s*Done: source=[0-9a-f]{7} review=pass\(mechanical@[0-9a-f]{7}\/[0-9a-f]{7}\)$/);

  const tip7 = /source=([0-9a-f]{7})/.exec(doneLine)[1];
  const branchTip = run("git", ["rev-parse", "--short=7", "task/fixture-change/T-04"], setup);
  assert.equal(branchTip.stdout.trim(), tip7, "Done source must equal the merged branch tip");
});

// SCEN-HND-08
test("SCEN-DISP-08: hotfix claims then records the dispatch intent in the run ledger", (context) => {
  const setup = hotfixFixture(context, { provider: "claude", model: "fixture-claude" });
  setup.env.PASEO_FIXTURE_COMMIT = "1";
  const stateDir = path.join(path.dirname(setup.repo), "ledger");
  setup.env.PIPELINE_RUN_STATE_DIR = stateDir;
  const result = run("bash", [hotfixPath, "fixture-change", "T-04", setup.brief, "true"], setup);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  // 断言对象迁移：意图由委托的 task-runner 打印（`(intent <key>)`），仍是同一个键。
  assert.match(result.stdout, /\(intent local:T-04:1:impl:gongbu:dispatch\)/);
  const ledger = JSON.parse(fs.readFileSync(path.join(stateDir, "fixture-change", "run-state.json"), "utf8"));
  const intent = ledger.intents.find((entry) => entry.key === "local:T-04:1:impl:gongbu:dispatch");
  assert.ok(intent, `意图必须入账: ${JSON.stringify(ledger.intents)}`);
  assert.equal(intent.agentId, "01234567-89ab-cdef-0123-456789abcdef", "record 必须登记真实 agentId");
  assert.ok(intent.resolvedAt, "record 后意图必须已回执（resolvedAt 非空）");
});

test("SCEN-DISP-08: hotfix aborts before dispatch when the intent is already claimed", (context) => {
  // 重复意图 = 上一次派发的创建可能已在途；意图护栏必须拦住 hotfix 的旁路重派（F5 前完全失明）。
  const setup = hotfixFixture(context, { provider: "claude", model: "fixture-claude" });
  const stateDir = path.join(path.dirname(setup.repo), "ledger");
  setup.env.PIPELINE_RUN_STATE_DIR = stateDir;
  const claim = run(process.execPath, [
    runStatePath, "claim", "fixture-change", "--task", "T-04", "--attempt", "1",
    "--phase", "impl", "--role", "gongbu",
  ], setup);
  assert.equal(claim.status, 0, claim.stderr);
  const result = run("bash", [hotfixPath, "fixture-change", "T-04", setup.brief, "true"], setup);
  assert.notEqual(result.status, 0, "重复意图必须中止 hotfix");
  // 拒绝由委托的 task-runner claim 闸门发出；断言拒绝原因与被拒后零派发，不绑定措辞来源。
  assert.match(result.stderr, /拒绝重复派发/);
  assert.equal(paseoCalls(setup).filter((argv) => argv[0] === "run").length, 0, "被拒绝时不得派发");
});

test("SCEN-DISP-04: hotfix counts an existing base branch as attempt 1 and branches with -a2", (context) => {
  const setup = hotfixFixture(context, { provider: "claude", model: "fixture-claude" });
  setup.env.PASEO_FIXTURE_COMMIT = "1";
  // 已存在第 1 次派发留下的基分支：重派必须递增到 attempt=2 并落到 `-a2`，
  // 而不是再次算出 attempt=1 去撞同名分支（历史缺陷）。
  run("git", ["branch", "task/fixture-change/T-04", "integration/fixture-change"], setup);
  const result = run("bash", [hotfixPath, "fixture-change", "T-04", setup.brief, "true"], setup);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const runs = paseoCalls(setup).filter((argv) => argv[0] === "run");
  assert.equal(runs.length, 1);
  assert.deepEqual(optionValues(runs[0], "--label").sort(), [
    "pipeline.attempt=2",
    "pipeline.change=fixture-change",
    "pipeline.phase=impl",
    "pipeline.role=gongbu",
    "pipeline.task=T-04",
  ]);
  assert.deepEqual(optionValues(runs[0], "--new-branch"), ["task/fixture-change/T-04-a2"]);
});

// SCEN-HND-08
test("SCEN-HND-08: hotfix is a wrapper with no dispatch call of its own", () => {
  // 唯一 CLI 派发入口是 task-runner.mjs。脚本自身出现 `paseo run` 就意味着又有了第二条派发路径，
  // 分支/标签/意图记账会再次各写一套并漂移。注释里提历史可以，可执行调用不行。
  const script = fs.readFileSync(hotfixPath, "utf8");
  const code = script.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /\bpaseo\b[\s\S]{0,80}?\brun\b/,
    "hotfix.sh 不得自己调用 paseo run");
  assert.doesNotMatch(code, /\bCLI=\(|\bpaseo wait\b|\bpaseo inspect\b/,
    "hotfix.sh 不得自己派发或等待 agent");
  assert.match(code, /task-runner\.mjs/, "hotfix.sh 必须委托 task-runner.mjs");
  // 意图记账与 profile 解析只有一个实现，不能在本脚本里再出现。
  assert.doesNotMatch(code, /run-state\.mjs/, "hotfix.sh 不得自己 claim/record/fail");
  assert.doesNotMatch(code, /agent_profile_gongbu/, "hotfix.sh 不得自己解析写手 profile");
});

// SCEN-HND-08
test("SCEN-HND-08: a non-mechanical task is refused before the entry is delegated to", (context) => {
  const setup = hotfixFixture(context, { provider: "claude", model: "fixture-claude" });
  const tasksFile = path.join(setup.repo, "openspec", "changes", "fixture-change", "tasks.md");
  fs.writeFileSync(tasksFile, fs.readFileSync(tasksFile, "utf8")
    .replace("Review: mechanical", "Review: standard"), "utf8");
  run("git", ["commit", "-aqm", "fixture: standard task"], setup);
  const result = run("bash", [hotfixPath, "fixture-change", "T-04", setup.brief, "true"], setup);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /只允许 Review: mechanical/);
  // 两个「未派发」的独立证据：替身 paseo 一次都没被调用，且委托的入口根本没起来
  // （否则就是「先派发、再等下游拒绝」——那会让写手真的开工）。
  assert.deepEqual(paseoCalls(setup), [], "被拒绝时不得发生任何 paseo 调用");
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /\[task-runner\]/,
    "非 mechanical 必须在委托之前拒绝，不得进入 task-runner");
});

// SCEN-HND-08
test("SCEN-HND-08: a mechanical run delegates with the brief/test-cmd validated but not forwarded", (context) => {
  // 契约真源是 tasks.md：brief 内容与调用者的 test-cmd 都不得再拼进 prompt / 传给 merge。
  // 这里传一个必定失败的 test-cmd：若它参与了合流，合流就会失败；合流成功证明只跑了
  // tasks.md 的 Verify with。
  const setup = hotfixFixture(context, { provider: "claude", model: "fixture-claude" });
  setup.env.PASEO_FIXTURE_COMMIT = "1";
  const result = run("bash", [hotfixPath, "fixture-change", "T-04", setup.brief, "false"], setup);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\[task-runner\] T-04: Dispatched writer agent/,
    "mechanical 任务必须经入口派发");
  const runs = paseoCalls(setup).filter((argv) => argv[0] === "run");
  assert.equal(runs.length, 1);
  assert.doesNotMatch(runs[0][1], /Fix only the assigned fixture task/,
    "brief 内容不再拼进写手 prompt（契约真源是 tasks.md）");
  assert.doesNotMatch(runs[0][1], /\bfalse\b/, "调用者的 test-cmd 不得进入写手 prompt");
  const tasks = fs.readFileSync(
    path.join(setup.repo, "openspec", "changes", "fixture-change", "tasks.md"), "utf8");
  assert.match(tasks, /Done: source=[0-9a-f]{7} review=pass\(mechanical@[0-9a-f]{7}\/[0-9a-f]{7}\)/,
    "合流成功且 Done 行由入口写入");
});

test("hotfix refuses a task that is not Review: mechanical", (context) => {
  const setup = hotfixFixture(context, { provider: "pi", model: "fixture-pi" });
  const tasksFile = path.join(setup.repo, "openspec", "changes", "fixture-change", "tasks.md");
  fs.writeFileSync(tasksFile, fs.readFileSync(tasksFile, "utf8")
    .replace("Review: mechanical", "Review: strict"), "utf8");
  run("git", ["commit", "-aqm", "fixture: strict task"], setup);
  const result = run("bash", [hotfixPath, "fixture-change", "T-04", setup.brief, "true"], setup);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /只允许 Review: mechanical/);
  assert.deepEqual(paseoCalls(setup).filter((argv) => argv[0] === "run"), [],
    "a rejected precheck must not dispatch");
});

test("hotfix refuses a mechanical task that declares a risk surface", (context) => {
  const setup = hotfixFixture(context, { provider: "pi", model: "fixture-pi" });
  const tasksFile = path.join(setup.repo, "openspec", "changes", "fixture-change", "tasks.md");
  // crypto/auth 是真实风险词；Review: mechanical 与之冲突，parseTasks 报 REVIEW_RISK_CONFLICT，
  // hotfix 的预检必须先拒，而不是让带风险的改动从小修快轨绕过审查。
  fs.writeFileSync(tasksFile, fs.readFileSync(tasksFile, "utf8")
    .replace("Risk-surface: [none]", "Risk-surface: [crypto/auth]"), "utf8");
  run("git", ["commit", "-aqm", "fixture: risky task"], setup);
  const result = run("bash", [hotfixPath, "fixture-change", "T-04", setup.brief, "true"], setup);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /REVIEW_RISK_CONFLICT|禁止快轨/);
  assert.deepEqual(paseoCalls(setup).filter((argv) => argv[0] === "run"), [],
    "a rejected precheck must not dispatch");
});

test("hotfix requires test-cmd before dispatching an agent", (context) => {
  const setup = hotfixFixture(context, { provider: "pi", model: "fixture-pi" });
  const result = run("bash", [hotfixPath, "fixture-change", "T-04", setup.brief], setup);
  const runs = paseoCalls(setup).filter((argv) => argv[0] === "run");
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(runs, [], "missing test-cmd must fail before paseo run");
});

// --- 派发侧 fail-closed（2026-10-26 走查 §3 未闭合项 4） ---

test("SCEN-CON-13 SCEN-DISP-05: hotfix refuses to dispatch when no worker profile resolves", (context) => {
  // 旧实现把 profile 查找写在 `read -r ... < <(...)` 里：node 抛错（找不到 profile）
  // 只让子 shell 失败，PROVIDER 变成空串，`paseo run --provider ""` 照常发出——
  // 派发出去却没人能完成。这里必须拒绝派发，且不得调用 paseo run。
  const setup = hotfixFixture(context, { provider: "pi", model: "fixture-pi" });
  fs.writeFileSync(path.join(setup.env.HOME, ".paseo", "config.json"), JSON.stringify({
    daemon: { agentProfiles: [{ id: "agent_profile_someone_else", provider: "pi", model: "x" }] },
  }));
  const result = run("bash", [hotfixPath, "fixture-change", "T-04", setup.brief, "true"], setup);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /agent_profile_gongbu|空 provider/);
  assert.deepEqual(paseoCalls(setup).filter((argv) => argv[0] === "run"), [],
    "an unresolvable profile must fail before paseo run");
});

test("SCEN-CON-13 SCEN-DISP-05: hotfix refuses a profile that resolves to an empty provider", (context) => {
  const setup = hotfixFixture(context, { provider: "pi", model: "fixture-pi" });
  fs.writeFileSync(path.join(setup.env.HOME, ".paseo", "config.json"), JSON.stringify({
    daemon: { agentProfiles: [{ id: "agent_profile_gongbu" }] },
  }));
  const result = run("bash", [hotfixPath, "fixture-change", "T-04", setup.brief, "true"], setup);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /缺 provider\/model|空 provider/);
  assert.deepEqual(paseoCalls(setup).filter((argv) => argv[0] === "run"), []);
});

test("SCEN-DISP-06: hotfix derives a 7-char review tag even when --short=7 would lengthen", (context) => {
  // `git rev-parse --short=7` 在前缀歧义时自动输出更长 SHA（8 位以上），
  // 而 merge-task 的 review 正则与 tip 比对只接受恰好 7 位——于是合法标签被拒，
  // 报错还指向标签格式而不是歧义本身。这里用 git 包装器模拟歧义：任何 --short=7
  // 都返回 9 位。若脚本仍依赖它，标签会变成 9 位并被 merge-task 拒绝。
  const setup = hotfixFixture(context, { provider: "claude", model: "fixture-claude" });
  setup.env.PASEO_FIXTURE_COMMIT = "1";
  const realGit = run("sh", ["-c", "command -v git"], setup);
  assert.equal(realGit.status, 0, realGit.stderr);
  const bin = setup.env.PATH.split(path.delimiter)[0];
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--short=7" ]; then
    exec "${realGit.stdout.trim()}" rev-parse --short=9 HEAD
  fi
done
exec "${realGit.stdout.trim()}" "$@"
`, { mode: 0o755 });

  const result = run("bash", [hotfixPath, "fixture-change", "T-04", setup.brief, "true"], setup);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const tasks = fs.readFileSync(
    path.join(setup.repo, "openspec", "changes", "fixture-change", "tasks.md"), "utf8");
  const doneLine = tasks.split("\n").find((line) => line.includes("Done:"));
  assert.ok(doneLine, `merge must write a Done line:\n${tasks}`);
  assert.match(doneLine, /review=pass\(mechanical@[0-9a-f]{7}\/[0-9a-f]{7}\)$/,
    "review tag must be exactly 7 chars even under prefix ambiguity");
});
