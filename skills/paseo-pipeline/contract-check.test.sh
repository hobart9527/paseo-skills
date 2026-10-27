#!/usr/bin/env bash
# contract-check.mjs 回归用例。用 bash 跑：zsh 不做默认分词，$ALL 会被当成单个参数。
# 用法：bash contract-check.test.sh
set -u
CC="$(cd "$(dirname "$0")" && pwd)/contract-check.mjs"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
check() { # 期望退出码 描述 实际退出码
  if [ "$3" = "$1" ]; then
    printf '  ✔ %s (exit=%s)\n' "$2" "$3"; pass=$((pass + 1))
  else
    printf '  ✘ %s (期望 exit=%s，实得 exit=%s)\n' "$2" "$1" "$3"; fail=$((fail + 1))
  fi
}
run() { node "$CC" "$@" >/dev/null 2>&1; echo $?; }

# ---------- 夹具 ----------
mkdir -p "$WORK"
cat > "$WORK/spec-full.md" <<'EOF'
### Requirement: Alpha
1. `TypeError("alpha requires a safe integer")` when the argument is not a safe integer.
2. `RangeError("alpha argument must not be negative")` when the argument is negative.
3. `TypeError("beta requires a safe integer")` when the other argument is not a safe integer.
EOF
cat > "$WORK/spec-noerror.md" <<'EOF'
### Requirement: Beta
The module `beta.js` SHALL export `beta()` returning 1.
EOF
cat > "$WORK/spec-mentions.md" <<'EOF'
### Requirement: Gamma
The module SHALL throw when given a bad value.
EOF
cat > "$WORK/test-alpha.test.js" <<'EOF'
const TYPE = "alpha requires a safe integer";
const RANGE = "alpha argument must not be negative";
assert.throws(() => f(1.5), { name: "TypeError", message: TYPE });
assert.throws(() => f(-1), { name: "RangeError", message: RANGE });
EOF
# 同名常量跨文件：alpha.test.js 用 TYPE，beta.test.js 也用 TYPE 但值不同
cat > "$WORK/test-beta.test.js" <<'EOF'
const TYPE = "beta requires a safe integer";
assert.throws(() => g(1.5), { name: "TypeError", message: TYPE });
EOF
# 字面量留存、断言被删（覆盖伪装成"出现过"）
cat > "$WORK/test-nocov.test.js" <<'EOF'
const TYPE = "alpha requires a safe integer";
assert.ok(true);
const note = "alpha requires a safe integer";
EOF
cat > "$WORK/test-dynamic.test.js" <<'EOF'
const P = "bad ";
assert.throws(() => { throw new Error(P + "thing"); });
EOF
cat > "$WORK/test-plain.test.js" <<'EOF'
assert.ok(true);
EOF

echo "R1 全量双零 → 期望 0"
check 0 "全量双零" "$(run "$WORK/spec-full.md" "$WORK/test-alpha.test.js" "$WORK/test-beta.test.js")"

echo "R2 真 drift（测试断言 spec 未声明）→ 期望 1"
cat > "$WORK/test-drift.test.js" <<'EOF'
assert.throws(() => f(1.5), { name: "TypeError", message: "alpha requires a safe integerX" });
EOF
check 1 "真 drift" "$(run "$WORK/spec-full.md" "$WORK/test-drift.test.js")"
echo "R3 覆盖伪装（字面量留存但断言删除）→ 期望 1（旧版 fail-open 判 0）"
check 1 "覆盖伪装" "$(run "$WORK/spec-full.md" "$WORK/test-nocov.test.js")"

echo "R4 跨文件同名常量污染 → 期望 1（alpha 的 TypeError 被 beta 的同名常量顶掉）"
# 只喂 alpha.test.js 与 nocov.test.js：nocov 里 alpha 的消息只作文本、不作断言。
# 若常量表跨文件污染，nocov 的 TYPE 会顶掉 alpha.test.js 的 TYPE，
# 于是 alpha 的 TypeError 契约被判"无覆盖"（untested），期望 exit=1。
check 1 "跨文件常量污染" "$(run "$WORK/spec-full.md" "$WORK/test-alpha.test.js" "$WORK/test-nocov.test.js")"

echo "R5 测试未产出 → 期望 0 SKIPPED"
check 0 "SKIPPED" "$(run "$WORK/spec-full.md" "$WORK/nope.test.js")"

echo "R6 部分产出 → 期望 1"
check 1 "部分产出" "$(run "$WORK/spec-full.md" "$WORK/test-alpha.test.js" "$WORK/nope.test.js")"

echo "R7 spec 提到 error 但用错误码方言 → 期望 0（消息通道报 N/A，2026-10-26 语义变更）"
check 0 "spec 有 error 无字面量 → N/A" "$(run "$WORK/spec-mentions.md" "$WORK/test-plain.test.js")"

echo "R8 spec 确实无错误契约 → 期望 0 SKIPPED"
check 0 "无错误契约 SKIPPED" "$(run "$WORK/spec-noerror.md" "$WORK/test-plain.test.js")"

echo "R9 测试消息动态拼接 → 期望 1（fail-closed）"
check 1 "动态消息" "$(run "$WORK/spec-noerror.md" "$WORK/test-dynamic.test.js")"

echo "R10 --partial 单任务 → 期望 0（只判 undeclared）"
check 0 "partial" "$(run "$WORK/spec-full.md" "$WORK/test-alpha.test.js" --partial)"

echo "R11 用法错误（缺参数）→ 期望 2"
check 2 "用法错误" "$(run "$WORK/spec-full.md")"

echo "R12 --tasks 自动解析全量测试 → 期望 0"
cat > "$WORK/sample-tasks.md" <<EOF
- [x] 1.1 T-01: Alpha test
  - Write scope: [test-alpha.test.js]
  - Verify with: \`node --test $WORK/test-alpha.test.js\`
- [x] 1.2 T-02: Beta test
  - Write scope: [test-beta.test.js]
  - Verify with: \`node --test $WORK/test-beta.test.js\`
EOF
check 0 "--tasks 全量解析" "$(run "$WORK/spec-full.md" --tasks "$WORK/sample-tasks.md")"

echo "R13 --tasks 单任务 --task T-01 --partial → 期望 0"
check 0 "--tasks 单任务 partial" "$(run "$WORK/spec-full.md" --tasks "$WORK/sample-tasks.md" --task T-01 --partial)"

echo "R14 --tasks 未匹配到任务 → 期望 2"
check 2 "--tasks 未匹配任务" "$(run "$WORK/spec-full.md" --tasks "$WORK/sample-tasks.md" --task T-99)"

echo "R15 --tasks 文件不存在 → 期望 2"
check 2 "--tasks 文件不存在" "$(run "$WORK/spec-full.md" --tasks "$WORK/not-exist.md")"

# ---------- 场景对账测试 (SCEN-*) ----------
cat > "$WORK/spec-scen.md" <<'EOF'
### Requirement: ScenRequirement
1. `TypeError("scen error")` when bad.

#### Scenario: SCEN-TEST-01-BASIC Happy path
#### Scenario: SCEN-TEST-02-EDGE Edge case
EOF

cat > "$WORK/test-scen-full.test.js" <<'EOF'
assert.throws(() => f(), { name: "TypeError", message: "scen error" });
// SCEN-TEST-01-BASIC
// SCEN-TEST-02-EDGE
EOF

cat > "$WORK/test-scen-partial.test.js" <<'EOF'
assert.throws(() => f(), { name: "TypeError", message: "scen error" });
// SCEN-TEST-01-BASIC
EOF

cat > "$WORK/test-scen-phantom.test.js" <<'EOF'
assert.throws(() => f(), { name: "TypeError", message: "scen error" });
// SCEN-TEST-01-BASIC
// SCEN-TEST-02-EDGE
// SCEN-TEST-99-PHANTOM
EOF

echo "R16 spec 声明场景且全部覆盖 → 期望 0"
check 0 "场景全覆盖" "$(run "$WORK/spec-scen.md" "$WORK/test-scen-full.test.js")"

echo "R17 测试引用幽灵场景 (phantom) → 期望 1"
check 1 "幽灵场景拦截" "$(run "$WORK/spec-scen.md" "$WORK/test-scen-phantom.test.js")"

echo "R18 场景未完全覆盖且无 --partial → 期望 1"
check 1 "场景遗漏拦截" "$(run "$WORK/spec-scen.md" "$WORK/test-scen-partial.test.js")"

echo "R19 场景未完全覆盖带 --partial → 期望 0"
check 0 "场景部分覆盖 partial" "$(run "$WORK/spec-scen.md" "$WORK/test-scen-partial.test.js" --partial)"

# ---------- 2026-10-27：change-scoped 口径（--baseline / --max-phantom） ----------
# 实测动机：SKILL 让收尾用 **change 的 spec delta** 跑收尾对账，而 delta 只声明本 change
# 新增的场景，测试语料却是整个 skill 级的。于是历史场景全被判成 phantom——本仓实测
# change-scoped 110 条 vs 并入基线后 72 条，rc 恒为 1，门禁与实际脱节，最后没人看它。
mkdir -p "$WORK/baseline-specs"
cat > "$WORK/baseline-specs/base.md" <<'EOF'
#### Scenario: SCEN-BASE-01 historical scenario
#### Scenario: SCEN-BASE-02 another historical scenario
EOF
cat > "$WORK/spec-delta.md" <<'EOF'
#### Scenario: SCEN-NEW-01 this change's scenario
EOF
cat > "$WORK/test-delta.test.js" <<'EOF'
// SCEN-NEW-01
// SCEN-BASE-01
EOF

# SCEN-CON-19
echo "R20 change delta 单跑：基线场景被判 phantom → 期望 1"
check 1 "delta 单跑 phantom" "$(run "$WORK/spec-delta.md" "$WORK/test-delta.test.js" --partial)"

echo "R21 并入 --baseline 后基线场景不再算 phantom → 期望 0"
check 0 "baseline 并入" "$(run "$WORK/spec-delta.md" "$WORK/test-delta.test.js" --partial --baseline "$WORK/baseline-specs")"

echo "R22 --baseline 路径不存在 → 期望 2"
check 2 "baseline 路径不存在" "$(run "$WORK/spec-delta.md" "$WORK/test-delta.test.js" --baseline "$WORK/nope")"

# SCEN-CON-20
echo "R23 存量债记预算：phantom 超预算仍拦 → 期望 1"
cat > "$WORK/test-debt.test.js" <<'EOF'
// SCEN-NEW-01
// SCEN-BASE-01
// SCEN-LEGACY-01
// SCEN-LEGACY-02
EOF
check 1 "存量债超预算" "$(run "$WORK/spec-delta.md" "$WORK/test-debt.test.js" --partial --baseline "$WORK/baseline-specs" --max-phantom 1)"

echo "R24 存量债在预算内放行 → 期望 0"
check 0 "存量债在预算内" "$(run "$WORK/spec-delta.md" "$WORK/test-debt.test.js" --partial --baseline "$WORK/baseline-specs" --max-phantom 2)"

echo "R25 --max-phantom 非整数 → 期望 2"
check 2 "--max-phantom 非法值" "$(run "$WORK/spec-delta.md" "$WORK/test-delta.test.js" --max-phantom abc)"

# MODIFIED 的语义要求把基线原有场景原样抄回 delta（openspec 按整块替换，抄漏会被 validate 拒绝）。
# 抄回来不等于本 change 新增了它们：它们仍由基线测试负责。用 delta 全量判 untested，
# 等于把「抄写义务」变成「补测试义务」——本仓实测 delta 声明 16 条，其中 11 条是抄回来的基线场景。
cat > "$WORK/spec-delta-inherit.md" <<'EOF'
#### Scenario: SCEN-NEW-01 this change's scenario
#### Scenario: SCEN-BASE-01 a baseline scenario copied back only to satisfy MODIFIED
EOF
# 只覆盖本 change 自己的那条：继承来的场景由基线测试负责，本 change 的测试里不该出现它。
cat > "$WORK/test-delta-own.test.js" <<'EOF'
// SCEN-NEW-01
EOF

echo "R25b 抄回 delta 的基线场景不算本 change 的 untested 义务 → 期望 0"
check 0 "继承场景不判 untested" "$(run "$WORK/spec-delta-inherit.md" "$WORK/test-delta-own.test.js" --baseline "$WORK/baseline-specs")"

echo "R25c 同一份 delta 不并基线时该继承场景仍是 untested → 期望 1"
check 1 "不并基线仍判 untested" "$(run "$WORK/spec-delta-inherit.md" "$WORK/test-delta-own.test.js")"

# ---------- 2026-10-27：--final 的语义边界 ----------
# 实测反例：assert.equal(typeof error.message, 'string') 会被判成
# 「测试断言但 spec 未声明: string」——typeof 右侧是类型名，不是错误消息契约。
cat > "$WORK/spec-typeof.md" <<'EOF'
### Requirement: TypeProbe
1. `TypeError("real message")` when bad.

#### Scenario: SCEN-TY-01 type probe
EOF
cat > "$WORK/test-typeof.test.js" <<'EOF'
assert.equal(typeof err.message, 'string');
assert.throws(() => f(), { name: "TypeError", message: "real message" });
// SCEN-TY-01
EOF

# SCEN-CON-21
echo "R26 typeof 右侧的类型名不算错误消息契约 → 期望 0"
check 0 "typeof 类型名" "$(run "$WORK/spec-typeof.md" "$WORK/test-typeof.test.js")"

# ---------- 2026-10-26 收窄：谓词窗口、全局提取、方言不适用 ----------
cat > "$WORK/spec-code.md" <<'EOF'
### Requirement: CodeDialect
The adapter SHALL reject with an error whose `code` identifies the failure.
#### Scenario: SCEN-CODE-01 rejection carries a code
- **WHEN** the payload is invalid
- **THEN** the error code is `ATTACHMENT_SIZE_INVALID`.
EOF
# 谓词回调：断言的错误码不是完整消息，不得进消息通道。
cat > "$WORK/test-predicate.test.js" <<'EOF'
function hasErrorCode(expected) {
  return (error) => error.code === expected;
}
await assert.rejects(fn, hasErrorCode('ATTACHMENT_SIZE_INVALID'));
await assert.rejects(fn, (err) => err instanceof TypeError && err.code === 'INVALID_LOAN_RESERVATION');
// SCEN-CODE-01
EOF
echo "R27 谓词回调 + 错误码方言 → 期望 0（消息通道 N/A，只对账场景）"
check 0 "谓词窗口不进消息通道" "$(run "$WORK/spec-code.md" "$WORK/test-predicate.test.js")"

# 全局 message: 提取已删：桩返回值不是契约。
cat > "$WORK/test-stub-value.test.js" <<'EOF'
const fakeClient = {
  async testConnection() {
    return { healthy: true, latencyMs: 1, message: 'ok' };
  }
};
await assert.rejects(fn, (err) => err.code === 'ATTACHMENT_SIZE_INVALID');
// SCEN-CODE-01
EOF
echo "R28 桩返回值 message: 'ok' → 期望 0（不再被当成断言消息）"
check 0 "桩返回值不算断言" "$(run "$WORK/spec-code.md" "$WORK/test-stub-value.test.js")"

# 全局 new XError(STR) 提取已删：构造输入不是断言消息。
cat > "$WORK/test-ctor-input.test.js" <<'EOF'
const fetcher = { dict: new MasterDataSyncError('MASTER_DATA_FETCH_FAILED', '远端不可达') };
await assert.rejects(fn, (err) => err.code === 'ATTACHMENT_SIZE_INVALID');
// SCEN-CODE-01
EOF
echo "R29 构造器输入被断言 → 期望 0（不再被当成 spec 未声明）"
check 0 "构造输入不算断言消息" "$(run "$WORK/spec-code.md" "$WORK/test-ctor-input.test.js")"

# 方言匹配时消息通道照常双向对账：真 drift 仍要拦。
cat > "$WORK/test-code-drift.test.js" <<'EOF'
await assert.rejects(fn, { message: "spec 没声明这条消息" });
// SCEN-CODE-01
EOF
echo "R30 方言匹配时的真 drift → 期望 1"
check 1 "真 drift 仍拦" "$(run "$WORK/spec-full.md" "$WORK/test-code-drift.test.js" --partial)"

# shell 用例表也是测试语料：`# SCEN-…` 注释行是「这条用例验哪个场景」的标注。
# 实测缺口：只扫 JS 扩展名时，由 bash 用例承载的场景永远被判「无测试引用」。
# 但 heredoc 夹具里的 `#### Scenario: …` 是被构造的输入，不算引用——不剥会把它们算成 phantom。
cat > "$WORK/spec-shell.md" <<'EOF'
#### Scenario: SCEN-SH-01 covered by a shell case
EOF
cat > "$WORK/shell.test.sh" <<'EOF'
# SCEN-SH-01
cat > "$WORK/spec-fixture.md" <<'INNER'
#### Scenario: SCEN-SH-99 constructed input, not a reference
INNER
EOF

# SCEN-CON-24
echo "R26a shell 用例的注释行算作场景引用 → 期望 0"
check 0 "shell 注释算引用" "$(run "$WORK/spec-shell.md" "$WORK/shell.test.sh")"

echo "R26b heredoc 夹具里的场景编号不算引用 → 期望 0（否则 SH-99 会被判 phantom）"
check 0 "夹具不算引用" "$(run "$WORK/spec-shell.md" "$WORK/shell.test.sh" --partial --max-phantom 0)"

# --final 收尾模式：测试路径一条都没产出时不再是「阶段 1 正常状态」。
# 实测缺口：收尾时跑同一条命令会打印 SKIPPED 并 exit 0，收尾报告写着「跑过 contract-check」，
# 实际一条契约都没对账。
cat > "$WORK/tasks-notest.md" <<'EOF'
- [ ] 1.1 T-01 只有 scope 没有测试
  - Write scope: src/a.mjs
  - Review: standard
EOF
echo "R31 默认模式：测试路径全缺 → 期望 0（SKIPPED，规划期正常）"
check 0 "规划期 SKIPPED 放行" "$(run "$WORK/spec-full.md" --tasks "$WORK/tasks-notest.md")"
echo "R32 收尾模式：测试路径全缺 → 期望 1"
check 1 "收尾模式不许 SKIPPED" "$(run "$WORK/spec-full.md" --tasks "$WORK/tasks-notest.md" --final)"

printf '\n通过 %d / 失败 %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
