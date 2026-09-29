import { describe, expect, it } from "vitest";
import { nativeTurnDiffEvidence } from "../../private/codex/codex-provider.js";
import { CursorNativeTurnDiff } from "../../private/cursor/acp/cursor-native-turn-diff.js";
import { OpenCodeNativeTurnDiff } from "../../private/opencode/opencode-native-turn-diff.js";

const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-before\n+after\n";

/** Full-context upstream OpenCode patch for one changed line. */
function openCodeDiffEvent(file: string, before: string, after: string) {
  return [{
    file,
    patch: [
      `Index: ${file}`,
      "===================================================================",
      `--- ${file}`,
      `+++ ${file}`,
      "@@ -1,1 +1,1 @@",
      `-${before}`,
      `+${after}`,
      "",
    ].join("\n"),
    additions: 1,
    deletions: 1,
    status: "modified",
  }];
}

function openCodeEvidence(entries: readonly unknown[]) {
  return new OpenCodeNativeTurnDiff().observe(entries);
}

describe("provider-neutral native diff conformance", () => {
  it("rejects malformed Codex evidence so the service can select fallback", () => {
    expect(nativeTurnDiffEvidence(42)).toEqual({ state: "rejected" });
  });
  it.each(["codex", "cursor", "opencode"])("%s supplies the same complete aggregate", (provider) => {
    const evidence = provider === "codex"
      ? nativeTurnDiffEvidence(patch)
      : provider === "cursor"
        ? new CursorNativeTurnDiff().push(process.cwd(), [{ type: "diff", path: "a.txt", oldText: "before\n", newText: "after\n" }])
        : openCodeEvidence(openCodeDiffEvent("a.txt", "before", "after"));
    expect(evidence).toMatchObject({ state: "snapshot", patch });
  });

  it.each(["codex", "cursor", "opencode"])("%s reports a net-zero turn without a partial patch", (provider) => {
    const cursor = new CursorNativeTurnDiff();
    cursor.push(process.cwd(), [{ type: "diff", path: "a.txt", oldText: "before\n", newText: "after\n" }]);
    const opencode = new OpenCodeNativeTurnDiff();
    opencode.observe(openCodeDiffEvent("a.txt", "before", "after"));
    const evidence = provider === "codex"
      ? nativeTurnDiffEvidence("")
      : provider === "cursor"
        ? cursor.push(process.cwd(), [{ type: "diff", path: "a.txt", oldText: "after\n", newText: "before\n" }])
        // Upstream reports a reverted turn as an empty aggregate after a non-empty one.
        : opencode.observe([]);
    expect(evidence).toEqual({ state: "indeterminate-empty" });
  });

  it("opencode treats an empty first event as no information, not evidence", () => {
    const diff = new OpenCodeNativeTurnDiff();
    expect(diff.observe([])).toBeNull();
  });

  it.each(["cursor", "opencode"])("%s rejects unusable native evidence instead of emitting a partial patch", (provider) => {
    const evidence = provider === "cursor"
      ? new CursorNativeTurnDiff().push(process.cwd(), [{ type: "diff", path: "../outside.txt", oldText: "a\n", newText: "b\n" }])
      : openCodeEvidence([{ file: "../outside.txt", patch: "@@ -1,1 +1,1 @@\n-a\n+b\n", additions: 1, deletions: 1 }]);
    expect(evidence).toEqual({ state: "rejected" });
  });
});
