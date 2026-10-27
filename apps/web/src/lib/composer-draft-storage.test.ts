// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_ATTACHMENTS } from "@mcode/contracts/models/file-types";
import { type DraftBrowserNotePage, type DraftDiffComment, type DraftFileComment } from "@mcode/contracts/models/next-message-draft";
import { type McodeBrowserCapture } from "@mcode/contracts/models/browser-preview";
import { type MessageMention } from "@mcode/contracts/models/mention";
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

const fileComment: DraftFileComment = {
  kind: "file",
  id: "66666666-6666-4666-8666-666666666666",
  revision: 2,
  displayNumber: 2,
  filePath: "src/main.tsx",
  line: 7,
  lineContent: "render(<App />);",
  note: "@state.ts wrap this",
  mentions: [mention],
};

const pageCapture: McodeBrowserCapture = {
  schemaVersion: 2,
  pageUrl: "https://example.test/pricing",
  pageTitle: "Pricing",
  capturedAt: "2026-05-08T12:00:00.000Z",
  bounds: { x: 0, y: 0, width: 1280, height: 720 },
};

const browserNotePage: DraftBrowserNotePage = {
  pageIdentity: "https://example.test/pricing",
  url: "https://example.test/pricing",
  title: "Pricing",
  faviconUrl: null,
  capture: pageCapture,
  scroll: { x: 0, y: 240 },
  cleanCapture: {
    stagingId: "88888888-8888-4888-8888-888888888888",
    name: "pricing.png",
    mimeType: "image/png",
    sizeBytes: 2048,
  },
  snapshot: {
    stagingId: "99999999-9999-4999-8999-999999999999",
    name: "pricing-marked.png",
    mimeType: "image/png",
    sizeBytes: 4096,
  },
  notes: [{
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    revision: 2,
    pageIdentity: "https://example.test/pricing",
    displayNumber: 1,
    pageContext: pageCapture,
    targetContext: { label: "Buy button", bounds: { x: 10, y: 20, width: 100, height: 40 } },
    note: "Make this primary",
  }],
};

const nextMessageFields = {
  browserNotePages: [browserNotePage],
  diffComments: [diffComment],
  diffCommentEditor: {
    target: { filePath: "src/state.ts", side: "left" as const, line: 4, lineContent: "let x = 1;" },
    annotationId: diffComment.id,
    note: "@state.ts unsaved",
    mentions: [mention],
  },
  fileComments: [fileComment],
  fileCommentEditor: {
    target: { filePath: "src/main.tsx", line: 9, lineContent: "export {};" },
    annotationId: fileComment.id,
    note: "unsaved file note",
    mentions: [],
  },
  planCommentEditor: {
    planVersionId: "55555555-5555-4555-8555-555555555555",
    commentId: null,
    anchor: {
      kind: "text" as const,
      start: 6,
      end: 11,
      quote: "Alpha",
      prefix: "Step ",
      suffix: " beta",
      section: "Plan",
    },
    body: "unsaved 😀 note",
  },
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

  it("keeps the Fast choice of a draft saved before the fastMode rename", () => {
    const stored = JSON.parse(JSON.stringify(serializeComposerDraft(baseDraft)));
    expect(parseStoredComposerDraft({ ...stored, codexFastMode: true })?.fastMode).toBe(true);
    expect(parseStoredComposerDraft({ ...stored, codexFastMode: false })?.fastMode).toBe(false);
    expect(parseStoredComposerDraft({ ...stored, fastMode: false, codexFastMode: true })?.fastMode).toBe(false);
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
    expect(warn).toHaveBeenCalledWith("[composer-draft-storage] Dropped 3 invalid stored draft element(s)");
    warn.mockRestore();
  });

  it("drops an invalid stored Files comment or editor and keeps the valid one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stored = JSON.parse(JSON.stringify(serializeComposerDraft({ ...baseDraft, ...nextMessageFields })));
    stored.fileComments.push({ ...fileComment, id: "77777777-7777-4777-8777-777777777777", line: 0 });
    stored.fileCommentEditor = { ...stored.fileCommentEditor, target: { filePath: "", line: 1, lineContent: "" } };

    const restored = parseStoredComposerDraft(stored);

    expect(restored?.fileComments).toEqual([fileComment]);
    expect(restored?.fileCommentEditor).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[composer-draft-storage] Dropped 2 invalid stored draft element(s)");
    warn.mockRestore();
  });

  it("restores Browser note pages and drops a page whose notes are gone", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stored = JSON.parse(JSON.stringify(serializeComposerDraft({ ...baseDraft, ...nextMessageFields })));
    stored.browserNotePages.push({ ...browserNotePage, pageIdentity: "https://example.test/empty", notes: [] });

    const restored = parseStoredComposerDraft(stored);

    expect(restored?.browserNotePages).toEqual([browserNotePage]);
    expect(warn).toHaveBeenCalledWith("[composer-draft-storage] Dropped 1 invalid stored draft element(s)");
    warn.mockRestore();
  });

  it("drops a stored plan comment editor with a bad anchor or an over-long note and keeps the rest", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stored = JSON.parse(JSON.stringify(serializeComposerDraft({ ...baseDraft, ...nextMessageFields })));
    const editor = nextMessageFields.planCommentEditor;

    for (const bad of [
      { ...editor, anchor: { ...editor.anchor, end: 99 } },
      { ...editor, body: "x".repeat(4001) },
    ]) {
      const restored = parseStoredComposerDraft({ ...stored, planCommentEditor: bad });

      expect(restored?.planCommentEditor).toBeUndefined();
      expect(restored?.diffComments).toEqual([diffComment]);
      expect(warn).toHaveBeenLastCalledWith("[composer-draft-storage] Dropped 1 invalid stored draft element(s)");
    }
    warn.mockRestore();
  });

  it("counts a draft holding only comments, a plan selection or a plan comment editor as content", () => {
    const empty: ComposerDraft = { ...baseDraft, input: "" };

    expect(draftHasNoSendableContent(empty)).toBe(true);
    expect(draftHasNoSendableContent({ ...empty, planCommentEditor: nextMessageFields.planCommentEditor })).toBe(false);
    expect(draftHasNoSendableContent({ ...empty, diffComments: [diffComment] })).toBe(false);
    expect(draftHasNoSendableContent({ ...empty, fileComments: [fileComment] })).toBe(false);
    expect(draftHasNoSendableContent({ ...empty, browserNotePages: [browserNotePage] })).toBe(false);
    expect(draftHasNoSendableContent({ ...empty, fileCommentEditor: nextMessageFields.fileCommentEditor })).toBe(false);
    expect(draftHasNoSendableContent({ ...empty, submissions: nextMessageFields.submissions })).toBe(false);
  });
});

describe("persisted next-message drafts", () => {
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
