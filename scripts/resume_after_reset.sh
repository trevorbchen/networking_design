#!/usr/bin/env bash
# Resume a Claude Code conversation automatically after N hours (e.g. after a usage-limit reset).
#
#   scripts/resume_after_reset.sh <session-id> <hours> [prompt]
#
# Runs detached in the background. It checks the wall clock every 60s, so laptop sleep is
# fine, but it dies if WSL shuts down (wsl --shutdown / reboot).
# Output of the resumed run goes to runs/resume.log.
# Cancel with:   pkill -f resume_after_reset
#
# WARNING: the resumed run uses --dangerously-skip-permissions (no permission prompts),
# because nobody is there to approve them. Only use this in a repo you trust.
# Don't have the same conversation open interactively when it fires.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || echo "$HOME/.local/bin/claude")}"

if [[ "${1:-}" == "--run" ]]; then
  # internal: waiting/worker mode
  SID="$2"; TARGET="$3"; PROMPT="$4"
  while [[ "$(date +%s)" -lt "$TARGET" ]]; do sleep 60; done
  cd "$REPO"
  {
    echo "=== resume fired $(date) for session $SID ==="
    "$CLAUDE_BIN" --resume "$SID" -p "$PROMPT" --dangerously-skip-permissions
    echo "=== resume finished $(date) (exit $?) ==="
  } >> "$REPO/runs/resume.log" 2>&1
  exit 0
fi

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <session-id> <hours> [prompt]" >&2; exit 1
fi
SID="$1"; HOURS="$2"
PROMPT="${3:-Continue where you left off. Re-read CLAUDE.md / README.md if present, check git status, and keep working toward the goal.}"
TARGET="$(awk -v h="$HOURS" -v now="$(date +%s)" 'BEGIN{printf "%d", now + h*3600}')"
mkdir -p "$REPO/runs"
nohup "$0" --run "$SID" "$TARGET" "$PROMPT" > /dev/null 2>&1 &
echo "Resume scheduled for $(date -d "@$TARGET") (pid $!)."
echo "  session: $SID"
echo "  log:     $REPO/runs/resume.log"
echo "  cancel:  pkill -f resume_after_reset"
