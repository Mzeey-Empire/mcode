import { z } from "zod";

/** Fixed public text allowed in synthetic native plan events. */
export const SYNTHETIC_PLAN_MARKDOWN = "# Synthetic plan\n\n## Build\n```ts\nconst answer = 42;\n```";
const planDelta = z.enum(["Summary\n``", "``mcode-", "plan\n" + SYNTHETIC_PLAN_MARKDOWN + "\n```", "`"]);

/** Native envelopes for plan replay, restricted to known synthetic identities and text. */
export const SyntheticPlanTraceSchema = z.discriminatedUnion("providerId", [
  z.object({ providerId: z.literal("claude"), requests: z.array(z.object({
    toolName: z.literal("ExitPlanMode"), input: z.object({ plan: z.literal(SYNTHETIC_PLAN_MARKDOWN) }).strict(),
  }).strict()).length(1) }).strict(),
  z.object({ providerId: z.literal("codex"), events: z.array(z.object({
    method: z.literal("item/agentMessage/delta"), params: z.object({
      threadId: z.literal("SESSION_1"), turnId: z.literal("TURN_1"), itemId: z.literal("ITEM_1"), delta: planDelta,
    }).strict(),
  }).strict()).min(1).max(10) }).strict(),
  z.object({ providerId: z.literal("copilot"), events: z.array(z.object({
    id: z.string().regex(/^EVENT_[1-9]$/), timestamp: z.literal("2026-01-01T00:00:00.000Z"), parentId: z.null(),
    type: z.literal("assistant.message_delta"), data: z.object({ messageId: z.literal("ITEM_1"), deltaContent: planDelta }).strict(),
  }).strict()).min(1).max(10) }).strict(),
  z.object({ providerId: z.literal("opencode"), events: z.array(z.object({
    type: z.literal("message.part.updated"), properties: z.object({
      part: z.object({ id: z.literal("PART_1"), messageID: z.literal("ITEM_1"), type: z.literal("text") }).strict(),
      delta: planDelta,
    }).strict(),
  }).strict()).min(1).max(10) }).strict(),
]);

/** Validated provider input used by synthetic conformance replay. */
export type SyntheticPlanTrace = z.infer<typeof SyntheticPlanTraceSchema>;
