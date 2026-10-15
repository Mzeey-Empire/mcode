import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import {
  DiffAnnotationPayloadSchema,
  FileAnnotationPayloadSchema,
  McodeBrowserCaptureV2Schema,
  PreviewAnnotationPayloadV2Schema,
} from "./browser-preview.js";

/** A durable draft image, without a client-owned filesystem path. */
export const StagedDraftImageSchema = lazySchema(() => z.object({
  stagingId: z.string().uuid(),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
}));
/** A durable draft image. */
export type StagedDraftImage = z.infer<ReturnType<typeof StagedDraftImageSchema>>;

/** Identity and revision of one sendable draft element. */
export const DraftElementMetaSchema = lazySchema(() => z.object({
  id: z.string().min(1),
  revision: z.number().int().min(1),
}));
/** Identity and revision of one sendable draft element. */
export type DraftElementMeta = z.infer<ReturnType<typeof DraftElementMetaSchema>>;

/** Draft fields whose revisions can be frozen by a submission. */
export const DraftElementFieldSchema = lazySchema(() => z.enum(["diffComments", "fileComments", "browserNotePages"]));
/** Draft fields whose revisions can be frozen by a submission. */
export type DraftElementField = z.infer<ReturnType<typeof DraftElementFieldSchema>>;

/** The exact element revisions and image references frozen by a send. */
export const DraftSubmissionSchema = lazySchema(() => z.object({
  messageId: z.string().uuid(),
  elements: z.array(DraftElementMetaSchema().extend({ field: DraftElementFieldSchema() })),
  stagingIds: z.array(z.string().uuid()),
}));
/** The exact element revisions and image references frozen by a send. */
export type DraftSubmission = z.infer<ReturnType<typeof DraftSubmissionSchema>>;

/** A revisioned diff comment retaining all annotation payload refinements. */
export const DraftDiffCommentSchema = lazySchema(() => DiffAnnotationPayloadSchema().and(DraftElementMetaSchema()));
/** A revisioned diff comment. Its annotation ID is its draft element ID. */
export type DraftDiffComment = z.infer<ReturnType<typeof DraftDiffCommentSchema>>;

/** A revisioned file comment retaining all annotation payload refinements. */
export const DraftFileCommentSchema = lazySchema(() => FileAnnotationPayloadSchema().and(DraftElementMetaSchema()));
/** A revisioned file comment. Its annotation ID is its draft element ID. */
export type DraftFileComment = z.infer<ReturnType<typeof DraftFileCommentSchema>>;

/** A revisioned Browser note. Its annotation ID is its draft element ID. */
export const DraftBrowserNoteSchema = lazySchema(() => PreviewAnnotationPayloadV2Schema().extend({
  revision: z.number().int().min(1),
}));
/** A revisioned Browser note. */
export type DraftBrowserNote = z.infer<ReturnType<typeof DraftBrowserNoteSchema>>;

/**
 * One Browser page of the draft: a container for its notes and the two staged
 * images they are drawn from. `snapshot` is null while the notes on the page
 * have changed since it was drawn.
 */
export const DraftBrowserNotePageSchema = lazySchema(() => z.object({
  pageIdentity: z.string().min(1),
  url: z.string().max(4096),
  title: z.string().max(240).nullable(),
  faviconUrl: z.string().max(4096).nullable(),
  /** Page context at the moment the clean capture was taken. */
  capture: McodeBrowserCaptureV2Schema(),
  scroll: z.object({ x: z.number(), y: z.number() }).strict(),
  /**
   * The unmarked viewport screenshot the snapshot is redrawn from. Never sent.
   * Null for a page restored from a queued message, which only kept the marked image.
   */
  cleanCapture: StagedDraftImageSchema().nullable(),
  /** The marked image of the page's current notes, or null until redrawn. */
  snapshot: StagedDraftImageSchema().nullable(),
  notes: z.array(DraftBrowserNoteSchema()).min(1),
}).strict());
/** One Browser page of the draft. */
export type DraftBrowserNotePage = z.infer<ReturnType<typeof DraftBrowserNotePageSchema>>;

/** Structured RPC failure when retention or thread deletion removed a draft image. */
export const DraftImageMissingErrorSchema = lazySchema(() => z.object({
  code: z.literal("draft_image_missing"),
  message: z.string(),
  data: z.object({ stagingId: z.string().uuid() }),
}));
/** Structured RPC failure for a missing draft image. */
export type DraftImageMissingError = z.infer<ReturnType<typeof DraftImageMissingErrorSchema>>;
