#!/bin/bash
set -euo pipefail

echo "=== E2E Tests ==="
cd apps/web && bun run e2e
