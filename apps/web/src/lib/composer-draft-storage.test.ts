import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ATTACHMENTS,
  type DraftDiffComment,
  type McodeBrowserCapture,
  type MessageMention,
} from "@mcode/contracts";
import { draftHasNoSendableContent, useComposerDraftStore, type ComposerDraft } from "@/stores/composerDraftStore";
import type { PendingAttachment } from "@/components/chat/AttachmentPreview";
import {
  composerDraftStorage,
  parseStoredComposerDraft,
  serializeComposerDraft,
  useDraftWriteFailureStore,
} from "./composer-draft-storage";

const mention: MessageMention = {
  kind: "file",
  id: "file-1",
  label: "state.ts",
  path: "src/state.ts",
  range: { start: 0, end: 9 },
};

const diffComment: DraftDiffComment = {
  kind: "diff",
  id: "22222222-2222-4222-8222-222222222222",
  revision: 3,
  displayNumber: 1,
  filePath: "src/state.ts",
  side: "right",
  line: 11,
  lineContent: "const state = next;",
  note: "@state.ts keep this immutable",
  mentions: [mention],
};

const nextMessageFields = {
  diffComments: [diffComment],
  diffCommentEditor: {
    target: { filePath: "src/state.ts", side: "left" as const, line: 4, lineContent: "let x = 1;" },
    annotationId: diffComment.id,
    note: "@state.ts unsaved",
    mentions: [mention],
  },
  planCommentSelection: { planVersionId: "plan-v1", includedIds: ["a"], excludedIds: ["b"], revision: 2 },
  submissions: [{
    messageId: "33333333-3333-4333-8333-333333333333",
    elements: [{ field: "diffComments" as const, id: diffComment.id, revision: 2 }],
    stagingIds: ["44444444-4444-4444-8444-444444444444"],
  }],
};

const baseDraft: ComposerDraft = {
  input: "hello",
  attachments: [],
  modelId: "gpt-5.5",
  provider: "codex",
  reasoning: "high",
};

function attachment(overrides: Partial<PendingAttachment> = {}): PendingAttachment {
  return {
    id: "a1",
    name: "shot.png",
    mimeType: "image/png",
    sizeBytes: 10,
    previewUrl: "blob:ephemeral",
    filePath: "C:/tmp/shot.png",
    ...overrides,
  };
}

function roundTrip(draft: ComposerDraft): ComposerDraft | null {
  return parseStoredComposerDraft(
    JSON.parse(JSON.stringify(serializeComposerDraft(draft))),
  );
}

describe("composer-draft-storage", () => {
  it("round-trips a draft with durable attachment paths but dead preview URLs", () => {
    const restored = roundTrip({
      ...baseDraft,
      attachments: [attachment()],
    });
    expect(restored).toMatchObject({
      input: "hello",
      modelId: "gpt-5.5",
      provider: "codex",
      reasoning: "high",
      attachments: [
        {
          id: "a1",
          name: "shot.png",
          previewUrl: "",
          filePath: "C:/tmp/shot.png",
        },
      ],
    });
  });

  it("keeps a safe relative capture spill path and drops escape attempts", () => {
    const capture = (spillAppDataPath: unknown) =>
      ({
        schemaVersion: 2,
        spillAppDataPath,
        spillAbsolutePath: "C:/abs/leak.png",
      }) as unknown as McodeBrowserCapture;
    const restoredSpillPath = (path: unknown) => {
      const restored = roundTrip({
        ...baseDraft,
        attachments: [attachment({ browserCapture: capture(path) })],
      });
      const restoredCapture = restored?.attachments[0]?.browserCapture;
      return restoredCapture?.schemaVersion === 2
        ? restoredCapture.spillAppDataPath
        : undefined;
    };

    const safe = roundTrip({
      ...baseDraft,
      attachments: [attachment({ browserCapture: capture("spill/shot.png") })],
    });
    expect(safe?.attachments[0]?.browserCapture).toMatchObject({
      spillAppDataPath: "spill/shot.png",
    });
    expect(
      (safe?.attachments[0]?.browserCapture as { spillAbsolutePath?: string })
        ?.spillAbsolutePath,
    ).toBeUndefined();

    for (const hostile of ["../escape.png", "C:/abs.png", "/abs.png", "a\\b.png"]) {
      expect(restoredSpillPath(hostile)).toBeUndefined();
    }
  });

  it("rejects payloads that are not drafts", () => {
    expect(parseStoredComposerDraft(null)).toBeNull();
    expect(parseStoredComposerDraft("draft")).toBeNull();
    expect(parseStoredComposerDraft({ input: 42 })).toBeNull();
    expect(
      parseStoredComposerDraft({ input: "x", attachments: "nope", modelId: "m" }),
    ).toBeNull();
    expect(
      parseStoredComposerDraft({ input: "x", attachments: [], modelId: 7 }),
    ).toBeNull();
    expect(
      parseStoredComposerDraft({
        input: "x".repeat(1_000_001),
        attachments: [],
        modelId: "m",
      }),
    ).toBeNull();
  });

  it("drops malformed attachments and caps the tray", () => {
    const restored = parseStoredComposerDraft({
      input: "x",
      attachments: [
        null,
        { id: "bad" },
        ...Array.from({ length: MAX_ATTACHMENTS + 3 }, (_, i) => ({
          id: `a${i}`,
          name: `f${i}.png`,
          mimeType: "image/png",
          sizeBytes: 1,
        })),
      ],
      modelId: "m",
    });
    expect(restored?.attachments).toHaveLength(MAX_ATTACHMENTS);
  });

  it("round-trips every next-message field through JSON", () => {
    const restored = roundTrip({ ...baseDraft, ...nextMessageFields });

    expect(restored).toMatchObject(nextMessageFields);
  });

  it("drops a stored element that fails its schema, logs the count, and restores the rest", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stored = JSON.parse(JSON.stringify(serializeComposerDraft({ ...baseDraft, ...nextMessageFields })));
    stored.diffComments.push({ ...diffComment, id: "not-a-uuid" }, { ...diffComment, note: "" });
    stored.submissions.push({ messageId: "nope", elements: [], stagingIds: [] });

    const restored = parseStoredComposerDraft(stored);

    expect(restored?.input).toBe("hello");
    expect(restored?.diffComments).toEqual([diffComment]);
    expect(restored?.submissions).toEqual(nextMessageFields.submissions);
    expect(restored?.planCommentSelection).toEqual(nextMessageFields.planCommentSelection);
    expect(warn).toHaveBeenCalledWith("[composer-draft-storage] Dropped 3 invalid stored draft element(s)");
    warn.mockRestore();
  });

  it("counts a draft holding only comments or only a plan selection as content", () => {
    const empty: ComposerDraft = { ...baseDraft, input: "" };

    expect(draftHasNoSendableContent(empty)).toBe(true);
    expect(draftHasNoSendableContent({ ...empty, diffComments: [diffComment] })).toBe(false);
    expect(draftHasNoSendableContent({ ...empty, planCommentSelection: nextMessageFields.planCommentSelection })).toBe(false);
    expect(draftHasNoSendableContent({ ...empty, submissions: nextMessageFields.submissions })).toBe(false);
  });
});

describe("persisted next-message drafts", () => {
  it("moves next-message fields with a draft transferred to a new thread", () => {
    useComposerDraftStore.setState({ drafts: {} });
    useComposerDraftStore.getState().updateNextMessage("placeholder", (draft) => ({
      ...draft,
      diffComments: [diffComment],
    }));
    const moved = useComposerDraftStore.getState().getDraft("placeholder")!;

    useComposerDraftStore.getState().saveDraft("real-thread", { ...moved, input: "first message" });

    expect(useComposerDraftStore.getState().drafts["real-thread"]?.diffComments).toEqual([diffComment]);
  });

  it("keeps stored next-message fields over a composer snapshot without them", () => {
    useComposerDraftStore.setState({ drafts: {} });
    useComposerDraftStore.getState().updateNextMessage("thread-a", (draft) => ({
      ...draft,
      diffComments: [diffComment],
    }));

    useComposerDraftStore.getState().saveDraft("thread-a", { ...baseDraft, input: "typed" });

    expect(useComposerDraftStore.getState().drafts["thread-a"]).toMatchObject({
      input: "typed",
      diffComments: [diffComment],
    });
  });

  it("restores a draft holding only a plan-comment selection after a reload", async () => {
    localStorage.clear();
    useComposerDraftStore.setState({ drafts: {} });
    useComposerDraftStore.getState().updateNextMessage("thread-plan", (draft) => ({
      ...draft,
      planCommentSelection: nextMessageFields.planCommentSelection,
    }));
    const stored = localStorage.getItem("mcode-composer-drafts");
    useComposerDraftStore.setState({ drafts: {} });
    localStorage.setItem("mcode-composer-drafts", stored!);

    await useComposerDraftStore.persist.rehydrate();

    expect(useComposerDraftStore.getState().drafts["thread-plan"]?.planCommentSelection)
      .toEqual(nextMessageFields.planCommentSelection);
  });
});

describe("composer draft write failures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useDraftWriteFailureStore.setState({ failure: null });
  });

  it("records a quota error without throwing and clears it on the next successful write", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
      throw new DOMException("full", "QuotaExceededError");
    });

    expect(() => composerDraftStorage.setItem("drafts", "{}")).not.toThrow();
    expect(useDraftWriteFailureStore.getState().failure).toBe("storage-full");

    composerDraftStorage.setItem("drafts", "{}");

    expect(setItem).toHaveBeenCalledTimes(2);
    expect(useDraftWriteFailureStore.getState().failure).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
