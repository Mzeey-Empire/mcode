/**
 * Sanitize a custom branch name as the user types.
 * Replaces git-invalid characters with hyphens and collapses sequences
 * that git-check-ref-format rejects (`..`, `//`, consecutive hyphens).
 * Also strips structural patterns like leading `-`/`/`, `.lock` suffix,
 * and dot-prefixed path components (e.g. `feat/.hidden`).
 */
export function sanitizeCustomBranchInput(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9/._-]/g, "-")
    .replace(/\.lock$/i, "")
    .replace(/\.{2,}/g, ".")
    .replace(/\/{2,}/g, "/")
    .replace(/-{2,}/g, "-")
    .replace(/(?:^|\/)\.+/g, (m) => m.startsWith("/") ? "/" : "")
    .replace(/^[-/]+/, "")
    .slice(0, 100);
}

/**
 * Strip trailing dots, slashes, and hyphens from a branch name.
 * Used at submission time to clean up artifacts that the onChange
 * sanitizer intentionally preserves while the user is still typing.
 */
export function trimTrailingBranchChars(name: string): string {
  return name.replace(/[./-]+$/, "");
}
