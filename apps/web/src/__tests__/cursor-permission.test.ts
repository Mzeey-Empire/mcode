import { describe, it, expect } from "vitest";
import { isCursorPermissionLockedToFull } from "../lib/cursor-permission";

/**
 * The cursor provider runs through `cursor-agent --print`, which has no
 * interactive permission flow. On macOS/Linux we delegate safety to
 * cursor-agent's `--sandbox enabled` flag (OS-level sandbox). On Windows the
 * OS sandbox is unavailable ("Sandbox requires macOS or Linux"), so
 * supervised mode would silently degrade to "no real safety". To avoid
 * lying to the user, the Composer locks the permission mode to Full access
 * (and hides the Supervised toggle) when the host is Windows AND the
 * provider is cursor.
 */
describe("isCursorPermissionLockedToFull", () => {
  it("locks when provider is cursor on Windows", () => {
    expect(isCursorPermissionLockedToFull("cursor", true)).toBe(true);
  });

  it("does not lock when provider is cursor on a non-Windows host", () => {
    expect(isCursorPermissionLockedToFull("cursor", false)).toBe(false);
  });

  it("does not lock when provider is not cursor on Windows", () => {
    expect(isCursorPermissionLockedToFull("claude", true)).toBe(false);
    expect(isCursorPermissionLockedToFull("codex", true)).toBe(false);
    expect(isCursorPermissionLockedToFull("copilot", true)).toBe(false);
  });

  it("does not lock when provider is not cursor on a non-Windows host", () => {
    expect(isCursorPermissionLockedToFull("claude", false)).toBe(false);
  });
});
