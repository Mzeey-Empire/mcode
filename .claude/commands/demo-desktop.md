---
description: Launch the Electron desktop app under Playwright, screenshot the first window, and report renderer errors
argument-hint: [feature-name]
---

Goal: demo the Electron-specific feature `$ARGUMENTS` in the running desktop app.

Use this **only** for features that need the actual Electron runtime — native menus, tray, BrowserView, contextBridge IPC, deep links, window chrome. For anything that renders identically in the browser, prefer `/demo` (Vite) — it is faster and the Playwright MCP can drive it interactively.

1. Ensure the Electron bundles are built:
   ```sh
   cd apps/desktop && bun run build
   ```
2. Run `node scripts/agent/demo-desktop.mjs`. It launches Electron via Playwright's `_electron.launch()`, waits for the first window, screenshots it to `apps/web/e2e/screenshots/demo-desktop/`, and prints renderer errors.
3. To drive interactively, pass `--keep-open` and then attach via the `apps/desktop/e2e/electron-smoke.spec.ts` pattern (Playwright library, not the MCP — the MCP does not support Electron).
4. Promote any regression-risk flow you discovered into `apps/desktop/e2e/` and run `/verify-e2e-desktop`.

See `docs/agents/demo.md` § Demoing the Desktop App for the full runbook.
