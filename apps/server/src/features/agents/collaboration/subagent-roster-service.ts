import { inject, injectable } from "tsyringe";
import {
  SubagentRosterSchema, ProviderIdSchema, SUBAGENT_REPORTING,
  isChildTurnCancellable,
  type SubagentRoster, type SubagentRosterEntry, type SubagentDetail, type SubagentDetailRequest,
  type SubagentRosterRequest,
  type CanonicalSubagentStopRequest,
  type CanonicalSubagentStopResult,
  type IAgentProvider,
  type IProviderRegistry,
  type ProviderId,
  type CanonicalAgentEventEnvelope,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import {
  SUBAGENT_LIFECYCLE_DURABILITY,
  type SubagentLifecycleDurability,
  type SubagentStopTarget,
} from "./subagent-lifecycle-durability.js";

import * as NodeCrypto from "node:crypto";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { and, eq, inArray, ne, or } from "drizzle-orm";
import { messages, threads, toolCallRecords } from "../../../runtime/persistence/sqlite/schema.js";
import { NarrativeStore } from "../conversation/narrative/narrative-store.js";
import { broadcast } from "../../../application/transport/push.js";
import { narrativeRosterEntry, narrativeSubagentDetail, rootAgent, subagentStatusFrom, subagentModelLabel, type RosterToolCall } from "./subagent-roster-projection.js";
import type { CanonicalChildRow } from "../canonical/canonical-child-roster.js";
import { subscribeCommittedCanonicalEvents } from "../canonical/committed-canonical-events.js";

type AcceptedSubagentProgress = Pick<import("../canonical/canonical-accepted-progress.js").CanonicalAcceptedProgress,
  "loadSubagentRoster" | "loadSubagentStopTarget" | "loadActiveSubagentStopTargets" | "finishSubagentTurn" | "interruptSubagentTurns" | "onSubagentRosterChange">;

/** Owns server-authoritative sub-agent rosters and independent cancellation. */
@injectable()
export class SubagentRosterService {
  private readonly epoch = NodeCrypto.randomUUID();
  private readonly revisions = new Map<string, number>();
  private readonly canonicalRevisions = new Map<string, number>();
  private readonly pendingPushes = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly stoppedCalls = new Map<string, Set<string>>();
  private readonly activeStops = new Map<string, Promise<CanonicalSubagentStopResult>>();
  private acceptedProgress: AcceptedSubagentProgress | undefined;

  constructor(
    @inject(SUBAGENT_LIFECYCLE_DURABILITY)
    private readonly durability: SubagentLifecycleDurability,
    @inject("IProviderRegistry") private readonly providers: IProviderRegistry,
    @inject(NarrativeStore) private readonly narrative: NarrativeStore,
    @inject("Database") private readonly db: Database,
  ) {}

  /** Resolve controls through retained family identities before their saved rows exist. */
  bindAcceptedProgress(progress: AcceptedSubagentProgress): void {
    this.acceptedProgress = progress;
    progress.onSubagentRosterChange((threadId, revision) => this.canonicalChanged(threadId, revision));
  }

  /** Project one authoritative roster without mutating revisions or persisted state. */
  loadRoster(request: SubagentRosterRequest): SubagentRoster {
    const parentId = request.owningParentThreadId;
    const canonicalRequest = { owningParentThreadId: parentId, limit: 257 };
    const canonical = this.acceptedProgress?.loadSubagentRoster(canonicalRequest)
      ?? this.durability.loadSubagentRoster(canonicalRequest);
    const entries = this.projectEntries(parentId, [...canonical.active, ...canonical.done]);
    const ordered = [...entries.values()].sort((left, right) =>
      Number(right.status === "running") - Number(left.status === "running")
      || right.startedAt.localeCompare(left.startedAt) || left.id.localeCompare(right.id));
    return SubagentRosterSchema().parse({
      owningParentThreadId: parentId, epoch: this.epoch, revision: this.revisions.get(parentId) ?? 0,
      entries: ordered.slice(0, 256), truncated: ordered.length > 256,
    });
  }

  private projectEntries(parentId: string, children: readonly CanonicalChildRow[]): Map<string, SubagentRosterEntry> {
    const calls = this.callsFor(parentId);
    const byId = new Map(calls.map((call) => [call.toolCallId, call]));
    const fallback = this.threadProvider(parentId);
    const entries = new Map<string, SubagentRosterEntry>();
    const roots = calls.filter((call) => call.toolName === "Agent" && rootAgent(call, byId)?.toolCallId === call.toolCallId);
    for (const call of roots) {
      const provider = ProviderIdSchema.safeParse(call.provider).data ?? fallback;
      const steps = this.stepsFor(call.toolCallId, calls, byId);
      const entry = narrativeRosterEntry(rootEvidence(call, calls, byId), steps.length, provider, SUBAGENT_REPORTING[provider]?.childSteps ?? false);
      entries.set(entry.id, entry);
    }
    for (const child of children) {
      const sourceId = canonicalSourceCall(child, byId);
      const id = sourceId ? `call:${sourceId}` : `child:${child.id}`;
      entries.set(id, this.canonicalEntry(parentId, child, entries.get(id), id, sourceId, children));
    }
    return entries;
  }

  /** Load the last 32 steps only for an entry that belongs to this parent and supports steps. */
  loadDetail(request: SubagentDetailRequest): SubagentDetail {
    const entry = this.loadRoster(request).entries.find((row) => row.id === request.entryId);
    if (!entry || entry.tier !== "steps") throw new Error("Subagent steps are unavailable");
    const calls = this.callsFor(request.owningParentThreadId);
    const byId = new Map(calls.map((call) => [call.toolCallId, call]));
    const root = entry.sourceToolCallId ? byId.get(entry.sourceToolCallId) : undefined;
    if (!root) throw new Error("Subagent source call is unavailable");
    return narrativeSubagentDetail(entry.id, rootEvidence(root, calls, byId), this.stepsFor(root.toolCallId, calls, byId));
  }

  /** Invalidate after an applied Agent event or one of its descendant tool events. */
  toolChanged(threadId: string, toolCallId: string): void {
    const buffered = this.narrative.getBufferedToolCalls(threadId);
    const calls = buffered.length > 0 ? buffered : this.callsFor(threadId);
    const byId = new Map(calls.map((call) => [call.toolCallId, call]));
    const call = byId.get(toolCallId);
    if (call && rootAgent(call, byId)) this.changed(threadId);
  }

  /**
   * Invalidate from saved narrative tool calls. Worker-owned turns persist Agent calls and their steps without
   * passing through {@link toolChanged}, so the saved batch is the only live signal for those rosters.
   */
  observeCommittedEvents(subscribe = subscribeCommittedCanonicalEvents): () => void {
    return subscribe((events) => {
      for (const threadId of new Set(events.filter(touchesNarrativeRoster).map((event) => event.routing.threadId))) {
        this.changed(threadId);
      }
    });
  }

  /** Refresh terminal outcomes after narrative persistence completes. */
  turnFinished(threadId: string): void {
    this.clearPersistedStops(threadId);
    if (this.narrative.hasSubagentCalls(threadId)) this.changed(threadId);
  }

  private clearPersistedStops(threadId: string): void {
    const stopped = this.stoppedCalls.get(threadId);
    if (!stopped) return;
    const terminal = drizzle(this.db).select({ id: toolCallRecords.id }).from(toolCallRecords)
      .innerJoin(messages, eq(messages.id, toolCallRecords.messageId))
      .where(and(eq(messages.threadId, threadId), inArray(toolCallRecords.id, [...stopped]),
        or(ne(toolCallRecords.status, "running"), inArray(messages.outcome, ["cancelled", "interrupted"])))).all();
    for (const call of terminal) stopped.delete(call.id);
    if (stopped.size === 0) this.stoppedCalls.delete(threadId);
  }

  private canonicalChanged(threadId: string, revision: number): void {
    if ((this.canonicalRevisions.get(threadId) ?? 0) === revision) return;
    this.canonicalRevisions.set(threadId, revision);
    this.changed(threadId);
  }

  private changed(threadId: string): void {
    this.revisions.set(threadId, (this.revisions.get(threadId) ?? 0) + 1);
    if (this.pendingPushes.has(threadId)) return;
    const timer = setTimeout(() => {
      this.pendingPushes.delete(threadId);
      broadcast("subagents.changed", { threadId, epoch: this.epoch, revision: this.revisions.get(threadId) ?? 0 });
    }, 250);
    timer.unref();
    this.pendingPushes.set(threadId, timer);
  }

  private callsFor(threadId: string): RosterToolCall[] {
    return this.narrative.loadSubagentCalls(threadId).map((call) => ({
      ...call, parentStopped: call.parentStopped || (this.stoppedCalls.get(threadId)?.has(call.toolCallId) ?? false),
    }));
  }

  private threadProvider(threadId: string): ProviderId {
    const row = drizzle(this.db).select({ provider: threads.provider }).from(threads).where(eq(threads.id, threadId)).get();
    if (!row) throw new Error("Subagent parent thread not found");
    const provider = ProviderIdSchema.safeParse(row.provider);
    if (!provider.success) throw new Error("Subagent parent thread provider is unavailable");
    return provider.data;
  }

  private stepsFor(id: string, calls: readonly RosterToolCall[], byId: ReadonlyMap<string, RosterToolCall>): RosterToolCall[] {
    return calls.filter((call) => call.toolName !== "Agent" && rootAgent(call, byId)?.toolCallId === id);
  }

  private canonicalEntry(parentId: string, row: CanonicalChildRow, narrative: SubagentRosterEntry | undefined,
    id: string, sourceToolCallId: string | null, children: readonly CanonicalChildRow[]): SubagentRosterEntry {
    const status = subagentStatusFrom(row.latestTurnStatus ?? row.activityState);
    return {
      ...canonicalEntryMetadata(row, narrative),
      id, provider: row.provider, status, tier: "transcript",
      canStop: status === "running" && this.withStopAvailability(parentId, row).canStop,
      sourceToolCallId, childThreadId: row.id, sourceMessageId: narrative?.sourceMessageId ?? null,
      parentEntryId: canonicalParentEntryId(row, children),
    };
  }

  /** Stop one owned sub-agent turn without stopping its provider session. */
  async stop(request: CanonicalSubagentStopRequest): Promise<CanonicalSubagentStopResult> {
    const key = `${request.owningParentThreadId}:${request.childThreadId}`;
    const existing = this.activeStops.get(key);
    if (existing) return existing;
    const operation = this.stopOne(request);
    this.activeStops.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.activeStops.get(key) === operation) this.activeStops.delete(key);
    }
  }

  /** Stop every active descendant before its parent terminalizes. */
  async stopDescendants(owningParentThreadId: string): Promise<void> {
    const stopped = this.stoppedCalls.get(owningParentThreadId) ?? new Set<string>();
    for (const call of this.callsFor(owningParentThreadId)) {
      if (call.status === "running") stopped.add(call.toolCallId);
    }
    if (stopped.size > 0) this.stoppedCalls.set(owningParentThreadId, stopped);
    this.turnFinished(owningParentThreadId);
    const targets = (this.acceptedProgress?.loadActiveSubagentStopTargets(owningParentThreadId)
      ?? this.durability.loadActiveSubagentStopTargets(owningParentThreadId))
      .filter((target) => target.latestTurn?.status === "Running");
    await Promise.allSettled(targets.map((target) => this.stop({
      owningParentThreadId,
      childThreadId: target.childThread.id,
    })));
    const ids = targets.map((target) => target.childThread.id);
    if (!this.acceptedProgress?.interruptSubagentTurns(ids, "Interrupted by parent stop")) {
      await this.durability.interruptSubagentTurns(ids, "Interrupted by parent stop");
    }
  }

  private withStopAvailability(
    owningParentThreadId: string,
    row: CanonicalChildRow,
  ): CanonicalChildRow {
    const target = this.loadStopTarget({
      owningParentThreadId,
      childThreadId: row.id,
    });
    if (!this.canAddress(target)) return row;
    try {
      return isChildTurnCancellable(this.providers.resolve(ProviderIdSchema.parse(target.childThread.providerId)))
        ? { ...row, canStop: true }
        : row;
    } catch {
      return row;
    }
  }

  private async stopOne(request: CanonicalSubagentStopRequest): Promise<CanonicalSubagentStopResult> {
    const target = this.loadStopTarget(request);
    if (!target) return this.failed(request.childThreadId, "The selected sub-agent does not belong to this thread.");
    if (target.latestTurn?.status !== "Running") {
      return { childThreadId: request.childThreadId, status: "already-terminal" };
    }
    if (!this.canAddress(target)) {
      return { childThreadId: request.childThreadId, status: "unsupported", message: "The active sub-agent has no exact provider identity." };
    }
    const provider = this.resolveProvider(target, request.childThreadId);
    if (!provider || !isChildTurnCancellable(provider)) {
      return { childThreadId: request.childThreadId, status: "unsupported", message: "The sub-agent provider cannot cancel this turn independently." };
    }
    try {
      await provider.interruptChildTurn(
        `mcode-${request.owningParentThreadId}`,
        target.nativeThreadId,
        target.nativeTurnId,
      );
    } catch {
      logger.warn("Sub-agent interruption failed", {
        category: "provider-interrupt-failed",
        owningParentThreadId: request.owningParentThreadId,
        childThreadId: request.childThreadId,
        providerId: target.childThread.providerId,
      });
      return this.failed(request.childThreadId, "Sub-agent interruption failed.");
    }
    const input = {
      childThreadId: request.childThreadId,
      nativeTurnId: target.nativeTurnId,
      outcome: "interrupted" as const,
      error: "Interrupted by user",
    };
    const finished = await this.finishStop(input);
    return {
      childThreadId: request.childThreadId,
      status: finished.status === "Interrupted" ? "interrupted" : "already-terminal",
    };
  }

  private async finishStop(input: Parameters<SubagentLifecycleDurability["finishSubagentTurn"]>[0]): Promise<{ status: string }> {
    return this.acceptedProgress?.finishSubagentTurn(input) ?? this.durability.finishSubagentTurn(input);
  }

  private loadStopTarget(request: CanonicalSubagentStopRequest): SubagentStopTarget | null {
    const accepted = this.acceptedProgress?.loadSubagentStopTarget(request);
    return accepted === undefined ? this.durability.loadSubagentStopTarget(request) : accepted;
  }

  private canAddress(target: SubagentStopTarget | null): target is SubagentStopTarget & {
    nativeThreadId: string;
    nativeTurnId: string;
  } {
    return target !== null && target.nativeThreadId !== null && target.nativeTurnId !== null;
  }

  private resolveProvider(target: SubagentStopTarget, childThreadId: string): IAgentProvider | null {
    try {
      return this.providers.resolve(ProviderIdSchema.parse(target.childThread.providerId));
    } catch {
      logger.debug("Sub-agent provider unavailable", { childThreadId, providerId: target.childThread.providerId });
      return null;
    }
  }

  private failed(childThreadId: string, message: string): CanonicalSubagentStopResult {
    return { childThreadId, status: "failed", message };
  }
}


function canonicalSourceCall(row: CanonicalChildRow, calls: ReadonlyMap<string, RosterToolCall>): string | null {
  if (!row.sourceItemId?.startsWith("toolCall:")) return null;
  const callId = row.sourceItemId.slice(9);
  const source = calls.get(callId);
  return source ? rootAgent(source, calls)?.toolCallId ?? callId : callId;
}

function canonicalParentEntryId(row: CanonicalChildRow, children: readonly CanonicalChildRow[]): string | null {
  const parent = children.find((child) => child.id === row.parentThreadId);
  if (!parent) return null;
  return parent.sourceItemId?.startsWith("toolCall:") ? `call:${parent.sourceItemId.slice(9)}` : `child:${parent.id}`;
}

function canonicalEntryMetadata(row: CanonicalChildRow, narrative: SubagentRosterEntry | undefined) {
  return {
    ...canonicalDisplayMetadata(row, narrative),
    stepCount: Math.max(narrative?.stepCount ?? 0, row.stepCount),
    startedAt: narrative?.startedAt ?? row.startedAt, endedAt: row.endedAt,
  };
}

function canonicalDisplayMetadata(row: CanonicalChildRow, narrative: SubagentRosterEntry | undefined) {
  const fallback = canonicalMetadata(row);
  if (!narrative) return fallback;
  return {
    title: narrative.title === "Subagent task" ? fallback.title : narrative.title,
    prompt: narrative.prompt ?? fallback.prompt, subagentType: narrative.subagentType ?? fallback.subagentType,
    model: narrative.model ?? fallback.model,
  };
}

function canonicalMetadata(row: CanonicalChildRow) {
  return {
    title: row.task?.split("\n")[0] ?? "Subagent task", prompt: row.task ?? null,
    subagentType: row.identity ?? null, model: subagentModelLabel(row.model, row.reasoning),
  };
}

function rootEvidence(root: RosterToolCall, calls: readonly RosterToolCall[], byId: ReadonlyMap<string, RosterToolCall>): RosterToolCall {
  const agents = calls.filter((call) => call.toolName === "Agent" && rootAgent(call, byId)?.toolCallId === root.toolCallId);
  const latest = [...agents].sort((left, right) =>
    (right.completedAt ?? right.startedAt).localeCompare(left.completedAt ?? left.startedAt))[0] ?? root;
  const running = agents.some((call) => call.status === "running");
  return {
    ...root,
    status: running ? "running" : latest.status,
    parentStopped: root.parentStopped || agents.some((call) => call.parentStopped),
    outputSummary: latest.outputSummary || root.outputSummary,
    completedAt: running ? undefined : latest.completedAt ?? root.completedAt,
  };
}

function touchesNarrativeRoster(event: CanonicalAgentEventEnvelope): boolean {
  if (event.payload.type !== "item.recorded" || event.payload.item.kind !== "tool-call") return false;
  const { parentItemId, payload } = event.payload.item;
  if (payload.projection !== "narrativeRecovery" && payload.projection !== "narrativeRecoveryDiscarded") return false;
  return parentItemId !== undefined || narrativeToolName(payload.narrative) === "Agent";
}

function narrativeToolName(narrative: unknown): unknown {
  if (typeof narrative !== "object" || narrative === null || !("record" in narrative)) return undefined;
  const { record } = narrative;
  return typeof record === "object" && record !== null && "tool_name" in record ? record.tool_name : undefined;
}
