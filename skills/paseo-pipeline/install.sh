#!/usr/bin/env bash
# Minimal installer: export PIPELINE_HOME for noninteractive agents and install tier hooks.
set -euo pipefail
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd -P)"; SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in /*) ;; *) SOURCE="$DIR/$SOURCE" ;; esac
done
PIPELINE_HOME="$(cd "$(dirname "$SOURCE")" && pwd -P)"
ZSHENV="${HOME:-}/.zshenv"
MODE=apply
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) MODE=dry ;;
    --check) MODE=check ;;
    *) echo "usage: install.sh [--dry-run|--check]" >&2; exit 2 ;;
  esac; shift
done
BLOCK="# >>> paseo-pipeline >>>\nexport PIPELINE_HOME=\"$PIPELINE_HOME\"\n# <<< paseo-pipeline <<<"
SCHEMA_DIR="${XDG_DATA_HOME:-${HOME:-}/.local/share}/openspec/schemas/paseo-pipeline"
SCHEMA_SRC="$PIPELINE_HOME/openspec-schema"
schema_current() {
  [ -f "$SCHEMA_DIR/schema.yaml" ] && diff -rq "$SCHEMA_SRC" "$SCHEMA_DIR" >/dev/null 2>&1
}
# Hooks fail open, so a broken one is silent. Feed each a probe payload and require the expected reaction.
selftest() {
  local out
  out="$(printf '%s' '{"prompt":"ok go","session_id":"selftest","cwd":"/nonexistent"}' | PIPELINE_TIER_GATE_STATE="$(mktemp -d)" node "$PIPELINE_HOME/hooks/tier-reminder-hook.mjs" 2>/dev/null)" || return 1
  printf '%s' "$out" | grep -q 'additionalContext' || return 1
  out="$(printf '%s' '{}' | node "$PIPELINE_HOME/hooks/tier-session-hook.mjs" 2>/dev/null)" || return 1
  printf '%s' "$out" | grep -q 'additionalContext' || return 1
  printf '%s' '{"session_id":"selftest","cwd":"/nonexistent"}' | node "$PIPELINE_HOME/hooks/tier-stop-hook.mjs" >/dev/null 2>&1 || return 1
  printf '%s' '{"tool_name":"Write","tool_input":{"file_path":"/nonexistent/x"},"session_id":"selftest"}' | node "$PIPELINE_HOME/hooks/tier-write-hook.mjs" >/dev/null 2>&1 || return 1
  out="$(printf '%s' '{"tool_name":"mcp__paseo__list_agents","tool_input":{"serverId":"self"}}' | node "$PIPELINE_HOME/hooks/tool-guard-hook.mjs" 2>/dev/null)" || return 1
  printf '%s' "$out" | grep -q '"permissionDecision":"deny"' || return 1
  write_gate_probe
}
# Probe the write gate in a throwaway primary checkout: no transcript_path must deny with a
# diagnosis, and a transcript holding a valid TIER-PLAN must allow. This proves the hook's
# wiring only; whether the live harness sends transcript_path is a runtime fact it cannot check.
write_gate_probe() {
  local dir state out rc=0
  dir="$(mktemp -d)"; state="$(mktemp -d)"
  git -C "$dir" init -q 2>/dev/null || { rm -rf "$dir" "$state"; return 1; }
  printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"TIER-PLAN: tier=1 files=src/a.ts scope=src"}]}}' > "$dir/transcript.jsonl"
  local payload='{"tool_name":"Write","tool_input":{"file_path":"'"$dir"'/src/a.ts"},"session_id":"selftest-gate"'
  out="$(printf '%s' "$payload}" | PIPELINE_TIER_GATE_STATE="$state" node "$PIPELINE_HOME/hooks/tier-write-hook.mjs" 2>/dev/null)" || rc=1
  printf '%s' "$out" | grep -q '"permissionDecision":"deny"' || rc=1
  printf '%s' "$out" | grep -q 'transcript' || rc=1
  out="$(printf '%s' "$payload,\"transcript_path\":\"$dir/transcript.jsonl\"}" | PIPELINE_TIER_GATE_STATE="$state" node "$PIPELINE_HOME/hooks/tier-write-hook.mjs" 2>/dev/null)" || rc=1
  [ -z "$out" ] || rc=1
  rm -rf "$dir" "$state"
  return "$rc"
}
if [ "$MODE" = check ]; then
  SETTINGS="${HOME:-}/.claude/settings.json"
  schema_current || exit 1
  grep -q '^# >>> paseo-pipeline >>>' "$ZSHENV" \
    && grep -Fq "export PIPELINE_HOME=\"$PIPELINE_HOME\"" "$ZSHENV" \
    && grep -Fq "node $PIPELINE_HOME/hooks/tier-write-hook.mjs" "$SETTINGS" \
    && grep -Fq "node $PIPELINE_HOME/hooks/tier-reminder-hook.mjs" "$SETTINGS" \
    && grep -Fq "node $PIPELINE_HOME/hooks/tier-session-hook.mjs" "$SETTINGS" \
    && grep -Fq "node $PIPELINE_HOME/hooks/tier-stop-hook.mjs" "$SETTINGS" \
    && grep -Fq "node $PIPELINE_HOME/hooks/tool-guard-hook.mjs" "$SETTINGS" \
    && selftest \
    && exit 0
  exit 1
fi
if [ -e "$SCHEMA_DIR" ] || [ -L "$SCHEMA_DIR" ]; then
  if ! schema_current; then
    echo "Stale or conflicting OpenSpec schema: $SCHEMA_DIR" >&2
    echo "Expected match for: $SCHEMA_SRC" >&2
    exit 1
  fi
elif [ "$MODE" != dry ]; then
  mkdir -p "$(dirname "$SCHEMA_DIR")"
  ln -s "$SCHEMA_SRC" "$SCHEMA_DIR"
fi
if ! grep -q '^# >>> paseo-pipeline >>>' "$ZSHENV"; then
  [ "$MODE" = dry ] || printf '%b\n' "$BLOCK" >> "$ZSHENV"
fi
echo "PIPELINE_HOME=$PIPELINE_HOME"
echo "Tier reminder hook command:"
node "$PIPELINE_HOME/hooks/tier-reminder-hook.mjs" --install-help
echo "Tier write hook command (PreToolUse, matcher Write|Edit|MultiEdit|NotebookEdit):"
printf '%s\n' "node $PIPELINE_HOME/hooks/tier-write-hook.mjs"
echo "Structured writes in primary checkouts require a readable transcript and TIER-PLAN; Bash writes are not intercepted. Hook failures and unsupported inputs fail open; ask is not guaranteed to prompt in bypassPermissions."
echo "Tool guard hook command (PreToolUse, matcher Bash|mcp__.*):"
printf '%s\n' "node $PIPELINE_HOME/hooks/tool-guard-hook.mjs"
echo "Tier session hook command (SessionStart, matcher startup|resume|compact|clear):"
printf '%s\n' "node $PIPELINE_HOME/hooks/tier-session-hook.mjs"
echo "Tier stop hook command (Stop):"
printf '%s\n' "node $PIPELINE_HOME/hooks/tier-stop-hook.mjs"
if selftest; then echo "Hook self-test: ok"; else echo "Hook self-test: FAILED" >&2; exit 1; fi
