import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forwardRef, useImperativeHandle } from "react";
import { ReviewDiffView } from "@/components/diff/ReviewDiffView";
import { ReviewActiveFileContext } from "@/components/diff/useReviewScrollSpy";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";

const scrollTo = vi.hoisted(() => vi.fn());

// Observe the scroll the component asks pierre for; pierre's own layout needs a real browser.
vi.mock("@pierre/diffs/react", async (original) => ({
  ...(await original<object>()),
  CodeView: forwardRef(function CodeViewStub(_props, ref) {
    useImperativeHandle(ref, () => ({ scrollTo }));
    return null;
  }),
}));

vi.mock("@/transport", async (original) => ({
  ...(await original<object>()),
  getTransport: () => ({ getWorkingTreeDiff: vi.fn().mockResolvedValue("") }),
}));

const file = (path: string) => ({
  path,
  previousPath: null,
  changeType: "modified" as const,
  binary: false,
  additions: null,
  deletions: null,
  untracked: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceStore.setState({ activeWorkspaceId: "workspace-fixture", threads: [] });
  useDiffStore.setState({ inlineDiffCache: {}, bulkDiffExpand: null });
});

afterEach(cleanup);

describe("ReviewDiffView jump", () => {
  it("scrolls to the jump target, names it the active file, and settles the request", () => {
    const reports: string[] = [];
    const onJumpSettled = vi.fn();

    render(
      <ReviewActiveFileContext.Provider value={(path) => reports.push(path)}>
        <ReviewDiffView
          files={[file("a.ts"), file("b.ts")]}
          source="unstaged"
          id="workspace-fixture"
          threadId="thread-fixture"
          cacheVersion={1}
          defaultFilesExpanded={false}
          jumpTarget={{ path: "b.ts", token: 7 }}
          onJumpSettled={onJumpSettled}
          highlightPath={null}
          renderMode="unified"
          lineWrap
        />
      </ReviewActiveFileContext.Provider>,
    );

    expect(scrollTo).toHaveBeenCalledWith({ type: "item", id: "b.ts", align: "start", offset: -8 });
    expect(reports.at(-1)).toBe("b.ts");
    expect(onJumpSettled).toHaveBeenCalledWith(7);
  });
});
