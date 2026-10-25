#!/usr/bin/env bash
set -euo pipefail

echo "=== Running contract-check test ==="
bash skills/paseo-pipeline/contract-check.test.sh

echo "=== Running Node regression tests ==="
node --test \
  skills/paseo-pipeline/test/tasks.test.mjs \
  skills/paseo-pipeline/test/reconcile.test.mjs \
  skills/paseo-pipeline/test/merge-task.test.mjs \
  skills/paseo-pipeline/test/dispatch.test.mjs \
  skills/paseo-pipeline/test/docs.test.mjs \
  skills/paseo-pipeline/test/check-evidence.test.mjs

echo "=== All regression test suites completed successfully ==="
