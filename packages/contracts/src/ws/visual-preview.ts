import { z } from "zod";
import {
  HTML_VISUAL_MAX_HEIGHT,
  HTML_VISUAL_MAX_HTML_BYTES,
  HTML_VISUAL_MIN_HEIGHT,
  HTML_VISUAL_PREVIEW_MAX_WIDTH,
  HTML_VISUAL_PREVIEW_MIN_WIDTH,
} from "../models/html-visual.js";
import { lazySchema } from "../utils/lazySchema.js";

const MAX_FRAME_DOCUMENT_BYTES = HTML_VISUAL_MAX_HTML_BYTES + 64 * 1024;

/** Maximum time a preview may wait for the desktop renderer to become available. */
export const VISUAL_PREVIEW_QUEUE_LIMIT_MS = 5_000;
/** Maximum number of diagnostics the desktop may return per preview. */
export const VISUAL_PREVIEW_MAX_CONSOLE_ENTRIES = 200;
/** Maximum length of a diagnostic sent over the preview channel. */
export const VISUAL_PREVIEW_MAX_CONSOLE_TEXT = 10_000;

/** Directed render request, also validated at the Electron IPC boundary. */
export const VisualPreviewRequestSchema = lazySchema(() => z.object({
  requestId: z.string().uuid(),
  frameDocument: z.string().max(MAX_FRAME_DOCUMENT_BYTES)
    .refine((document) => new TextEncoder().encode(document).length <= MAX_FRAME_DOCUMENT_BYTES),
  width: z.number().int().min(HTML_VISUAL_PREVIEW_MIN_WIDTH).max(HTML_VISUAL_PREVIEW_MAX_WIDTH),
  maxHeight: z.number().int().min(HTML_VISUAL_MIN_HEIGHT).max(HTML_VISUAL_MAX_HEIGHT),
  deadlineMs: z.number().int().min(1000).max(30_000),
}).strict());

/** Work sent to one connected desktop window. */
export type VisualPreviewRequest = z.infer<ReturnType<typeof VisualPreviewRequestSchema>>;

const consoleEntrySchema = lazySchema(() => z.object({
  level: z.enum(["log", "info", "warning", "error"]),
  text: z.string().max(VISUAL_PREVIEW_MAX_CONSOLE_TEXT),
  line: z.number().int().positive().optional(),
}).strict());

/** A diagnostic collected while the iframe rendered. */
export type VisualPreviewConsoleEntry = z.infer<ReturnType<typeof consoleEntrySchema>>;

/**
 * Ranks uncaught exceptions above other errors and errors above other diagnostics.
 * Electron's console event has no exception flag, so exceptions are recognized by Chromium's `Uncaught` prefix.
 */
export function visualPreviewConsolePriority(entry: VisualPreviewConsoleEntry): number {
  if (entry.level !== "error") return 0;
  return entry.text.startsWith("Uncaught") ? 2 : 1;
}

/** Successful capture or render failure reported by desktop main. */
export const VisualPreviewOutcomeSchema = lazySchema(() => z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rendered"),
    contentHeight: z.number().finite().nonnegative(),
    heightStillChanging: z.boolean(),
    console: z.array(consoleEntrySchema()).max(VISUAL_PREVIEW_MAX_CONSOLE_ENTRIES),
    droppedConsoleEntries: z.number().int().nonnegative(),
    png: z.string().max(24 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine((png) => png.length % 4 === 0).optional(),
  }).strict(),
  z.object({
    kind: z.literal("failed"),
    reason: z.enum(["timeout", "busy", "error"]),
    message: z.string().max(2000),
  }).strict(),
]));

/** Result of one desktop capture. */
export type VisualPreviewOutcome = z.infer<ReturnType<typeof VisualPreviewOutcomeSchema>>;

/** Correlates the desktop's outcome with the request that was sent to it. */
export const VisualPreviewResponseSchema = lazySchema(() => z.object({
  requestId: z.string().uuid(),
  outcome: VisualPreviewOutcomeSchema(),
}).strict());

/** Reply to a directed preview request. */
export type VisualPreviewResponse = z.infer<ReturnType<typeof VisualPreviewResponseSchema>>;
