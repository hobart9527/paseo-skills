#!/usr/bin/env bash
# Minimal installer: export PIPELINE_HOME for noninteractive agents and install tier reminder.
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
if [ "$MODE" = check ]; then
  SETTINGS="${HOME:-}/.claude/settings.json"
  grep -q '^# >>> paseo-pipeline >>>' "$ZSHENV" \
    && grep -Fq "export PIPELINE_HOME=\"$PIPELINE_HOME\"" "$ZSHENV" \
    && grep -Fq "node $PIPELINE_HOME/hooks/tier-write-hook.mjs" "$SETTINGS" \
    && grep -Fq "node $PIPELINE_HOME/hooks/tier-reminder-hook.mjs" "$SETTINGS" \
    && exit 0
  exit 1
fi
if ! grep -q '^# >>> paseo-pipeline >>>' "$ZSHENV"; then
  [ "$MODE" = dry ] || printf '%b\n' "$BLOCK" >> "$ZSHENV"
fi
echo "PIPELINE_HOME=$PIPELINE_HOME"
echo "Tier reminder hook command:"
node "$PIPELINE_HOME/hooks/tier-reminder-hook.mjs" --install-help
echo "Tier write hook command:"
printf '%s\n' "node $PIPELINE_HOME/hooks/tier-write-hook.mjs"
