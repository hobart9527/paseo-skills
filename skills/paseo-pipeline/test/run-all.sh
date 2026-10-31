#!/usr/bin/env bash
set -euo pipefail

# 自动定位到仓库根目录，防止子目录执行时相对路径失效
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

echo "=== Running contract-check test ==="
bash skills/paseo-pipeline/contract-check.test.sh

echo "=== Running Node regression tests ==="
node --test \
  skills/paseo-pipeline/test/tasks.test.mjs \
  skills/paseo-pipeline/test/paseo-state.test.mjs \
  skills/paseo-pipeline/test/reconcile.test.mjs \
  skills/paseo-pipeline/test/merge-task.test.mjs \
  skills/paseo-pipeline/test/hotfix.test.mjs \
  skills/paseo-pipeline/test/docs.test.mjs \
  skills/paseo-pipeline/test/check-evidence.test.mjs \
  skills/paseo-pipeline/test/run-state.test.mjs \
  skills/paseo-pipeline/test/freeze-check.test.mjs \
  skills/paseo-pipeline/test/pipeline-doctor.test.mjs \
  skills/paseo-pipeline/test/task-runner.test.mjs \
  skills/paseo-pipeline/test/lock.test.mjs \
  skills/paseo-pipeline/test/change-id.test.mjs \
  skills/paseo-pipeline/test/envelope.test.mjs \
  skills/paseo-pipeline/test/roles.test.mjs \
  skills/paseo-pipeline/test/acceptance-run.test.mjs \
  skills/paseo-pipeline/test/guard-scope.test.mjs skills/paseo-pipeline/test/tier-gate.test.mjs

echo "=== Running e2e smoke ==="
bash skills/paseo-pipeline/test/e2e-smoke.sh

echo "=== All regression test suites completed successfully ==="
