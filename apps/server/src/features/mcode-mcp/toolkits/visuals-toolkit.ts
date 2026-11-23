import { z } from "zod";
import {
  HtmlVisualPlacementSchema, HtmlVisualSchema, HTML_VISUAL_DEFAULT_HEIGHT, HTML_VISUAL_MAX_HEIGHT,
  HTML_VISUAL_MIN_HEIGHT, HTML_VISUAL_MAX_HTML_BYTES, HTML_VISUAL_MAX_TITLE_LENGTH,
  HTML_VISUAL_PREVIEW_DEFAULT_WIDTH, HTML_VISUAL_PREVIEW_MAX_WIDTH, HTML_VISUAL_PREVIEW_MIN_WIDTH,
  HTML_VISUAL_THEME_TOKENS,
} from "@mcode/contracts/models/html-visual";
import { FeatureRetentionLimitError } from "../../agents/canonical/accepted-feature-observations.js";
import { TurnVisualRejectedError, type CanonicalAcceptedProgress } from "../../agents/canonical/canonical-accepted-progress.js";
import { McodeThreadControlDeniedError, type McodeSessionAuthority, type McodeSession } from "../mcode-session-authority.js";
import { defineToolkit, type McodeToolkit } from "../mcode-toolkit.js";
import type { HtmlPreviewRenderer } from "./html-preview-renderer.js";
import { inlineLocalImages, type ImageFileReader } from "./inline-local-images.js";
import { listedSchema, parseInput, structuredResult, toToolResult } from "./thread-control-toolkit.js";

// Reject oversized source before scanning it for local images.
const HtmlInputSchema = z.string().min(1, "html must not be empty").max(HTML_VISUAL_MAX_HTML_BYTES);
const HtmlRenderInputSchema = z.object({
  html: HtmlInputSchema,
  title: z.string().trim().min(1).max(HTML_VISUAL_MAX_TITLE_LENGTH),
  height: z.number().int().min(HTML_VISUAL_MIN_HEIGHT).max(HTML_VISUAL_MAX_HEIGHT).default(HTML_VISUAL_DEFAULT_HEIGHT)
    .describe(`Maximum frame height in px. The frame shrinks to fit. Leave height at its default unless html_preview's contentHeight is above it. Then pass ${HTML_VISUAL_MAX_HEIGHT}.`),
  placement: HtmlVisualPlacementSchema().default("auto")
    .describe('"auto" shows the page above your reply. "inline" shows it where you put the returned marker in your reply; without the marker it shows above your reply.'),
}).strict();
const HtmlRenderOutputSchema = z.object({
  messageId: z.string().uuid(), title: z.string(), bytes: z.number().int(), inlinedImages: z.number().int(),
  placement: HtmlVisualPlacementSchema(), marker: z.string().optional(),
});
const AppearanceSchema = z.enum(["light", "dark"]);
const HtmlPreviewInputSchema = z.strictObject({
  html: HtmlInputSchema,
  width: z.number().int().min(HTML_VISUAL_PREVIEW_MIN_WIDTH).max(HTML_VISUAL_PREVIEW_MAX_WIDTH).default(HTML_VISUAL_PREVIEW_DEFAULT_WIDTH),
  appearance: AppearanceSchema.default("dark"),
});
const HtmlPreviewOutputSchema = z.object({
  width: z.number().int(),
  appearance: AppearanceSchema,
  contentHeight: z.number().int(),
  frameHeight: z.number().int(),
  inlinedImages: z.number().int(),
  console: z.array(z.object({
    level: z.enum(["log", "info", "warning", "error"]),
    text: z.string(),
    line: z.number().int().positive().optional(),
  })),
});
const TURN_ERROR = "html_render works only while a turn is running.";
const DESCRIPTION = [
  "Publish a self-contained HTML page inline in the Thread. By default the page is shown above your final reply, so call this before you write the reply, and do not restate the page in the reply.",
  "The page runs in a sandboxed frame. Put all styles and scripts inline. Remote URLs (http, https, CDNs, web fonts) never load. To show a local image, reference it by absolute file path (C:\\path\\chart.png, /home/me/chart.png, or file:///...) in src, href, or CSS url(); it is inlined as a data URI at publish time. Supported: png, jpg, jpeg, gif, webp, svg, avif, bmp, ico.",
  `Check the page with html_preview before publishing. Fix any errors or layout problems it shows. Leave height at its default unless html_preview's contentHeight is above it. Then pass height ${HTML_VISUAL_MAX_HEIGHT}.`,
  "Layout: leave the page background to the Thread (it is already var(--background)). Use fluid width. Do not add an outer card, border, or banner. Give charts and canvases a fixed pixel height. Do not use vh or other viewport-based heights; the frame sizes to your content up to height.",
  `Theme tokens on :root: ${HTML_VISUAL_THEME_TOKENS.join(" ")}. Use them so the page follows light and dark themes.`,
  `Limits: html up to ${HTML_VISUAL_MAX_HTML_BYTES.toLocaleString("en-US")} bytes after images are inlined; title up to ${HTML_VISUAL_MAX_TITLE_LENGTH} characters; height ${HTML_VISUAL_MIN_HEIGHT} to ${HTML_VISUAL_MAX_HEIGHT} px, default ${HTML_VISUAL_DEFAULT_HEIGHT}.`,
].join("\n\n");

/** Markdown image line the web client swaps for the visual's frame. Escaping keeps a title's brackets from ending the alt text. */
function visualMarker(title: string, messageId: string): string {
  return `![${title.replace(/[\\[\]]/g, "\\$&")}](visual:${messageId})`;
}

function heightAdvice(contentHeight: number): string {
  if (contentHeight <= HTML_VISUAL_DEFAULT_HEIGHT) return "The default height fits.";
  if (contentHeight <= HTML_VISUAL_MAX_HEIGHT) {
    return `contentHeight ${contentHeight} is taller than the default ${HTML_VISUAL_DEFAULT_HEIGHT}px frame; pass height ${HTML_VISUAL_MAX_HEIGHT} to show it in full (the frame shrinks to fit).`;
  }
  return `contentHeight ${contentHeight} is taller than the ${HTML_VISUAL_MAX_HEIGHT}px maximum frame, so the page scrolls inside its frame even at height ${HTML_VISUAL_MAX_HEIGHT}. Shorten it or split it into several visuals.`;
}

async function prepareHtml(html: string, files: ImageFileReader | undefined, signal: AbortSignal) {
  const inlined = await inlineLocalImages(html, files, signal);
  const bytes = Buffer.byteLength(inlined.html, "utf8");
  if (bytes > HTML_VISUAL_MAX_HTML_BYTES) {
    throw new Error(`html is ${bytes.toLocaleString("en-US")} bytes after inlining ${inlined.count} images; the limit is ${HTML_VISUAL_MAX_HTML_BYTES.toLocaleString("en-US")} bytes. Shrink or drop images.`);
  }
  return { ...inlined, bytes };
}

/** Authority, publication, rendering and filesystem boundaries for the Visuals toolkit. */
export interface VisualsToolkitDeps {
  readonly authority: Pick<McodeSessionAuthority, "authorizeThreadControl">;
  readonly visuals: Pick<CanonicalAcceptedProgress, "acceptTurnVisual">;
  readonly preview: HtmlPreviewRenderer;
  readonly files?: ImageFileReader;
}

/** Offer visual previews and publication to sessions granted the Visuals toolkit. */
export function createVisualsToolkit(deps: VisualsToolkitDeps): McodeToolkit {
  return defineToolkit<McodeSession>({
    name: "visuals",
    grant: (session) => session.threadControl ? session : null,
    tools: [{
      name: "html_render",
      description: DESCRIPTION,
      inputSchema: listedSchema(HtmlRenderInputSchema, "input") ?? { type: "object", properties: {} },
      outputSchema: listedSchema(HtmlRenderOutputSchema, "output"),
      call: (args, session, call) => toToolResult(async () => {
        try {
          const authority = deps.authority.authorizeThreadControl(session, call.toolCallId);
          const input = await parseInput("html_render", HtmlRenderInputSchema, args);
          const inlined = await prepareHtml(input.html, deps.files, call.signal);
          const { bytes } = inlined;
          const visual = HtmlVisualSchema().parse({ title: input.title, html: inlined.html, maxHeight: input.height });
          call.signal.throwIfAborted();
          const { messageId } = deps.visuals.acceptTurnVisual({ threadId: authority.sourceThreadId, turnId: authority.sourceTurnId, visual, placement: input.placement });
          const marker = input.placement === "inline" ? visualMarker(visual.title, messageId) : undefined;
          const result = HtmlRenderOutputSchema.parse({ messageId, title: visual.title, bytes, inlinedImages: inlined.count, placement: input.placement, ...(marker && { marker }) });
          if (marker) return structuredResult(result, `Published visual "${visual.title}". Put this line in your reply where the page should appear: ${marker}`);
          return structuredResult(result, `Published visual "${visual.title}" (${bytes.toLocaleString("en-US")} bytes, ${inlined.count} image${inlined.count === 1 ? "" : "s"} inlined). It is shown above your reply; do not restate it.`);
        } catch (error) {
          if (error instanceof McodeThreadControlDeniedError || error instanceof TurnVisualRejectedError) throw new Error(TURN_ERROR);
          if (error instanceof FeatureRetentionLimitError) {
            throw new Error("The page is too large once encoded. Shrink the HTML or images and try again.");
          }
          throw error;
        }
      }),
    }, {
      name: "html_preview",
      description: "Check a self-contained HTML visual before publishing it with html_render. Returns the measured content and frame heights, console diagnostics with page locations for uncaught exceptions, and a PNG when it fits the image size limit. Local image references are inlined just as they are for html_render. Fix any problems it shows before publishing. Work the page schedules more than about one second after load may not appear in the preview.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: listedSchema(HtmlPreviewInputSchema, "input") ?? { type: "object", properties: {} },
      outputSchema: listedSchema(HtmlPreviewOutputSchema, "output"),
      call: (args, session, call) => toToolResult(async () => {
        try {
          deps.authority.authorizeThreadControl(session, call.toolCallId);
        } catch (error) {
          if (error instanceof McodeThreadControlDeniedError) throw new Error("html_preview works only while a turn is running.");
          throw error;
        }
        const { html, width, appearance } = await parseInput("html_preview", HtmlPreviewInputSchema, args);
        const inlined = await prepareHtml(html, deps.files, call.signal);
        const preview = await deps.preview.render({ html: inlined.html, width, appearance, signal: call.signal });
        const output = HtmlPreviewOutputSchema.parse({
          width: preview.width, appearance, contentHeight: preview.contentHeight, frameHeight: preview.frameHeight,
          inlinedImages: inlined.count, console: preview.console,
        });
        const errors = output.console.filter((entry) => entry.level === "error").length;
        const summary = `Rendered at ${output.width}px (${appearance}). ${heightAdvice(output.contentHeight)} ${errors} ${errors === 1 ? "error" : "errors"} in the console.`;
        const result = structuredResult(output, `${summary}\n${JSON.stringify(output)}`);
        if (preview.screenshot) {
          result.content.push({ type: "image", data: preview.screenshot.data, mimeType: "image/png" });
        }
        return result;
      }),
    }],
  });
}
