import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { useDiffStore } from "@/stores/diffStore";
import {
  numberDiffComments,
  readVisibleDiffComments,
  saveDraftDiffComment,
} from "./draft/draft-diff-comments";
import { DiffCommentsComposerAttachment } from "./DiffCommentsComposerAttachment";

const SCOPE = "thread-1";
const WORKSPACE = "workspace-1";

function seedComments(count = 2) {
  for (let index = 0; index < count; index++) {
    saveDraftDiffComment(SCOPE, {
      filePath: `src/file-${index}.ts`,
      side: "right",
      line: 10 + index,
      lineContent: `const value${index} = ${index};`,
    }, { note: `Note ${index}`, mentions: [] });
  }
}

function renderAttachment(commentCount = 2) {
  seedComments(commentCount);
  return renderStored();
}

function renderStored() {
  const comments = numberDiffComments(readVisibleDiffComments(SCOPE), 0);
  const onFocusComposer = vi.fn();
  render(
    <DiffCommentsComposerAttachment
      comments={comments}
      scopeId={SCOPE}
      workspaceId={WORKSPACE}
      threadId={SCOPE}
      onFocusComposer={onFocusComposer}
    />,
  );
  return { comments, onFocusComposer };
}

function openPreview() {
  fireEvent.click(
    screen.getByRole("button", { name: /comments?\. Preview available\./ }),
  );
}

describe("DiffCommentsComposerAttachment", () => {
  beforeEach(() => {
    localStorage.clear();
    useComposerDraftStore.setState({ drafts: {} });
    useDiffStore.setState({
      showRightPanel: vi.fn(),
      setRightPanelTab: vi.fn(),
      requestReviewFileJump: vi.fn(),
    });
  });

  it("renders the count pill and a spaced preview card per comment", () => {
    renderAttachment(2);
    expect(screen.getByTestId("diff-comment-chip")).toHaveTextContent("2 comments");

    openPreview();

    const preview = screen.getByTestId("diff-comment-preview");
    expect(preview).toHaveTextContent("1. src/file-0.ts:10:");
    expect(preview).toHaveTextContent("const value0 = 0;");
    expect(preview).toHaveTextContent("Note 0");
    expect(preview).toHaveTextContent("2. src/file-1.ts:11:");
    expect(preview).toHaveTextContent("Note 1");
  });

  it("opens the Review surface jumped to the comment file", () => {
    renderAttachment(1);
    openPreview();

    fireEvent.click(screen.getByRole("button", { name: "Open source for comment 1" }));

    const state = useDiffStore.getState();
    expect(state.showRightPanel).toHaveBeenCalledWith(WORKSPACE, SCOPE);
    expect(state.setRightPanelTab).toHaveBeenCalledWith(WORKSPACE, SCOPE, "changes");
    expect(state.requestReviewFileJump).toHaveBeenCalledWith(SCOPE, "src/file-0.ts");
  });

  it("removes every diff comment from the store via the chip dismiss", () => {
    renderAttachment(2);

    fireEvent.click(screen.getByRole("button", { name: "Remove 2 comments" }));

    expect(useComposerDraftStore.getState().drafts[SCOPE]).toBeUndefined();
  });

  it("deletes a single comment from its card without touching the others", () => {
    renderAttachment(2);
    openPreview();

    fireEvent.pointerEnter(screen.getByTestId("diff-comment-preview-item-1"));
    fireEvent.click(screen.getByRole("button", { name: "Delete comment 1" }));

    const remaining = useComposerDraftStore.getState().drafts[SCOPE]?.diffComments;
    expect(remaining).toHaveLength(1);
    expect(remaining?.[0]?.filePath).toBe("src/file-1.ts");
  });

  it("restores saved comments in the chip after a reload", async () => {
    seedComments(2);
    const stored = localStorage.getItem("mcode-composer-drafts");
    useComposerDraftStore.setState({ drafts: {} });
    localStorage.setItem("mcode-composer-drafts", stored!);

    await useComposerDraftStore.persist.rehydrate();
    renderStored();

    expect(screen.getByTestId("diff-comment-chip")).toHaveTextContent("2 comments");
    openPreview();
    expect(screen.getByTestId("diff-comment-preview")).toHaveTextContent("Note 0");
    expect(screen.getByTestId("diff-comment-preview")).toHaveTextContent("Note 1");
  });
});
