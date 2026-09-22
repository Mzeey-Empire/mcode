import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENTS, type McodeBrowserCapture } from "@mcode/contracts";
import type { ComposerDraft } from "@/stores/composerDraftStore";
import type { PendingAttachment } from "@/components/chat/AttachmentPreview";
import {
  parseStoredComposerDraft,
  serializeComposerDraft,
} from "./composer-draft-storage";

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
});
