import type { PendingAttachment } from "@/components/chat/AttachmentPreview";
import type { McodeBrowserCapture, SelectedTextComment } from "@mcode/contracts";
import {
  MAX_ATTACHMENTS,
  MessageMentionsSchema,
  SelectedTextCommentSchema,
} from "@mcode/contracts";
import type {
  ComposerDraft,
  SelectedTextCommentEditorDraft,
} from "@/stores/composerDraftStore";

/**
 * Persisted drafts cross restarts as JSON, so blob preview URLs are dead weight
 * on write and the whole payload must be treated as untrusted on read. These
 * helpers are the only boundary between localStorage and live draft state.
 */

const MAX_DRAFT_INPUT_CHARS = 1_000_000;

/** Oversized drafts stay in memory; persisting them would be dropped on read anyway. */
export function canPersistComposerDraft(draft: ComposerDraft): boolean {
  return draft.input.length <= MAX_DRAFT_INPUT_CHARS;
}

type StoredPendingAttachment = Omit<PendingAttachment, "previewUrl">;

/** Draft shape written to storage; attachments keep durable fields only. */
export interface SerializedComposerDraft extends Omit<ComposerDraft, "attachments"> {
  attachments: StoredPendingAttachment[];
}

/** Drops the ephemeral object URL; the durable parts are `filePath` and capture metadata. */
export function serializePendingAttachment(
  attachment: PendingAttachment,
): StoredPendingAttachment {
  const { previewUrl: _previewUrl, ...rest } = attachment;
  return rest;
}

/** Serializes one draft for storage; attachment preview URLs are not durable. */
export function serializeComposerDraft(draft: ComposerDraft): SerializedComposerDraft {
  return {
    ...draft,
    attachments: draft.attachments.map(serializePendingAttachment),
  };
}

/**
 * A relative spill path is only safe to carry forward (and later release) when
 * it cannot escape the app-data spill directory.
 */
function isSafeSpillPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 512) {
    return false;
  }
  if (path.includes("..") || path.includes("\\") || path.includes("\0")) {
    return false;
  }
  return !path.startsWith("/") && !/^[a-zA-Z]:/.test(path);
}

function sanitizeBrowserCapture(raw: unknown): McodeBrowserCapture | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const capture = raw as McodeBrowserCapture;
  if (capture.schemaVersion === 2) {
    return {
      ...capture,
      spillAppDataPath: isSafeSpillPath(capture.spillAppDataPath)
        ? capture.spillAppDataPath
        : undefined,
      spillAbsolutePath: undefined,
    };
  }
  return capture;
}

/** Rebuilds a pending attachment from stored metadata; preview renders as a file tile. */
export function parseStoredPendingAttachment(raw: unknown): PendingAttachment | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<PendingAttachment>;
  if (
    typeof candidate.id !== "string"
    || typeof candidate.name !== "string"
    || typeof candidate.mimeType !== "string"
    || typeof candidate.sizeBytes !== "number"
  ) {
    return null;
  }
  const filePath = candidate.filePath;
  return {
    id: candidate.id,
    name: candidate.name,
    mimeType: candidate.mimeType,
    sizeBytes: candidate.sizeBytes,
    previewUrl: "",
    filePath: typeof filePath === "string" && filePath.length > 0 ? filePath : null,
    browserCapture: sanitizeBrowserCapture(candidate.browserCapture),
    contextOnly: candidate.contextOnly === true ? true : undefined,
  };
}

/** Elements that fail the contract schema are dropped, not trusted. */
function parseStoredComments(raw: unknown): SelectedTextComment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .map((comment) => SelectedTextCommentSchema().safeParse(comment))
    .filter((result) => result.success)
    .map((result) => result.data);
}

function parseStoredCommentEditor(
  raw: unknown,
): SelectedTextCommentEditorDraft | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const editor = raw as Partial<SelectedTextCommentEditorDraft>;
  if (!editor.source || typeof editor.note !== "string" || !Array.isArray(editor.mentions)) {
    return undefined;
  }
  const mentions = MessageMentionsSchema().safeParse(editor.mentions);
  if (!mentions.success) return undefined;
  return { ...editor, mentions: mentions.data } as SelectedTextCommentEditorDraft;
}

/** Validates a stored draft; returns null when the shape cannot be trusted. */
export function parseStoredComposerDraft(raw: unknown): ComposerDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<ComposerDraft>;
  if (
    typeof candidate.input !== "string"
    || candidate.input.length > MAX_DRAFT_INPUT_CHARS
    || typeof candidate.modelId !== "string"
    || !Array.isArray(candidate.attachments)
  ) {
    return null;
  }
  const attachments = candidate.attachments
    .map(parseStoredPendingAttachment)
    .filter((attachment): attachment is PendingAttachment => attachment !== null)
    .slice(0, MAX_ATTACHMENTS);
  const mentions = MessageMentionsSchema().safeParse(candidate.mentions);
  return {
    input: candidate.input,
    mentions: mentions.success ? mentions.data : undefined,
    selectedTextComments: parseStoredComments(candidate.selectedTextComments),
    selectedTextCommentEditor: parseStoredCommentEditor(
      candidate.selectedTextCommentEditor,
    ),
    attachments,
    modelId: candidate.modelId,
    provider: typeof candidate.provider === "string" ? candidate.provider : undefined,
    reasoning: candidate.reasoning as ComposerDraft["reasoning"],
    contextWindow: candidate.contextWindow,
    codexFastMode: candidate.codexFastMode,
    devinMode: candidate.devinMode,
  };
}

/**
 * localStorage writes can fail on quota; a failed draft write must never take
 * down the composer. Reads return null so Zustand treats it as "no state".
 */
export const composerDraftStorage = {
  getItem: (name: string): string | null => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name: string, value: string): void => {
    try {
      localStorage.setItem(name, value);
    } catch {
      // Quota exceeded or storage disabled: drafts stay in memory only.
    }
  },
  removeItem: (name: string): void => {
    try {
      localStorage.removeItem(name);
    } catch {
      // Same as above.
    }
  },
};
