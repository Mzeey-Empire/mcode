import type { AgentItem, CanonicalAgentEventEnvelope } from "@mcode/contracts/compat/agent-model";
import type { BackgroundCallKind } from "@mcode/contracts/models/tool-call-record";
import type { CanonicalAcceptedProgress } from "../canonical/canonical-accepted-progress.js";
import type { CanonicalAgentBoundary } from "../canonical/canonical-agent-boundary.js";
import { subscribeCommittedCanonicalEvents } from "../canonical/committed-canonical-events.js";
import type { AgentRuntimeAccess } from "../orchestration/turn-runtime-controller.js";

/** Server-authoritative running-agent occupancy, including calls that outlive turns. */
export interface AgentWorkload {
  /** Threads with a running turn or a running background subagent, each counted once. */
  count(): number;
  /** Visible threads with a running background subagent, read once so a caller checking many threads scans once. */
  backgroundSubagentThreadIds(): ReadonlySet<string>;
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
   * Visible threads with a running background subagent. A thread joins once its call is backgrounded, while its
   * launching turn may still run, because the turn's reservation can end before its ending is saved.
   */
  backgroundSubagentThreadIds(): ReadonlySet<string> {
    const threadIds = [...this.subagents.keys(), ...this.unsavedLaunchThreadIds()];
    return new Set(threadIds.filter((threadId) => !this.hidden.has(threadId)));
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
      const threads = new Set(events.filter((event) => touchesBackgroundCalls(event)).map((event) => event.routing.threadId));
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
    const running = this.backgroundSubagentThreadIds().has(threadId);
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
  const record = payload.type === "item.recorded" ? canonicalBackgroundRecord(payload.item) : undefined;
  return record?.background_kind === "subagent" && record.status === "running";
}

/** Read background metadata from both canonical tool records and recovery projections. */
export function canonicalBackgroundRecord(item: AgentItem): { id?: unknown; background_kind?: unknown; status?: unknown } | undefined {
  if (item.kind !== "tool-call") return undefined;
  const payload = item.payload;
  if (payload.projection === "toolCall") return backgroundRecord(payload.record);
  if (payload.projection !== "narrativeRecovery" && payload.projection !== "narrativeRecoveryDiscarded") return undefined;
  const narrative: unknown = payload.narrative;
  if (typeof narrative === "object" && narrative !== null && "record" in narrative) return backgroundRecord(narrative.record);
}

/** Match both the launch publication and canonical records written through late settlement. */
export function touchesBackgroundCalls(event: Pick<CanonicalAgentEventEnvelope, "payload">, kind?: BackgroundCallKind): boolean {
  const payload = event.payload;
  if (payload.type === "publication.recorded") {
    return payload.event.type === "toolBackgrounded" && (kind === undefined || payload.event.kind === kind);
  }
  if (payload.type !== "item.recorded") return false;
  const record = canonicalBackgroundRecord(payload.item);
  return record !== undefined && (kind === undefined || record.background_kind === kind);
}

function backgroundRecord(record: unknown) {
  if (typeof record !== "object" || record === null || !("background" in record) || record.background !== true) return undefined;
  return {
    id: "id" in record ? record.id : undefined,
    background_kind: "background_kind" in record ? record.background_kind : undefined,
    status: "status" in record ? record.status : undefined,
  };
}
