import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/**
 * Wire-side types for the Codex browser-use pipe protocol. These mirror the
 * shapes consumed by dpcode's `browserUsePipeServer.ts` so any browser-use
 * client (Codex CLI, OpenCode, custom tools) can connect unchanged.
 *
 * Spec: https://github.com/Emanuele-web04/dpcode (browserUsePipeServer.ts)
 */

/** Max sizes enforced at the framing layer. */
export const BROWSER_USE_FRAME_HEADER_BYTES = 4;
export const BROWSER_USE_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** Pipe path env vars the bridge checks in priority order. */
export const MCODE_BROWSER_USE_PIPE_ENV = "MCODE_BROWSER_USE_PIPE_PATH";
export const DPCODE_BROWSER_USE_PIPE_ENV = "DPCODE_BROWSER_USE_PIPE_PATH";
export const T3CODE_BROWSER_USE_PIPE_ENV = "T3CODE_BROWSER_USE_PIPE_PATH";

/** Method names recognised by the pipe server. */
export const BROWSER_USE_METHODS = [
  "ping",
  "getInfo",
  "getTabs",
  "createTab",
  "nameSession",
  "attach",
  "detach",
  "executeCdp",
] as const;
export type BrowserUseMethod = (typeof BROWSER_USE_METHODS)[number];

/** One row of the `getTabs` / `createTab` result; bridge-tracked integer id. */
export const BrowserUseTabRowSchema = lazySchema(() =>
  z.object({
    id: z.number().int().positive(),
    title: z.string(),
    active: z.boolean(),
    url: z.string(),
  }),
);
export type BrowserUseTabRow = z.infer<ReturnType<typeof BrowserUseTabRowSchema>>;

/** Input shape for `executeCdp` after `params` parsing. */
export const BrowserExecuteCdpInputSchema = lazySchema(() =>
  z.object({
    /** Mcode thread id that owns the target tab. */
    threadId: z.string().min(1),
    /** Mcode opaque tab id within that thread. */
    tabId: z.string().min(1),
    /** CDP method, e.g. `Page.navigate`, `Runtime.evaluate`. */
    method: z.string().min(1),
    /** Optional CDP command params. */
    params: z.unknown().optional(),
  }),
);
export type BrowserExecuteCdpInput = z.infer<ReturnType<typeof BrowserExecuteCdpInputSchema>>;

/** Push notification body sent on every CDP event for an attached tab. */
export const BrowserUseCdpNotificationParamsSchema = lazySchema(() =>
  z.object({
    source: z.object({ tabId: z.number().int().positive() }),
    method: z.string().min(1),
    params: z.unknown().optional(),
  }),
);
export type BrowserUseCdpNotificationParams = z.infer<
  ReturnType<typeof BrowserUseCdpNotificationParamsSchema>
>;
