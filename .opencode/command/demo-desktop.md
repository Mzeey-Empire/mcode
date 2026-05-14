---
description: Launch the Electron desktop app under Playwright and screenshot the first window
---

Goal: demo an Electron-specific feature in the running desktop app.

Use this **only** for features that need the actual Electron runtime — native menus, tray, BrowserView, contextBridge IPC, deep links, window chrome. For anything that renders identically in the browser, prefer `/demo` (faster, Playwright MCP can drive it interactively).

1. Build the Electron bundles: `cd apps/desktop && bun run build`.
2. Run `node scripts/agent/demo-desktop.mjs`. It launches Electron via Playwright's `_electron.launch()`, waits for the first window, screenshots to `apps/web/e2e/screenshots/demo-desktop/`, and prints renderer errors.
3. Pass `--keep-open` to leave Electron running. Drive it programmatically using the `apps/desktop/e2e/electron-smoke.spec.ts` pattern (Playwright library, not the MCP — the MCP does not support Electron).
4. Promote regression-risk flows into `apps/desktop/e2e/` and run `/verify-e2e-desktop`.

See `docs/agents/demo.md` § Demoing the Desktop App for the full runbook.
