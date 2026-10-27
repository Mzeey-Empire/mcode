import { mockTransport } from "@/__tests__/mocks/transport";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parsePatchFiles } from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import type { ReviewFileChange } from "@mcode/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewDiffView } from "@/components/diff/ReviewDiffView";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";

const transport = {
  getWorkingTreeDiff: vi.mocked(mockTransport.getWorkingTreeDiff),
  readFileContent: vi.mocked(mockTransport.readFileContent),
  readFileAtRef: vi.mocked(mockTransport.readFileAtRef),
};

vi.mock("@/transport", async (original) => ({
  ...(await original<object>()),
  getTransport: () => mockTransport,
}));

beforeEach(() => {
  vi.mocked(mockTransport.getWorkingTreeDiff).mockReset();
  vi.mocked(mockTransport.readFileContent).mockReset();
  vi.mocked(mockTransport.readFileAtRef).mockReset();
});

vi.mock("@/hooks/useOpenInApps", () => ({
  useOpenInApps: () => [],
}));

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

const MENU_FILE: ReviewFileChange = {
  path: "apps/web/src/features/thread-actions/ThreadActionsMenu.tsx",
  previousPath: null,
  changeType: "modified",
  binary: false,
  additions: 4,
  deletions: 9,
  untracked: false,
};

const MENU_PATCH = `diff --git a/${MENU_FILE.path} b/${MENU_FILE.path}
index 1111111..2222222 100644
--- a/${MENU_FILE.path}
+++ b/${MENU_FILE.path}
@@ -1,2 +1,2 @@
 const groups = [];
-const gone = 1;
+const kept = 2;
`;

function renderReviewDiff(defaultFilesExpanded: boolean) {
  return render(
    <div style={{ height: 600, width: 536 }}>
      <ReviewDiffView
        files={[MENU_FILE]}
        source="unstaged"
        id="workspace-fixture"
        threadId="thread-fixture"
        defaultFilesExpanded={defaultFilesExpanded}
        jumpTarget={null}
        onJumpSettled={() => {}}
        highlightPath={null}
        renderMode="unified"
        lineWrap
      />
    </div>,
  );
}

describe("Review file header", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({ activeWorkspaceId: "workspace-fixture", threads: [] });
    useDiffStore.setState({ inlineDiffCache: {}, bulkDiffExpand: null });
    transport.getWorkingTreeDiff.mockResolvedValue(MENU_PATCH);
  });

  afterEach(cleanup);

  it("reads name first, then the whole folder, then deletions before additions", async () => {
    renderReviewDiff(false);

    const toggle = await screen.findByRole("button", { name: `Expand ${MENU_FILE.path}` });
    expect(toggle.textContent).toBe("ThreadActionsMenu.tsxapps/web/src/features/thread-actions-9+4");
  });

  it("shows counts but no file actions while collapsed", async () => {
    renderReviewDiff(false);

    const toggle = await screen.findByRole("button", { name: `Expand ${MENU_FILE.path}` });
    expect(screen.getByTestId("review-file-counts").textContent).toBe("-9+4");
    expect(toggle).toHaveAccessibleDescription("9 deletions, 4 additions");
    expect(screen.queryByRole("group", { name: "File actions" })).toBeNull();
  });

  it("shows file actions once the file is expanded", async () => {
    renderReviewDiff(false);

    await userEvent.click(await screen.findByRole("button", { name: `Expand ${MENU_FILE.path}` }));

    expect(await screen.findByRole("button", { name: `Collapse ${MENU_FILE.path}` })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Copy file path" })).toBeInTheDocument();
    expect(screen.getByTestId("review-file-counts").textContent).toBe("-9+4");
  });
});
