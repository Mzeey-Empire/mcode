import { z } from "zod";
import type { SessionEvent } from "@github/copilot-sdk";

const identity = z.string().regex(/^[A-Z]+(?:ID)?_\d+$/);
const metadata = { id: identity, timestamp: z.string().datetime(), parentId: identity.nullable(), ephemeral: z.boolean().optional() };
const parent = { parentToolCallId: identity.optional() };
const agent = { toolCallId: identity, agentName: identity, agentDisplayName: identity };
const content = z.enum(["REDACTED_CONTENT", "REDACTED_CHILD_CONTENT", "REDACTED_TOOL_OUTPUT"]);
const schema = z.discriminatedUnion("type", [
  z.object({ ...metadata, type: z.literal("assistant.message"), data: z.object({ messageId: identity, content, ...parent }).strict() }).strict(),
  z.object({ ...metadata, ephemeral: z.literal(true), type: z.literal("assistant.message_delta"), data: z.object({ messageId: identity, deltaContent: content, ...parent }).strict() }).strict(),
  z.object({ ...metadata, type: z.literal("assistant.turn_start"), data: z.object({ turnId: identity }).strict() }).strict(),
  z.object({ ...metadata, type: z.literal("assistant.turn_end"), data: z.object({ turnId: identity }).strict() }).strict(),
  z.object({ ...metadata, type: z.literal("subagent.started"), data: z.object({ ...agent, agentDescription: identity }).strict() }).strict(),
  z.object({ ...metadata, type: z.literal("subagent.completed"), data: z.object(agent).strict() }).strict(),
  z.object({ ...metadata, type: z.literal("tool.execution_start"), data: z.object({ toolCallId: identity, toolName: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.-]{0,100}$/), arguments: z.object({}).strict(), ...parent }).strict() }).strict(),
  z.object({ ...metadata, type: z.literal("tool.execution_complete"), data: z.object({ toolCallId: identity, success: z.boolean(), result: z.object({ content }).strict().optional(), ...parent }).strict() }).strict(),
  z.object({ ...metadata, type: z.literal("abort"), data: z.object({ reason: content }).strict() }).strict(),
  z.object({ ...metadata, ephemeral: z.literal(true), type: z.literal("session.idle"), data: z.object({ aborted: z.boolean().optional() }).strict() }).strict(),
]);

const traceSchema = z.array(schema).min(1).max(10_000);

/** Validates redacted native SDK envelopes while retaining real attribution and ordering. */
export function parseCopilotCapturedTrace(value: unknown): SessionEvent[] {
  return traceSchema.parse(value);
}
