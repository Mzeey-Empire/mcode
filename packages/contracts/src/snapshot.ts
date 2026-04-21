/**
 * Snapshot-safe subset of @mcode/contracts.
 *
 * Only re-exports symbols that are safe to evaluate in a bare V8 isolate
 * (no Node.js builtins, no side-effecting module-level calls).
 *
 * Used by `apps/desktop/src/main/snapshot-entry.ts` via the
 * `@mcode/contracts/snapshot` subpath export. Do NOT add re-exports from
 * modules that call schema factories at module scope (e.g. ws/channels.ts)
 * or that reference platform globals like TextEncoder.
 */

export { SettingsSchema } from "./models/settings.js";
export type { Settings } from "./models/settings.js";
export { getExtension } from "./models/file-types.js";
