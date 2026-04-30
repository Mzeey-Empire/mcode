/**
 * Returns true when the Composer should hard-lock the permission mode to
 * Full access for the cursor provider on Windows.
 *
 * Why: `cursor-agent --print` (the transport mcode uses for cursor) has no
 * interactive permission flow. Supervised mode delegates safety to
 * `--sandbox enabled`, which only works on macOS/Linux — on Windows the
 * binary errors out with "Sandbox requires macOS or Linux". Falling back to
 * `--sandbox disabled` (cursor-agent's allowlist mode) gates *shell* but not
 * the agent's built-in file/edit tools, so "Supervised" on Windows-cursor
 * would promise safety it can't deliver. Hiding the toggle and locking to
 * Full access is the honest default until a real per-tool gate exists.
 *
 * The function is platform-/provider-injectable so it can be unit-tested
 * without mocking `navigator`.
 */
export function isCursorPermissionLockedToFull(
  provider: string,
  isWindowsHost: boolean,
): boolean {
  return provider === "cursor" && isWindowsHost;
}
