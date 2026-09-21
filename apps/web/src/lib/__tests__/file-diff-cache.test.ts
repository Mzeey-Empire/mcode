import { describe, it, expect } from "vitest";
import { FileDiffCache } from "../file-diff-cache";

const PATCH = `diff --git a/a.ts b/a.ts
index 0000000..1111111 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
 context
-old
+new`;

const PATCH_2 = `diff --git a/a.ts b/a.ts
index 0000000..1111111 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
 context
-old
+newer`;

describe("FileDiffCache", () => {
  it("returns the same object while the patch is unchanged", () => {
    const cache = new FileDiffCache();
    const first = cache.get("s", "a.ts", PATCH)!;
    expect(cache.get("s", "a.ts", PATCH)).toBe(first);
  });

  it("re-parses with a distinct cacheKey when the patch changes", () => {
    const cache = new FileDiffCache();
    const first = cache.get("s", "a.ts", PATCH)!;
    const second = cache.get("s", "a.ts", PATCH_2)!;
    expect(second).not.toBe(first);
    expect(second.cacheKey).not.toBe(first.cacheKey);
  });

  it("re-parses with a distinct cacheKey when the scope changes", () => {
    const cache = new FileDiffCache();
    const first = cache.get("s1", "a.ts", PATCH)!;
    const second = cache.get("s2", "a.ts", PATCH)!;
    expect(second).not.toBe(first);
    expect(second.cacheKey).not.toBe(first.cacheKey);
  });

  it("does not reuse entries across paths", () => {
    const cache = new FileDiffCache();
    const a = cache.get("s", "a.ts", PATCH)!;
    const b = cache.get("s", "b.ts", PATCH)!;
    expect(a).not.toBe(b);
    expect(a.cacheKey).not.toBe(b.cacheKey);
  });

  it("returns undefined for a patch with no files", () => {
    const cache = new FileDiffCache();
    expect(cache.get("s", "a.ts", "not a diff")).toBeUndefined();
  });
});
