import type { CanonicalAgentEventEnvelope } from "@mcode/contracts/compat/agent-model";
import type { CanonicalAgentBoundary } from "../canonical/canonical-agent-boundary.js";
import { subscribeCommittedCanonicalEvents } from "../canonical/committed-canonical-events.js";
import type { AgentRuntimeAccess } from "../orchestration/turn-runtime-controller.js";

/** Server-authoritative running-agent occupancy, including calls that outlive turns. */
export interface AgentWorkload {
  /** Threads with a running turn or a running background subagent, each counted once. */
  count(): number;
  hasBackgroundSubagent(threadId: string): boolean;
  /** Fires when a thread gains its first or loses its last running background subagent. */
  onSubagentChange(listener: (threadId: string) => void): () => void;
}

/** Maintains background occupancy only from durable canonical changes. */
export class AgentWorkloadService implements AgentWorkload {
  private readonly subagents = new Map<string, Set<string>>();
  private readonly listeners = new Set<(threadId: string) => void>();

  constructor(
    private readonly runtime: Pick<AgentRuntimeAccess, "activeTurnThreadIds">,
    private readonly canonical: Pick<CanonicalAgentBoundary, "listHeldBackgroundToolCalls">,
  ) {}

  /** Read current occupancy without database access. */
  count(): number {
    return new Set([...this.runtime.activeTurnThreadIds(), ...this.subagents.keys()]).size;
  }

  /** Whether a finished turn still owns a running background subagent. */
  hasBackgroundSubagent(threadId: string): boolean {
    return this.subagents.has(threadId);
  }

  /** Subscribe to background occupancy transitions. */
  onSubagentChange(listener: (threadId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Observe saved tool changes and turn endings, including late results outside a turn. */
  observeCommittedEvents(subscribe = subscribeCommittedCanonicalEvents): () => void {
    return subscribe((events) => {
      // A late settlement also saves its tool call record with `background: true`, so tool
      // results need no separate check.
      const threads = new Set(events.filter(touchesBackgroundCalls).map((event) => event.routing.threadId));
      for (const threadId of threads) this.refresh(threadId);
    });
  }

  /**
   * Re-read every thread holding a subagent. Deletion discards the thread's unsaved writes and removes its rows,
   * so no saved event ever reports that its calls stopped.
   */
  refreshTracked(): void {
    for (const threadId of this.subagents.keys()) this.refresh(threadId);
  }

  private refresh(threadId: string): void {
    const previous = this.hasBackgroundSubagent(threadId);
    const calls = this.canonical.listHeldBackgroundToolCalls({ threadId });
    const ids = new Set(calls.filter((call) => call.kind === "subagent").map((call) => call.toolCallId));
    if (ids.size > 0) this.subagents.set(threadId, ids);
    else this.subagents.delete(threadId);
    if (previous !== this.hasBackgroundSubagent(threadId)) {
      for (const listener of this.listeners) listener(threadId);
    }
  }
}

function touchesBackgroundCalls(event: CanonicalAgentEventEnvelope): boolean {
  const payload = event.payload;
  if (["turn.completed", "turn.cancelled", "turn.interrupted", "turn.errored"].includes(payload.type)) return true;
  if (payload.type === "publication.recorded") return payload.event.type === "toolBackgrounded";
  if (payload.type !== "item.recorded" || payload.item.kind !== "tool-call") return false;
  const item = payload.item.payload;
  if (item.projection === "toolCall") return isBackgroundRecord(item.record);
  if (item.projection !== "narrativeRecovery" && item.projection !== "narrativeRecoveryDiscarded") return false;
  return isBackgroundNarrative(item.narrative);
}

function isBackgroundNarrative(narrative: unknown): boolean {
  return typeof narrative === "object" && narrative !== null && "record" in narrative && isBackgroundRecord(narrative.record);
}

function isBackgroundRecord(record: unknown): boolean {
  return typeof record === "object" && record !== null && "background" in record && record.background === true;
}
