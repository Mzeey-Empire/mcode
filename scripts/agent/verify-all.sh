#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$SCRIPT_DIR/verify-tests.sh"
"$SCRIPT_DIR/verify-e2e.sh"

echo ""
echo "=== All verification passed ==="
