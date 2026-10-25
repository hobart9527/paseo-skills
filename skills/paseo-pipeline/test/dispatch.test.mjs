import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dispatchPath = fileURLToPath(new URL("../dispatch.mjs", import.meta.url));
const hotfixPath = fileURLToPath(new URL("../hotfix.sh", import.meta.url));

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
    daemon: { agentProfiles: [{ id: "agent_profile_qingqibing", ...profile }] },
  }));
  const brief = path.join(repo, "brief.md");
  fs.writeFileSync(brief, "Fix only the assigned fixture task.\n");
  fs.writeFileSync(path.join(bin, "paseo"), `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.PASEO_CALLS_FILE, JSON.stringify(argv) + "\\n");
if (argv[0] === "run") {
  console.log("fixture-agent-id");
} else if (argv[0] !== "wait") {
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

function dryRun(context, profile, flags = []) {
  const setup = fixture(context, profile);
  const result = run(process.execPath, [
    dispatchPath, "qingqibing", "implement", "fixture-change", setup.brief,
    "--dry-run", ...flags,
  ], setup);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.ok(Array.isArray(output.argv), "dry-run JSON must expose argv");
  return { output, stderr: result.stderr };
}

function optionValues(argv, option) {
  return argv.flatMap((value, index) => value === option ? [argv[index + 1]] : []);
}

test("SCEN-DISP-02: dry-run announces legacy callback path in JSON and stderr", (context) => {
  const { output, stderr } = dryRun(context, { provider: "claude", model: "fixture-model" });
  assert.equal(output.legacy, true);
  assert.equal(typeof output.notice, "string");
  assert.match(output.notice, /LEGACY/);
  assert.match(output.notice, /callback/);
  assert.ok(stderr.includes(output.notice), "stderr must include the JSON legacy notice");
});

for (const { name, flags, labels } of [
  { name: "omitted", flags: [], labels: [] },
  { name: "task only", flags: ["--task", "T-04"], labels: ["pipeline.task=T-04"] },
  { name: "attempt only", flags: ["--attempt", "2"], labels: ["pipeline.attempt=2"] },
  { name: "phase only", flags: ["--phase", "test"], labels: ["pipeline.phase=test"] },
  {
    name: "all supplied",
    flags: ["--task", "T-04", "--attempt", "2", "--phase", "test"],
    labels: ["pipeline.task=T-04", "pipeline.attempt=2", "pipeline.phase=test"],
  },
]) {
  test(`SCEN-DISP-02: optional dispatch labels ${name}`, (context) => {
    const { output } = dryRun(context, { provider: "claude", model: "fixture-model" }, flags);
    const actual = optionValues(output.argv, "--label")
      .filter((value) => /^pipeline\.(task|attempt|phase)=/.test(value));
    assert.deepEqual(actual.sort(), [...labels].sort());
  });
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

for (const { name, profile, mode, thinking } of profileCases) {
  test(`SCEN-DISP-03: dispatch ${name}`, (context) => {
    const { output } = dryRun(context, profile);
    assert.deepEqual(optionValues(output.argv, "--provider"), [`${profile.provider}/${profile.model}`]);
    assert.deepEqual(optionValues(output.argv, "--mode"), mode);
    assert.deepEqual(optionValues(output.argv, "--thinking"), thinking);
  });
}

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

test("hotfix requires test-cmd before dispatching an agent", (context) => {
  const setup = hotfixFixture(context, { provider: "pi", model: "fixture-pi" });
  const result = run("bash", [hotfixPath, "fixture-change", "T-04", setup.brief], setup);
  const runs = paseoCalls(setup).filter((argv) => argv[0] === "run");
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(runs, [], "missing test-cmd must fail before paseo run");
});
