import type { warmCodexVersionCache } from "./private/codex/codex-version.js";
import { meetsMinVersion } from "./version-policy.js";
export { meetsMinVersion } from "./version-policy.js";

/** Returns true when a dotted provider version meets the required floor. */
export function isProviderVersionAtLeast(version: string, minimum: string): boolean {
  return meetsMinVersion(version, minimum);
}

/** Warms the Codex provider availability cache without inspecting a turn. */
export function warmCodexProviderVersion(cliPath: string, runProcess: Parameters<typeof warmCodexVersionCache>[1]): Promise<void> {
  return import("./private/codex/codex-version.js").then(({ warmCodexVersionCache }) => (
    warmCodexVersionCache(cliPath, runProcess)
  ));
}
