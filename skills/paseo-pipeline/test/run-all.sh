#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tmp_tel="$(mktemp -d "${TMPDIR:-/tmp}/paseo-test-telemetry.XXXXXX")"
trap 'rm -rf "$tmp_tel"' EXIT
export PIPELINE_TELEMETRY_FILE="$tmp_tel/metrics.jsonl"
node --test test/*.test.mjs
