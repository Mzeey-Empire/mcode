#!/bin/bash
set -euo pipefail

# Skip verification if no code changes exist (e.g., brainstorming-only sessions).
# Checks staged, unstaged, and untracked .ts/.tsx/.js/.jsx files.
if git diff --quiet HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' 2>/dev/null && \
   [ -z "$(git ls-files --others --exclude-standard -- '*.ts' '*.tsx' '*.js' '*.jsx' 2>/dev/null)" ]; then
  echo "=== No code changes detected, skipping verification ==="
  exit 0
fi

echo "=== Typecheck ==="
bun run typecheck

echo "=== Lint ==="
bun run lint

echo "=== Unit Tests ==="
bun run test

echo ""
echo "=== All checks passed ==="
