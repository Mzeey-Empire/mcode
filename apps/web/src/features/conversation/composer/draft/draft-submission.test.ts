import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftBrowserNotePage } from "@mcode/contracts/models/next-message-draft";
import type { MessageMention } from "@mcode/contracts/models/mention";
import { mockTransport } from "@/__tests__/mocks/transport";
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
  removeBrowserNote,
  removeTakenBrowserNotes,
  saveBrowserNote,
  setBrowserPageSnapshot,
  saveDiffComment,
  saveFileComment,
  settleDraftSubmission,
  visibleBrowserNotePages,
  visibleDiffComments,
  visibleFileComments,
  type NextMessageDraft,
} from "./draft-submission";

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

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
  const confirmMessage = vi.mocked(mockTransport.confirmMessage);

  function pendingComments(): string[] {
    const draft = useComposerDraftStore.getState().drafts[THREAD_ID];
    return visibleDiffComments(draft ?? {}).map((comment) => comment.note);
  }

  function startSend(messageId = MESSAGE_ID) {
    saveDraftDiffComment(THREAD_ID, target, { note: "review note", mentions: [] });
    const comments = useComposerDraftStore.getState().drafts[THREAD_ID]!.diffComments!;
    return beginDraftSubmission(THREAD_ID, { browserNotePages: [], diffComments: comments, fileComments: [] }, messageId)!;
  }

  beforeEach(() => {
    useComposerDraftStore.setState({ drafts: {} });
    confirmMessage.mockReset();
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

describe("draft submissions with Browser notes", () => {
  const capture = {
    schemaVersion: 2 as const,
    pageUrl: "https://example.test/",
    pageTitle: "Home",
    capturedAt: "2026-05-08T12:00:00.000Z",
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  };
  const image = (stagingId: string) => ({ stagingId, name: "page.png", mimeType: "image/png", sizeBytes: 10 });

  function note(index: number, revision = 1) {
    return {
      id: `00000000-0000-4000-8000-00000000000${index}`,
      revision,
      pageIdentity: "https://example.test/",
      displayNumber: index,
      pageContext: capture,
      targetContext: { bounds: { x: 0, y: 0, width: 10, height: 10 } },
      note: `note ${index}`,
    };
  }

  function page(...notes: ReturnType<typeof note>[]): DraftBrowserNotePage {
    return {
      pageIdentity: "https://example.test/",
      url: "https://example.test/",
      title: "Home",
      faviconUrl: null,
      capture,
      scroll: { x: 0, y: 0 },
      cleanCapture: image("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      snapshot: image("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      notes,
    };
  }

  function freeze(draft: NextMessageDraft) {
    return freezeDraftSubmission(draft, MESSAGE_ID, readSendableDraftContent(draft));
  }

  it("holds only the snapshot staging id, never the clean capture, and hides the notes", () => {
    const frozen = freeze({ browserNotePages: [page(note(1), note(2))] });

    expect(frozen.submission.stagingIds).toEqual(["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]);
    expect(frozen.submission.elements.map((element) => element.field)).toEqual(["browserNotePages", "browserNotePages"]);
    expect(visibleBrowserNotePages(frozen.draft)).toEqual([]);
  });

  it("deletes sent notes on success and keeps a note edited during Send, renumbered, with a stale snapshot dropped", () => {
    const frozen = freeze({ browserNotePages: [page(note(1), note(2))] });
    const edited = {
      ...frozen.draft,
      browserNotePages: [page(note(1), note(2, 2))],
      submissions: frozen.draft.submissions,
    };

    const settled = settleDraftSubmission(edited, MESSAGE_ID, "success");

    expect(settled.browserNotePages).toHaveLength(1);
    expect(settled.browserNotePages![0]!.notes.map((n) => [n.note, n.revision, n.displayNumber])).toEqual([["note 2", 2, 1]]);
    expect(settled.browserNotePages![0]!.snapshot).toBeNull();
    expect(settled.submissions).toEqual([]);
  });

  it("removes a page whose notes were all sent", () => {
    const frozen = freeze({ browserNotePages: [page(note(1))] });

    expect(settleDraftSubmission(frozen.draft, MESSAGE_ID, "success").browserNotePages).toEqual([]);
  });

  it("returns the notes untouched on failure and keeps a valid snapshot", () => {
    const original = page(note(1), note(2));
    const frozen = freeze({ browserNotePages: [original] });

    const settled = settleDraftSubmission(frozen.draft, MESSAGE_ID, "failure");

    expect(settled.browserNotePages).toEqual([original]);
    expect(visibleBrowserNotePages(settled)).toEqual([original]);
  });

  it("drops the snapshot on failure when a note joined the page during Send", () => {
    const frozen = freeze({ browserNotePages: [page(note(1))] });
    const withLate = { ...frozen.draft, browserNotePages: [page(note(1), note(2))] };

    const settled = settleDraftSubmission(withLate, MESSAGE_ID, "failure");

    expect(settled.browserNotePages![0]!.snapshot).toBeNull();
    expect(visibleBrowserNotePages(settled)[0]!.notes.map((n) => n.displayNumber)).toEqual([1, 2]);
  });

  it("shows a note added to a page while its earlier notes are held", () => {
    const frozen = freeze({ browserNotePages: [page(note(1))] });
    const withLate = { ...frozen.draft, browserNotePages: [page(note(1), note(2))] };

    expect(visibleBrowserNotePages(withLate)[0]!.notes.map((n) => n.note)).toEqual(["note 2"]);
  });

  describe("editing", () => {
    const { snapshot: _snapshot, notes: _notes, ...pageCapture } = page();
    const empty: NextMessageDraft = {};
    const content = (text: string) => {
      const { id: _id, revision: _revision, displayNumber: _number, ...rest } = note(1);
      return { ...rest, note: text };
    };

    it("saves a first note at revision 1 and numbers later notes on the page in order", () => {
      const first = saveBrowserNote(empty, pageCapture, content("one"));
      const second = saveBrowserNote(first, pageCapture, content("two"));

      expect(second.browserNotePages).toHaveLength(1);
      expect(second.browserNotePages![0]!.notes.map((n) => [n.note, n.revision, n.displayNumber])).toEqual([
        ["one", 1, 1],
        ["two", 1, 2],
      ]);
    });

    it("bumps the revision when a note is edited and keeps its identity and number", () => {
      const first = saveBrowserNote(empty, pageCapture, content("one"));
      const [original] = first.browserNotePages![0]!.notes;

      const edited = saveBrowserNote(first, pageCapture, content("one, clearer"), original!.id);

      expect(edited.browserNotePages![0]!.notes).toEqual([
        expect.objectContaining({ id: original!.id, revision: 2, displayNumber: 1, note: "one, clearer" }),
      ]);
    });

    it("voids the page snapshot on every save", () => {
      const drawn = { browserNotePages: [page(note(1))] };

      expect(saveBrowserNote(drawn, pageCapture, content("again")).browserNotePages![0]!.snapshot).toBeNull();
    });

    it("moves the page just annotated to the end", () => {
      const other = { ...page(note(2)), pageIdentity: "https://example.test/billing" };
      const draft = { browserNotePages: [page(note(1)), other] };

      const saved = saveBrowserNote(draft, pageCapture, content("late"));

      expect(saved.browserNotePages!.map((p) => p.pageIdentity)).toEqual([
        "https://example.test/billing",
        "https://example.test/",
      ]);
    });

    it("removes a note, renumbers the rest, and voids that page's snapshot only", () => {
      const other = { ...page(note(2)), pageIdentity: "https://example.test/billing" };
      const draft = { browserNotePages: [page(note(1), note(2)), other] };

      const removed = removeBrowserNote(draft, note(1).id);

      expect(visibleBrowserNotePages(removed)[0]!.notes.map((n) => [n.note, n.displayNumber])).toEqual([["note 2", 1]]);
      expect(removed.browserNotePages![0]!.snapshot).toBeNull();
      expect(removed.browserNotePages![1]!.snapshot).not.toBeNull();
    });

    it("drops a page when its last note is removed", () => {
      expect(removeBrowserNote({ browserNotePages: [page(note(1))] }, note(1).id).browserNotePages).toEqual([]);
    });

    it("records a redrawn snapshot on its page only", () => {
      const other = { ...page(note(2)), pageIdentity: "https://example.test/billing", snapshot: null };
      const fresh = image("cccccccc-cccc-4ccc-8ccc-cccccccccccc");

      const updated = setBrowserPageSnapshot({ browserNotePages: [page(note(1)), other] }, other.pageIdentity, fresh);

      expect(updated.browserNotePages!.map((p) => p.snapshot?.stagingId)).toEqual([
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      ]);
    });
  });

  describe("taken by a queued message", () => {
    it("removes notes still at the revision the message took and renumbers the rest", () => {
      const draft = { browserNotePages: [page(note(1), note(2))] };

      const after = removeTakenBrowserNotes(draft, [{ id: note(1).id, revision: 1 }]);

      expect(after.browserNotePages![0]!.notes.map((n) => [n.note, n.displayNumber])).toEqual([["note 2", 1]]);
      expect(after.browserNotePages![0]!.snapshot).toBeNull();
    });

    it("keeps a note edited since, because the later revision is a new note", () => {
      const draft = { browserNotePages: [page(note(1, 2))] };

      const after = removeTakenBrowserNotes(draft, [{ id: note(1).id, revision: 1 }]);

      expect(after.browserNotePages![0]!.notes.map((n) => n.revision)).toEqual([2]);
    });

    it("leaves the draft as it was when nothing was taken", () => {
      const draft = { browserNotePages: [page(note(1))] };

      expect(removeTakenBrowserNotes(draft, [])).toBe(draft);
    });
  });
});
