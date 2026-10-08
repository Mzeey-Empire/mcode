import { create } from "zustand";
import type { PendingAttachment } from "@/components/chat/AttachmentPreview";
import type {
  DraftDiffComment,
  DraftSubmission,
  McodeBrowserCapture,
  PlanCommentSelection,
  SelectedTextComment,
} from "@mcode/contracts";
import {
  DiffAnnotationPayloadSchema,
  DraftDiffCommentSchema,
  DraftSubmissionSchema,
  MAX_ATTACHMENTS,
  MessageMentionsSchema,
  PlanCommentSelectionSchema,
  SelectedTextCommentSchema,
} from "@mcode/contracts";
import type {
  ComposerDraft,
  DiffCommentEditorDraft,
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

/** The slice of a contracts schema the parser needs. */
interface ElementSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/** Counts stored elements a parse dropped, so one log line reports them per draft. */
interface DropCounter {
  dropped: number;
}

function parseStoredElements<T>(
  raw: unknown,
  schema: ElementSchema<T>,
  counter: DropCounter,
): T[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    counter.dropped += 1;
    return undefined;
  }
  const parsed: T[] = [];
  for (const element of raw) {
    const result = schema.safeParse(element);
    if (result.success) parsed.push(result.data);
    else counter.dropped += 1;
  }
  return parsed;
}

function parseStoredElement<T>(raw: unknown, schema: ElementSchema<T>, counter: DropCounter): T | undefined {
  if (raw === undefined) return undefined;
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  counter.dropped += 1;
  return undefined;
}

function parseStoredDiffCommentEditor(
  raw: unknown,
  counter: DropCounter,
): DiffCommentEditorDraft | undefined {
  if (raw === undefined) return undefined;
  const editor = raw as Partial<DiffCommentEditorDraft> | null;
  const target = DiffAnnotationPayloadSchema().safeParse({
    kind: "diff",
    id: crypto.randomUUID(),
    displayNumber: 1,
    ...editor?.target,
    note: "target",
  });
  const mentions = MessageMentionsSchema().safeParse(editor?.mentions);
  if (!target.success || !mentions.success || typeof editor?.note !== "string"
    || (editor.annotationId !== undefined && typeof editor.annotationId !== "string")) {
    counter.dropped += 1;
    return undefined;
  }
  const { filePath, side, line, lineContent } = target.data;
  return {
    target: { filePath, side, line, lineContent },
    annotationId: editor.annotationId,
    note: editor.note,
    mentions: mentions.data,
  };
}

function parseStoredNextMessageFields(candidate: Partial<ComposerDraft>): Pick<
  ComposerDraft,
  "diffComments" | "diffCommentEditor" | "planCommentSelection" | "submissions"
> {
  const counter: DropCounter = { dropped: 0 };
  const fields = {
    diffComments: parseStoredElements<DraftDiffComment>(candidate.diffComments, DraftDiffCommentSchema(), counter),
    diffCommentEditor: parseStoredDiffCommentEditor(candidate.diffCommentEditor, counter),
    planCommentSelection: parseStoredElement<PlanCommentSelection>(
      candidate.planCommentSelection,
      PlanCommentSelectionSchema(),
      counter,
    ),
    submissions: parseStoredElements<DraftSubmission>(candidate.submissions, DraftSubmissionSchema(), counter),
  };
  if (counter.dropped > 0) {
    console.warn(`[composer-draft-storage] Dropped ${counter.dropped} invalid stored draft element(s)`);
  }
  return fields;
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
    ...parseStoredNextMessageFields(candidate),
  };
}

/** Why the latest draft write failed, or null after a successful write. */
interface DraftWriteFailureState {
  readonly failure: "storage-full" | "storage-unavailable" | null;
}

/** Latest draft write outcome; the composer shows a notice while it is a failure. */
export const useDraftWriteFailureStore = create<DraftWriteFailureState>(() => ({ failure: null }));

function isQuotaError(error: unknown): boolean {
  const name = error instanceof Error || error instanceof DOMException ? error.name : undefined;
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

function recordDraftWriteFailure(error: unknown): void {
  const failure = isQuotaError(error) ? "storage-full" : "storage-unavailable";
  if (useDraftWriteFailureStore.getState().failure === null) {
    console.warn("[composer-draft-storage] Draft not saved", error);
  }
  useDraftWriteFailureStore.setState({ failure });
}

function recordDraftWriteSuccess(): void {
  if (useDraftWriteFailureStore.getState().failure !== null) {
    useDraftWriteFailureStore.setState({ failure: null });
  }
}

/**
 * localStorage writes can fail on quota; a failed draft write must never take
 * down the composer, but it is recorded so the composer can say the draft was
 * not saved. Reads return null so Zustand treats it as "no state".
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
      recordDraftWriteSuccess();
    } catch (error) {
      recordDraftWriteFailure(error);
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
