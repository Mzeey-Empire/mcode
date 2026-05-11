#!/bin/bash
# Cursor Stop hook wrapper.
# Runs verify-tests.sh and translates the result into Cursor's JSON protocol.
# Exit 0 = allow, Exit 2 = block.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

output=$("$REPO_ROOT/scripts/agent/verify-tests.sh" 2>&1)
status=$?

if [ $status -eq 0 ]; then
  exit 0
else
  echo "BLOCK: verify-tests.sh failed. Fix the errors before finishing."
  echo "$output" | tail -20
  exit 2
fi
