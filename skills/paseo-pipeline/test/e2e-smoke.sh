#!/usr/bin/env bash
# 端到端冒烟（不依赖 Paseo daemon）：在一次性 git 仓库里走完
# 冻结预检 → 任务分支 → merge-task 门禁 → acceptance-run → contract-check。
#
# 它回答的问题：各脚本拼在一起时，第 2 节的主路径能不能走通？单测只证明每个脚本单独对。
# 演练中暴露过的缺口都固化在这里：
#   - 矩阵 Verify 以 `!` 开头（freeze-check 必须拦下，写成 `sh -c '! …'` 才放行）
#   - 写手测试没有 SCEN 静态引用（contract-check --final 会恒红）
# 不覆盖：create_agent 派发、paseo wait、真实审计——这些需要活 daemon，见 templates/dispatch-shapes.md。
#
# 用法: PIPELINE_HOME=<skill 目录> bash test/e2e-smoke.sh
set -euo pipefail

HOME_DIR="${PIPELINE_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pp-e2e.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
STEP=0
step() { STEP=$((STEP + 1)); echo "[$STEP] $*"; }
die() { echo "E2E FAIL: $*" >&2; exit 1; }

cd "$WORK"
git init -q -b main
git config user.email e2e@example.invalid
git config user.name e2e
mkdir -p openspec/changes/demo/specs/cap src test

cat > openspec/changes/demo/specs/cap/spec.md <<'EOF'
## Purpose

Demo capability used by the end to end smoke script for the pipeline.

## ADDED Requirements

### Requirement: Echo works
The CLI SHALL echo its argument and fail on empty input.

#### Scenario: SCEN-E2E-01 echo
- **WHEN** run with hi
- **THEN** prints hi

#### Scenario: SCEN-E2E-02 empty fails
- **WHEN** run with no argument
- **THEN** exits non-zero
EOF

cat > openspec/changes/demo/tasks.md <<'EOF'
# Tasks

## 1. echo

- [ ] 1.1 T-01 实现 echo 命令
  - Depends on: none
  - Write scope: src/echo.mjs, test/echo.test.mjs
  - Risk-surface: [none]
  - Review: mechanical
  - Verify with: `node --test test/echo.test.mjs`
  - Scenarios: SCEN-E2E-01, SCEN-E2E-02
EOF

write_matrix() {
  cat > openspec/changes/demo/acceptance.md <<EOF
# Acceptance Matrix

| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| SCEN-E2E-01 | \`node src/echo.mjs hi\` | T-01 | \`test "\$(node src/echo.mjs hi)" = hi\` | yes | PENDING | pending |
| SCEN-E2E-02 | \`node src/echo.mjs\` | T-01 | $1 | yes | PENDING | pending |
EOF
}

step "freeze-check 拦下以 ! 开头的取反 Verify"
write_matrix '`! node src/echo.mjs`'
if node "$HOME_DIR/freeze-check.mjs" openspec/changes/demo >/dev/null 2>&1; then
  die "freeze-check 放行了 ! 开头的 Verify"
fi

step "freeze-check 放行 sh -c 包裹的取反"
write_matrix "\`sh -c '! node src/echo.mjs'\`"
node "$HOME_DIR/freeze-check.mjs" openspec/changes/demo >/dev/null || die "合法矩阵被拒"

git add -A && git commit -q -m "spec(demo): freeze"

step "任务分支实现并提交（含 SCEN 静态引用与血统 trailers）"
git checkout -q -b integration/demo
git checkout -q -b task/demo/T-01
cat > src/echo.mjs <<'EOF'
const arg = process.argv[2];
if (!arg) { process.exitCode = 1; } else { console.log(arg); }
EOF
cat > test/echo.test.mjs <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';

// SCEN-E2E-01
test('echo prints its argument', () => {
  assert.equal(execFileSync('node', ['src/echo.mjs', 'hi'], { encoding: 'utf8' }).trim(), 'hi');
});

// SCEN-E2E-02
test('echo fails on empty input', () => {
  assert.notEqual(spawnSync('node', ['src/echo.mjs']).status, 0);
});
EOF
git add -A
git commit -q -m "feat(demo): echo 命令

Pipeline-Role: gongbu
Pipeline-Author: e2e-smoke"

step "contract-check --final 对账通过"
git checkout -q integration/demo
git merge -q --no-ff task/demo/T-01 -m "merge(T-01): task/demo/T-01" || die "合并失败"
node "$HOME_DIR/contract-check.mjs" openspec/changes/demo/specs \
  --tasks openspec/changes/demo/tasks.md --final --max-phantom 0 >/dev/null \
  || die "contract-check 未通过"

step "acceptance-run 逐条真跑并回填"
node "$HOME_DIR/acceptance-run.mjs" demo --write >/dev/null || die "acceptance-run 失败"
[ "$(grep -c '| PASS |' openspec/changes/demo/acceptance.md)" = 2 ] || die "矩阵未回填两条 PASS"

echo "E2E OK ($STEP 步)"
