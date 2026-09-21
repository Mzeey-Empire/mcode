import { render, waitFor } from "@testing-library/react";
import { parsePatchFiles } from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

// jsdom lacks both observers the pierre Virtualizer constructs unconditionally.
// Reporting every item as intersecting is fine for assertions on content; the
// virtualization window itself is exercised in the live app.
class MockIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  unobserve() {}
  disconnect() {}
}

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
});

const PATCH = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const gone = 2;
+const added = 3;
+const extra = 4;
 const b = 5;
diff --git a/src/bar.ts b/src/bar.ts
index 3333333..4444444 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -10,3 +10,2 @@
 keep();
-away();
 stay();
`;

describe("pierre CodeView spike", () => {
  it("renders diff lines for parsed patch files", async () => {
    const fileDiffs = parsePatchFiles(PATCH).flatMap((patch) => patch.files);
    expect(fileDiffs).toHaveLength(2);

    const { container } = render(
      <div style={{ height: 600, width: 800 }}>
        <CodeView
          disableWorkerPool
          items={fileDiffs.map((fileDiff) => ({
            type: "diff" as const,
            id: fileDiff.name ?? "unknown",
            fileDiff,
            collapsed: false,
          }))}
          options={{ theme: "github-light", diffStyle: "unified" }}
        />
      </div>,
    );

    // Diff lines render inside each <diffs-container> open shadow root.
    const shadowText = () =>
      [...container.querySelectorAll("diffs-container")]
        .map((el) => el.shadowRoot?.textContent ?? "")
        .join("\n");

    await waitFor(() => {
      expect(shadowText()).toContain("const added = 3;");
      expect(shadowText()).toContain("stay();");
    });
  });
});
