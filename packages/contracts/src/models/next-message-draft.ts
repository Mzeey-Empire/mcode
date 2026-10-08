import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { DiffAnnotationPayloadSchema } from "./browser-preview.js";

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
export const DraftElementFieldSchema = lazySchema(() => z.enum(["diffComments", "planCommentSelection"]));
/** Draft fields whose revisions can be frozen by a submission. */
export type DraftElementField = z.infer<ReturnType<typeof DraftElementFieldSchema>>;

/** Client selection of authoritative plan comments for the next message. */
export const PlanCommentSelectionSchema = lazySchema(() => z.object({
  planVersionId: z.string(),
  includedIds: z.array(z.string()),
  excludedIds: z.array(z.string()),
  revision: z.number().int().min(1),
}));
/** Client selection of plan comments for the next message. */
export type PlanCommentSelection = z.infer<ReturnType<typeof PlanCommentSelectionSchema>>;

/** The exact element revisions and image references frozen by a send. */
export const DraftSubmissionSchema = lazySchema(() => z.object({
  messageId: z.string().uuid(),
  elements: z.array(DraftElementMetaSchema().extend({ field: DraftElementFieldSchema() })),
  planComments: z.object({ ridingIds: z.array(z.string()), excludedIds: z.array(z.string()) }).optional(),
  stagingIds: z.array(z.string().uuid()),
}));
/** The exact element revisions and image references frozen by a send. */
export type DraftSubmission = z.infer<ReturnType<typeof DraftSubmissionSchema>>;

/** A revisioned diff comment retaining all annotation payload refinements. */
export const DraftDiffCommentSchema = lazySchema(() => DiffAnnotationPayloadSchema().and(DraftElementMetaSchema()));
/** A revisioned diff comment. Its annotation ID is its draft element ID. */
export type DraftDiffComment = z.infer<ReturnType<typeof DraftDiffCommentSchema>>;

/** Structured RPC failure when retention or thread deletion removed a draft image. */
export const DraftImageMissingErrorSchema = lazySchema(() => z.object({
  code: z.literal("draft_image_missing"),
  message: z.string(),
  data: z.object({ stagingId: z.string().uuid() }),
}));
/** Structured RPC failure for a missing draft image. */
export type DraftImageMissingError = z.infer<ReturnType<typeof DraftImageMissingErrorSchema>>;
