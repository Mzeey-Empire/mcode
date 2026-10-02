import type { AgentItem } from "./records.js";

/** Bind accepted narrative in one pass rather than retransmitting every saved history record. */
export function bindResponseItems(items: Readonly<Record<string, AgentItem>>, input: {
  readonly threadId: string; readonly turnId: string; readonly messageId: string; readonly endedAt: string;
  readonly outcome: "completed" | "cancelled" | "interrupted" | "errored";
}): Record<string, AgentItem> {
  const entries = Object.values(items).filter((item) => item.threadId === input.threadId && item.turnId === input.turnId);
  const message = record(items[`message:${input.messageId}`]?.payload.message);
  const finalText = typeof message?.content === "string" ? message.content.trim() : "";
  const lastThought = Math.max(-Infinity, ...entries.flatMap((item) => {
    const narrative = recovery(item);
    return narrative?.kind === "narrationSegment" && typeof narrative.record.sort_order === "number"
      ? [narrative.record.sort_order] : [];
  }));
  const bound = { ...items };
  for (const item of entries) {
    const narrative = recovery(item);
    if (!narrative) continue;
    const value = settle(narrative, input, finalText, lastThought);
    const { narrative: _recovery, ...metadata } = item.payload;
    bound[item.id] = { ...item, payload: { ...metadata, projection: narrative.kind, record: value }, updatedAt: input.endedAt };
  }
  return bound;
}

function recovery(item: AgentItem): { kind: string; record: Record<string, unknown> } | undefined {
  if (item.payload.projection !== "narrativeRecovery") return undefined;
  const narrative = record(item.payload.narrative);
  const value = record(narrative?.record);
  if (!narrative || !value || !["toolCall", "hook", "narrationSegment"].includes(String(narrative.kind))) return undefined;
  return { kind: String(narrative.kind), record: value };
}

function settle(narrative: { kind: string; record: Record<string, unknown> }, input: Parameters<typeof bindResponseItems>[1],
  finalText: string, lastThought: number): Record<string, unknown> {
  const value: Record<string, unknown> = { ...narrative.record, message_id: input.messageId };
  switch (narrative.kind) {
    case "toolCall": return value.status === "running" ? { ...value,
      status: input.outcome === "completed" ? "completed" : input.outcome === "cancelled" ? "cancelled" : "failed",
      completed_at: input.endedAt } : value;
    case "hook": return value.ended_at ? value : { ...value, ended_at: input.endedAt,
      duration_ms: typeof value.started_at === "string" ? Math.max(0, Date.parse(input.endedAt) - Date.parse(value.started_at)) : 0 };
    case "narrationSegment": return { ...value,
      is_final_response: finalThought(value, finalText, lastThought) ? 1 : value.is_final_response };
    default: return value;
  }
}

function finalThought(value: Record<string, unknown>, finalText: string, lastThought: number): boolean {
  if (typeof value.id === "string" && value.id.startsWith("assistant-text:")) return false;
  if (typeof value.text !== "string") return false;
  const text = value.text.trim();
  return finalText.length > 0 && text.length > 0 && (text === finalText
    || value.sort_order === lastThought && finalText.endsWith(text));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
