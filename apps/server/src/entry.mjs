/**
 * @deprecated Legacy bootstrap for running the server as raw TypeScript under
 * Electron `utilityProcess`. The supported paths are:
 * - Standalone: `bun src/index.ts` (see `apps/server/package.json` `start`)
 * - Desktop: bundled `apps/desktop/dist/server/server.cjs` (see `server-manager.ts`)
 *
 * This module is retained so accidental imports fail with a clear message
 * instead of a missing `tsx` dependency.
 */
throw new Error(
  "apps/server/src/entry.mjs is deprecated. Use `bun src/index.ts` or spawn apps/desktop/dist/server/server.cjs under Electron (ELECTRON_RUN_AS_NODE=1).",
);
