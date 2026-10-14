import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageMention } from "@mcode/contracts";
import { getTransport } from "@/transport";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import {
  editDraftDiffComment,
  removeTakenDiffComments,
  saveDraftDiffComment,
  setDraftDiffCommentEditor,
} from "./draft-diff-comments";
import { saveDraftFileComment } from "./draft-file-comments";
import { beginDraftSubmission, reconcileOrphanedDraftSubmissions } from "./draft-submission-lifecycle";
import {
  freezeDraftSubmission,
  readSendableDraftContent,
  reconcilePendingSubmissions,
  saveDiffComment,
  saveFileComment,
  settleDraftSubmission,
  visibleDiffComments,
  visibleFileComments,
  type NextMessageDraft,
} from "./draft-submission";

vi.mock("@/transport", () => ({ getTransport: vi.fn() }));

const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
const target = { filePath: "src/state.ts", side: "right" as const, line: 11, lineContent: "const state = next;" };
const fileMention: MessageMention = {
  kind: "file",
  id: "file-1",
  label: "state.ts",
  path: "src/state.ts",
  range: { start: 0, end: 9 },
};

function draftWithComments(...notes: string[]): NextMessageDraft {
  return notes.reduce<NextMessageDraft>(
    (draft, note) => saveDiffComment(draft, target, { note, mentions: [] }),
    {},
  );
}

function send(draft: NextMessageDraft): { draft: NextMessageDraft; sentNotes: string[] } {
  const content = readSendableDraftContent(draft);
  const frozen = freezeDraftSubmission(draft, MESSAGE_ID, content);
  return { draft: frozen.draft, sentNotes: content.diffComments.map((comment) => comment.note) };
}

const fileTarget = { filePath: "src/main.tsx", line: 7, lineContent: "render(<App />);" };

describe("draft submissions with Files comments", () => {
  function draftWithFileComments(...notes: string[]): NextMessageDraft {
    return notes.reduce<NextMessageDraft>(
      (draft, note) => saveFileComment(draft, fileTarget, { note, mentions: [] }),
      saveDiffComment({}, target, { note: "review", mentions: [] }),
    );
  }

  it("freezes Files comments with Review comments and hides both while Send is pending", () => {
    const draft = draftWithFileComments("first");
    const frozen = freezeDraftSubmission(draft, MESSAGE_ID, readSendableDraftContent(draft));

    expect(frozen.submission.elements.map((element) => element.field)).toEqual(["diffComments", "fileComments"]);
    expect(visibleFileComments(frozen.draft)).toEqual([]);
    expect(visibleDiffComments(frozen.draft)).toEqual([]);
    expect(frozen.draft.fileComments?.map((comment) => comment.note)).toEqual(["first"]);
  });

  it("deletes sent Files comments on success and keeps a revision edited during Send", () => {
    const draft = draftWithFileComments("unchanged", "to edit");
    const frozen = freezeDraftSubmission(draft, MESSAGE_ID, readSendableDraftContent(draft)).draft;
    const editId = frozen.fileComments![1]!.id;
    const edited = saveFileComment(frozen, fileTarget, { note: "edited", mentions: [] }, editId);

    const settled = settleDraftSubmission(edited, MESSAGE_ID, "success");

    expect(settled.fileComments?.map((comment) => [comment.note, comment.revision])).toEqual([["edited", 2]]);
    expect(settled.diffComments).toEqual([]);
  });

  it("returns Files comments after a failed Send", () => {
    const draft = draftWithFileComments("first", "second");
    const frozen = freezeDraftSubmission(draft, MESSAGE_ID, readSendableDraftContent(draft)).draft;

    const settled = settleDraftSubmission(frozen, MESSAGE_ID, "failure");

    expect(visibleFileComments(settled)).toEqual(draft.fileComments);
  });
});

describe("draft submissions", () => {
  it("hides submitted comments while Send is pending and leaves them in the draft", () => {
    const { draft, sentNotes } = send(draftWithComments("first", "second"));

    expect(sentNotes).toEqual(["first", "second"]);
    expect(visibleDiffComments(draft)).toEqual([]);
    expect(draft.diffComments?.map((comment) => comment.note)).toEqual(["first", "second"]);
  });

  it("keeps an edit made during Send after success, and the message keeps the text at Send", () => {
    const sent = send(draftWithComments("at send"));
    const id = sent.draft.diffComments![0]!.id;
    const edited = saveDiffComment(sent.draft, target, { note: "edited during send", mentions: [] }, id);

    const settled = settleDraftSubmission(edited, MESSAGE_ID, "success");

    expect(sent.sentNotes).toEqual(["at send"]);
    expect(settled.diffComments?.map((comment) => [comment.note, comment.revision])).toEqual([
      ["edited during send", 2],
    ]);
    expect(settled.submissions).toEqual([]);
  });

  it("keeps an edit made during Send after failure", () => {
    const sent = send(draftWithComments("at send"));
    const id = sent.draft.diffComments![0]!.id;
    const edited = saveDiffComment(sent.draft, target, { note: "edited during send", mentions: [] }, id);

    const settled = settleDraftSubmission(edited, MESSAGE_ID, "failure");

    expect(visibleDiffComments(settled).map((comment) => comment.note)).toEqual(["edited during send"]);
  });

  it("keeps a comment added while Send is pending after success", () => {
    const sent = send(draftWithComments("sent"));
    const added = saveDiffComment(sent.draft, target, { note: "added during send", mentions: [] });

    const settled = settleDraftSubmission(added, MESSAGE_ID, "success");

    expect(settled.diffComments?.map((comment) => comment.note)).toEqual(["added during send"]);
  });

  it("returns every element unchanged after a failed Send", () => {
    const before = draftWithComments("first", "second");
    const settled = settleDraftSubmission(send(before).draft, MESSAGE_ID, "failure");

    expect(visibleDiffComments(settled)).toEqual(before.diffComments);
  });

  it("applies success when a lost response's message is on the thread", () => {
    const sent = send(draftWithComments("unchanged", "to edit"));
    const editId = sent.draft.diffComments![1]!.id;
    const edited = saveDiffComment(sent.draft, target, { note: "edited", mentions: [] }, editId);

    const settled = reconcilePendingSubmissions(edited, () => false, (id) => id === MESSAGE_ID);

    expect(settled.diffComments?.map((comment) => comment.note)).toEqual(["edited"]);
    expect(settled.submissions).toEqual([]);
  });

  it("after a restart applies success when the thread holds the message and failure when it does not", () => {
    const pending = send(draftWithComments("first", "second")).draft;
    const stored = JSON.parse(JSON.stringify(pending)) as NextMessageDraft;

    const admitted = reconcilePendingSubmissions(stored, () => false, () => true);
    const lost = reconcilePendingSubmissions(stored, () => false, () => false);

    expect(admitted.diffComments).toEqual([]);
    expect(visibleDiffComments(lost).map((comment) => comment.note)).toEqual(["first", "second"]);
  });

  it("leaves a submission this window still has in flight", () => {
    const pending = send(draftWithComments("first")).draft;

    expect(reconcilePendingSubmissions(pending, () => true, () => false)).toBe(pending);
  });

  it("writes a new revision for every change and keeps mentions", () => {
    const saved = saveDiffComment<NextMessageDraft>({}, target, { note: "@state.ts check", mentions: [fileMention] });
    const id = saved.diffComments![0]!.id;
    const edited = saveDiffComment(saved, target, { note: "@state.ts check again", mentions: [fileMention] }, id);

    expect(edited.diffComments).toEqual([
      expect.objectContaining({ id, revision: 2, note: "@state.ts check again", mentions: [fileMention] }),
    ]);
  });
});

describe("settling with an open editor", () => {
  it("keeps an unsaved edit of a sent comment as a new comment", () => {
    const sent = send(draftWithComments("sent"));
    const id = sent.draft.diffComments![0]!.id;
    const editing = { ...sent.draft, diffCommentEditor: { annotationId: id, note: "unsaved edit" } };

    const settled = settleDraftSubmission(editing, MESSAGE_ID, "success");

    expect(settled.diffComments).toEqual([]);
    expect(settled.diffCommentEditor).toEqual({ annotationId: undefined, note: "unsaved edit" });
  });
});

describe("draft submission lifecycle", () => {
  const THREAD_ID = "thread-lifecycle";
  const confirmMessage = vi.fn();

  function pendingComments(): string[] {
    const draft = useComposerDraftStore.getState().drafts[THREAD_ID];
    return visibleDiffComments(draft ?? {}).map((comment) => comment.note);
  }

  function startSend(messageId = MESSAGE_ID) {
    saveDraftDiffComment(THREAD_ID, target, { note: "review note", mentions: [] });
    const comments = useComposerDraftStore.getState().drafts[THREAD_ID]!.diffComments!;
    return beginDraftSubmission(THREAD_ID, { diffComments: comments, fileComments: [] }, messageId)!;
  }

  beforeEach(() => {
    useComposerDraftStore.setState({ drafts: {} });
    confirmMessage.mockReset();
    vi.mocked(getTransport).mockReturnValue({ confirmMessage } as unknown as ReturnType<typeof getTransport>);
  });

  it("freezes a Send that carries only Files comments and deletes them once it succeeds", () => {
    saveDraftFileComment(THREAD_ID, fileTarget, { note: "file note", mentions: [] });
    const content = readSendableDraftContent(useComposerDraftStore.getState().drafts[THREAD_ID]!);

    const handle = beginDraftSubmission(THREAD_ID, content, MESSAGE_ID);

    expect(handle).not.toBeNull();
    expect(visibleFileComments(useComposerDraftStore.getState().drafts[THREAD_ID]!)).toEqual([]);
    handle!.succeeded();
    expect(useComposerDraftStore.getState().drafts[THREAD_ID]).toBeUndefined();
  });

  it("keeps the submission pending when a failed Send cannot be confirmed, then settles it after reconnect", async () => {
    vi.useFakeTimers();
    const handle = startSend();
    confirmMessage.mockRejectedValueOnce(new Error("socket closed"));

    await handle.failed();
    vi.clearAllTimers();
    vi.useRealTimers();

    expect(pendingComments()).toEqual([]);
    expect(useComposerDraftStore.getState().drafts[THREAD_ID]?.submissions).toHaveLength(1);

    confirmMessage.mockResolvedValueOnce({ admitted: true });
    await reconcileOrphanedDraftSubmissions(THREAD_ID);

    expect(useComposerDraftStore.getState().drafts[THREAD_ID]).toBeUndefined();
  });

  /** Leaves a pending submission no live Send owns, as a restart does. */
  async function orphanSend(): Promise<void> {
    vi.useFakeTimers();
    const handle = startSend();
    confirmMessage.mockRejectedValueOnce(new Error("offline"));
    await handle.failed();
    // Drop the scheduled confirmation retries; each test drives reconcile itself.
    vi.clearAllTimers();
    vi.useRealTimers();
    confirmMessage.mockReset();
  }

  it("waits for the server's answer on a Send it was still admitting, so a late commit is not sent twice", async () => {
    const handle = startSend();
    let answer!: (result: { admitted: boolean }) => void;
    confirmMessage.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));

    const failing = handle.failed();
    expect(useComposerDraftStore.getState().drafts[THREAD_ID]?.submissions).toHaveLength(1);
    answer({ admitted: true });
    await failing;

    expect(confirmMessage).toHaveBeenCalledWith(THREAD_ID, MESSAGE_ID);
    expect(useComposerDraftStore.getState().drafts[THREAD_ID]).toBeUndefined();
  });

  it("returns every element when the server confirms the message was never admitted", async () => {
    await orphanSend();
    confirmMessage.mockResolvedValueOnce({ admitted: false });

    await reconcileOrphanedDraftSubmissions(THREAD_ID);

    expect(pendingComments()).toEqual(["review note"]);
  });

  it("retries confirmation while the connection stays up", async () => {
    vi.useFakeTimers();
    try {
      const handle = startSend();
      confirmMessage.mockRejectedValueOnce(new Error("timeout"));
      await handle.failed();
      confirmMessage.mockResolvedValueOnce({ admitted: true });

      await vi.advanceTimersByTimeAsync(5_000);

      expect(useComposerDraftStore.getState().drafts[THREAD_ID]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a restored submission whose first confirmation read fails", async () => {
    await orphanSend();
    vi.useFakeTimers();
    try {
      confirmMessage.mockRejectedValueOnce(new Error("timeout"));
      await reconcileOrphanedDraftSubmissions(THREAD_ID);
      confirmMessage.mockResolvedValueOnce({ admitted: true });

      await vi.advanceTimersByTimeAsync(5_000);

      expect(useComposerDraftStore.getState().drafts[THREAD_ID]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an unsaved edit as a new comment when a queued message takes the comment", () => {
    saveDraftDiffComment(THREAD_ID, target, { note: "queued", mentions: [] });
    const taken = useComposerDraftStore.getState().drafts[THREAD_ID]!.diffComments!;
    editDraftDiffComment(THREAD_ID, taken[0]!);
    setDraftDiffCommentEditor(THREAD_ID, {
      ...useComposerDraftStore.getState().drafts[THREAD_ID]!.diffCommentEditor!,
      note: "unsaved edit",
    });

    removeTakenDiffComments(THREAD_ID, taken);

    const draft = useComposerDraftStore.getState().drafts[THREAD_ID];
    expect(draft?.diffComments).toEqual([]);
    expect(draft?.diffCommentEditor).toMatchObject({ annotationId: undefined, note: "unsaved edit" });
  });

  it("keeps an open editor while settling", () => {
    const handle = startSend();
    setDraftDiffCommentEditor(THREAD_ID, { target, note: "next thought", mentions: [] });

    handle.succeeded();

    expect(useComposerDraftStore.getState().drafts[THREAD_ID]?.diffCommentEditor?.note).toBe("next thought");
  });
});
