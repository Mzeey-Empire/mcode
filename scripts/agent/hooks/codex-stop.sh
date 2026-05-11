#!/bin/bash
# Codex Stop hook wrapper.
# Runs verify-tests.sh and returns Codex's expected JSON response.
# {"decision":"approve"} to continue, {"decision":"block","reason":"..."} to block.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

output=$("$REPO_ROOT/scripts/agent/verify-tests.sh" 2>&1)
status=$?

if [ $status -eq 0 ]; then
  echo '{"decision":"approve"}'
else
  # Escape the output for JSON (replace newlines, quotes)
  escaped=$(echo "$output" | tail -10 | tr '\n' ' ' | sed 's/"/\\"/g')
  echo "{\"decision\":\"block\",\"reason\":\"verify-tests.sh failed: ${escaped}\"}"
fi
