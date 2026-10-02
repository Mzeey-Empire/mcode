import { z } from "zod";

const identity = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const parent = identity.nullable().optional();
const common = { uuid: identity, session_id: identity, parent_tool_use_id: parent };
const tool = z.enum(["Agent", "Read"]);
const messages = z.discriminatedUnion("type", [
  z.object({ ...common, type: z.literal("system"), subtype: z.literal("init") }).strict(),
  z.object({ ...common, type: z.literal("assistant"), message: z.object({ content: z.array(z.object({ type: z.literal("tool_use"), id: identity, name: tool }).strict()).max(16) }).strict() }).strict(),
  z.object({ ...common, type: z.literal("user"), message: z.object({ content: z.array(z.object({ type: z.literal("tool_result"), tool_use_id: identity, is_error: z.boolean().optional() }).strict()).max(16) }).strict() }).strict(),
  z.object({ ...common, type: z.literal("tool_progress"), tool_use_id: identity, tool_name: tool, elapsed_time_seconds: z.number().nonnegative().optional() }).strict(),
  z.object({ ...common, type: z.literal("result"), is_error: z.boolean() }).strict(),
]);

/** Allowlisted native Claude envelopes containing structural identities and no user content. */
export const ClaudeNativeTraceSchema = z.object({
  nativeMessages: z.array(messages).min(1).max(256),
  sdkFailure: z.object({ kind: z.literal("authentication") }).strict().optional(),
  expected: z.object({ toolStarts: z.array(z.tuple([identity, identity.nullable()])).max(64), toolResults: z.array(identity).max(64), terminalCount: z.literal(1) }).strict(),
}).strict();

/** Safe native envelopes replayed through the public factory and production mapper. */
export type ClaudeNativeTrace = z.infer<typeof ClaudeNativeTraceSchema>;
