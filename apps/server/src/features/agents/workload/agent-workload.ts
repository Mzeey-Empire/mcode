import type { CanonicalAgentEventEnvelope } from "@mcode/contracts/compat/agent-model";
import type { CanonicalAcceptedProgress } from "../canonical/canonical-accepted-progress.js";
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

/** Maintains background occupancy from durable canonical changes, plus launches accepted but not yet saved. */
export class AgentWorkloadService implements AgentWorkload {
  private readonly subagents = new Map<string, Set<string>>();
  /** Threads listeners last heard hold a subagent, so an unsaved launch becoming saved is not a second change. */
  private readonly reported = new Set<string>();
  /**
   * Threads soft-deleted while their rows remain. Hiding is final, but a hidden thread's turn can keep running and
   * accepting launches until teardown reaches it, and `count` must not read SQLite to find that out.
   */
  private readonly hidden = new Set<string>();
  private readonly listeners = new Set<(threadId: string) => void>();

  constructor(
    private readonly runtime: Pick<AgentRuntimeAccess, "activeTurnThreadIds">,
    private readonly canonical: Pick<CanonicalAgentBoundary, "listRunningBackgroundSubagentIds" | "listMissingThreadIds">,
    private readonly accepted?: Pick<CanonicalAcceptedProgress, "unsavedThreadIds">,
  ) {}

  /** Read current occupancy without database access. */
  count(): number {
    const threadIds = [...this.runtime.activeTurnThreadIds(), ...this.subagents.keys(), ...this.unsavedLaunchThreadIds()];
    return new Set(threadIds.filter((threadId) => !this.hidden.has(threadId))).size;
  }

  /**
   * Whether the thread has a running background subagent. It turns true once the call is backgrounded, while its
   * launching turn may still run, because the turn's reservation can end before its ending is saved.
   */
  hasBackgroundSubagent(threadId: string): boolean {
    if (this.hidden.has(threadId)) return false;
    return this.subagents.has(threadId) || this.unsavedLaunchThreadIds().includes(threadId);
  }

  /** Subscribe to background occupancy transitions. */
  onSubagentChange(listener: (threadId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Observe saved background tool changes, including late results outside a turn. */
  observeCommittedEvents(subscribe = subscribeCommittedCanonicalEvents): () => void {
    return subscribe((events) => {
      // A late settlement also saves its tool call record with `background: true`, so tool
      // results need no separate check.
      const threads = new Set(events.filter(touchesBackgroundCalls).map((event) => event.routing.threadId));
      for (const threadId of threads) this.refresh(threadId);
    });
  }

  /**
   * Record newly hidden threads, then re-read every thread holding a subagent. Deletion hides or removes a thread's
   * rows and discards its unsaved writes, so no saved event ever reports that its calls stopped. A deletion can also
   * remove child threads its caller never listed, so tracked threads are re-read rather than trusted.
   */
  refreshTracked(hiddenThreadIds: readonly string[] = []): void {
    for (const threadId of hiddenThreadIds) this.hidden.add(threadId);
    // Only a removed row ends hiding: a failed deletion, or a workspace deletion that keeps worktree threads for
    // cleanup, leaves the thread hidden.
    for (const threadId of this.canonical.listMissingThreadIds([...this.hidden])) this.hidden.delete(threadId);
    for (const threadId of new Set([...this.subagents.keys(), ...this.reported])) this.refresh(threadId);
  }

  private refresh(threadId: string): void {
    const ids = new Set(this.canonical.listRunningBackgroundSubagentIds(threadId));
    if (ids.size > 0) this.subagents.set(threadId, ids);
    else this.subagents.delete(threadId);
    // Accepting a launch notifies no one: readers see it live, and the parent's settled turn republishes attention.
    const running = this.hasBackgroundSubagent(threadId);
    if (running === this.reported.has(threadId)) return;
    if (running) this.reported.add(threadId);
    else this.reported.delete(threadId);
    for (const listener of this.listeners) listener(threadId);
  }

  /** A turn's reservation ends without waiting for its writes, so a launch still queued for SQLite counts from here. */
  private unsavedLaunchThreadIds(): string[] {
    return this.accepted?.unsavedThreadIds(launchesBackgroundSubagent) ?? [];
  }
}

/** An unsaved event that starts a subagent; background commands and settlements never hold occupancy. */
function launchesBackgroundSubagent(event: Pick<CanonicalAgentEventEnvelope, "payload">): boolean {
  const payload = event.payload;
  if (payload.type === "publication.recorded") {
    return payload.event.type === "toolBackgrounded" && payload.event.kind === "subagent";
  }
  const record = toolCallRecordOf(event);
  return isBackgroundRecord(record) && "background_kind" in record && record.background_kind === "subagent"
    && "status" in record && record.status === "running";
}

function toolCallRecordOf(event: Pick<CanonicalAgentEventEnvelope, "payload">): unknown {
  const payload = event.payload;
  if (payload.type !== "item.recorded" || payload.item.kind !== "tool-call") return undefined;
  const item = payload.item.payload;
  if (item.projection === "toolCall") return item.record;
  if (item.projection !== "narrativeRecovery" && item.projection !== "narrativeRecoveryDiscarded") return undefined;
  const narrative: unknown = item.narrative;
  return typeof narrative === "object" && narrative !== null && "record" in narrative ? narrative.record : undefined;
}

function touchesBackgroundCalls(event: Pick<CanonicalAgentEventEnvelope, "payload">): boolean {
  const payload = event.payload;
  if (payload.type === "publication.recorded") return payload.event.type === "toolBackgrounded";
  return isBackgroundRecord(toolCallRecordOf(event));
}

function isBackgroundRecord(record: unknown): record is object {
  return typeof record === "object" && record !== null && "background" in record && record.background === true;
}
