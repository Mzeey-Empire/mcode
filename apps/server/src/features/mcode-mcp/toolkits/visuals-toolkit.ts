import { z } from "zod";
import { HtmlVisualSchema, HTML_VISUAL_DEFAULT_HEIGHT, HTML_VISUAL_MAX_HEIGHT, HTML_VISUAL_MIN_HEIGHT,
  HTML_VISUAL_MAX_HTML_BYTES, HTML_VISUAL_MAX_TITLE_LENGTH, HTML_VISUAL_THEME_TOKENS } from "@mcode/contracts";
import { FeatureRetentionLimitError } from "../../agents/canonical/accepted-feature-observations.js";
import { TurnVisualRejectedError, type CanonicalAcceptedProgress } from "../../agents/canonical/canonical-accepted-progress.js";
import { McodeThreadControlDeniedError, type McodeSessionAuthority, type McodeSession } from "../mcode-session-authority.js";
import { defineToolkit, type McodeToolkit } from "../mcode-toolkit.js";
import { inlineLocalImages, type ImageFileReader } from "./inline-local-images.js";
import { listedSchema, parseInput, structuredResult, toToolResult } from "./thread-control-toolkit.js";

const HtmlRenderInputSchema = z.object({
  // Inlining only grows a page, so a source over the page limit can never publish; rejecting it first bounds the scan.
  html: z.string().min(1, "html must not be empty").max(HTML_VISUAL_MAX_HTML_BYTES),
  title: z.string().trim().min(1).max(HTML_VISUAL_MAX_TITLE_LENGTH),
  height: z.number().int().min(HTML_VISUAL_MIN_HEIGHT).max(HTML_VISUAL_MAX_HEIGHT).default(HTML_VISUAL_DEFAULT_HEIGHT)
    .describe("Maximum frame height in px. The frame shrinks to shorter content."),
}).strict();
const HtmlRenderOutputSchema = z.object({
  messageId: z.string().uuid(), title: z.string(), bytes: z.number().int(), inlinedImages: z.number().int(),
});
const TURN_ERROR = "html_render works only while a turn is running.";
const DESCRIPTION = [
  "Publish a self-contained HTML page inline in the Thread. The page is shown above your final reply, so call this before you write the reply, and do not restate the page in the reply.",
  "The page runs in a sandboxed frame. Put all styles and scripts inline. Remote URLs (http, https, CDNs, web fonts) never load. To show a local image, reference it by absolute file path (C:\\path\\chart.png, /home/me/chart.png, or file:///...) in src, href, or CSS url(); it is inlined as a data URI at publish time. Supported: png, jpg, jpeg, gif, webp, svg, avif, bmp, ico.",
  "There is no preview tool yet, so read your HTML once more before publishing: a script error shows a blank frame.",
  "Layout: leave the page background to the Thread (it is already var(--background)). Use fluid width. Do not add an outer card, border, or banner. Give charts and canvases a fixed pixel height. Do not use vh or other viewport-based heights; the frame sizes to your content up to height.",
  `Theme tokens on :root: ${HTML_VISUAL_THEME_TOKENS.join(" ")}. Use them so the page follows light and dark themes.`,
  `Limits: html up to ${HTML_VISUAL_MAX_HTML_BYTES.toLocaleString("en-US")} bytes after images are inlined; title up to ${HTML_VISUAL_MAX_TITLE_LENGTH} characters; height ${HTML_VISUAL_MIN_HEIGHT} to ${HTML_VISUAL_MAX_HEIGHT} px, default ${HTML_VISUAL_DEFAULT_HEIGHT}.`,
].join("\n\n");

/** Authority, publication and filesystem boundaries for the Visuals toolkit. */
export interface VisualsToolkitDeps {
  readonly authority: Pick<McodeSessionAuthority, "authorizeThreadControl">;
  readonly visuals: Pick<CanonicalAcceptedProgress, "acceptTurnVisual">;
  readonly files?: ImageFileReader;
}

/** Offer visual publication to sessions with turn-control leases. */
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
          const inlined = await inlineLocalImages(input.html, deps.files, call.signal);
          const bytes = Buffer.byteLength(inlined.html, "utf8");
          if (bytes > HTML_VISUAL_MAX_HTML_BYTES) {
            throw new Error(`html is ${bytes.toLocaleString("en-US")} bytes after inlining ${inlined.count} images; the limit is ${HTML_VISUAL_MAX_HTML_BYTES.toLocaleString("en-US")} bytes. Shrink or drop images.`);
          }
          const visual = HtmlVisualSchema().parse({ title: input.title, html: inlined.html, maxHeight: input.height });
          call.signal.throwIfAborted();
          const { messageId } = deps.visuals.acceptTurnVisual({ threadId: authority.sourceThreadId, turnId: authority.sourceTurnId, visual });
          const result = HtmlRenderOutputSchema.parse({ messageId, title: visual.title, bytes, inlinedImages: inlined.count });
          return structuredResult(result, `Published visual "${visual.title}" (${bytes.toLocaleString("en-US")} bytes, ${inlined.count} image${inlined.count === 1 ? "" : "s"} inlined). It is shown above your reply; do not restate it.`);
        } catch (error) {
          if (error instanceof McodeThreadControlDeniedError || error instanceof TurnVisualRejectedError) throw new Error(TURN_ERROR);
          if (error instanceof FeatureRetentionLimitError) {
            throw new Error("The page is too large once encoded. Shrink the HTML or images and try again.");
          }
          throw error;
        }
      }),
    }],
  });
}
