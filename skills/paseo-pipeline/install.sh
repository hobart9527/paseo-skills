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
  printf '%s' '{"tool_name":"Write","tool_input":{"file_path":"/nonexistent/x"},"session_id":"selftest"}' | node "$PIPELINE_HOME/hooks/tier-write-hook.mjs" >/dev/null 2>&1
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
echo "Tier session hook command (SessionStart, matcher startup|resume|compact|clear):"
printf '%s\n' "node $PIPELINE_HOME/hooks/tier-session-hook.mjs"
echo "Tier stop hook command (Stop):"
printf '%s\n' "node $PIPELINE_HOME/hooks/tier-stop-hook.mjs"
if selftest; then echo "Hook self-test: ok"; else echo "Hook self-test: FAILED" >&2; exit 1; fi
