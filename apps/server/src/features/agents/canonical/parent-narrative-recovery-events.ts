import * as NodeCrypto from "node:crypto";
import type { AgentItem, AgentThread, AgentTurn, ParentNarrativeRecoveryItem } from "@mcode/contracts";
import type { CanonicalAgentEventDraft, ParentNarrativeRecoveryCommitInput } from "./canonical-agent-boundary.js";

/** Builds recovery events from hydrated items before any storage work. */
export function prepareParentNarrativeRecoveryEvents(input: {
  readonly recovery: ParentNarrativeRecoveryCommitInput;
  readonly thread: AgentThread;
  readonly turn: AgentTurn;
  readonly findItem: (id: string) => AgentItem | null | undefined;
}): CanonicalAgentEventDraft[] {
  const { recovery, thread, turn, findItem } = input;
  const persisted = recovery.items.map((entry): CanonicalAgentEventDraft => {
    const itemId = narrativeItemId(entry);
    const item: AgentItem = {
      id: itemId, threadId: thread.id, turnId: turn.id,
      ...narrativeParent(entry), kind: narrativeKind(entry), providerIdentities: turn.providerIdentities,
      payload: recoveryPayload(entry, findItem(itemId)?.payload ?? {}),
      createdAt: entry.record.started_at,
      updatedAt: entry.kind === "toolCall" ? entry.record.completed_at ?? entry.record.started_at
        : entry.record.ended_at ?? entry.record.started_at,
    };
    return { eventId: `narrative:${recovery.executionId}:${itemId}:${fingerprint(entry)}`,
      routing: { threadId: thread.id, turnId: turn.id, executionId: recovery.executionId, itemId },
      sourceProviderId: thread.providerId, sourceIdentities: [], payload: { type: "item.recorded", item } };
  });
  return [...persisted, ...(recovery.discardedItemIds ?? []).map((itemId) => discardEvent({ ...input, itemId }))];
}

function discardEvent(input: Parameters<typeof prepareParentNarrativeRecoveryEvents>[0] & { readonly itemId: string }): CanonicalAgentEventDraft {
  const { recovery, thread, turn, itemId } = input;
  const existing = input.findItem(itemId);
  const projection = existing?.payload.projection;
  if (!existing || existing.threadId !== thread.id || existing.turnId !== turn.id
    || projection !== "narrativeRecovery" && projection !== "narrativeRecoveryDiscarded") {
    throw new Error(`Canonical narrative recovery item was not found: ${itemId}`);
  }
  return { eventId: `narrative-discard:${recovery.executionId}:${itemId}:${fingerprint(existing.payload)}`,
    routing: { threadId: thread.id, turnId: turn.id, executionId: recovery.executionId, itemId },
    sourceProviderId: thread.providerId, sourceIdentities: [],
    payload: { type: "item.recorded", item: { ...existing, payload: { ...existing.payload, projection: "narrativeRecoveryDiscarded" } } } };
}

function narrativeItemId(item: ParentNarrativeRecoveryItem): string {
  return `${item.kind}:${item.record.id}`;
}

function narrativeParent(item: ParentNarrativeRecoveryItem): { parentItemId?: string } {
  return item.kind === "toolCall" && item.record.parent_tool_call_id
    ? { parentItemId: `toolCall:${item.record.parent_tool_call_id}` } : {};
}

function narrativeKind(item: ParentNarrativeRecoveryItem): AgentItem["kind"] {
  switch (item.kind) {
    case "toolCall": return "tool-call";
    case "narrationSegment": return "reasoning";
    case "hook": return "system";
  }
}

function recoveryPayload(item: ParentNarrativeRecoveryItem, existing: AgentItem["payload"]): AgentItem["payload"] {
  const metadata: Record<string, string> = {};
  if (item.kind === "toolCall") {
    for (const key of ["identity", "model", "reasoningEffort"]) {
      if (typeof existing[key] === "string") metadata[key] = existing[key];
    }
  }
  return { projection: "narrativeRecovery", narrative: item, ...metadata };
}

function fingerprint(value: unknown): string {
  return NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
