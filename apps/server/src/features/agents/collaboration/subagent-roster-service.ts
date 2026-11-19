import { inject, injectable } from "tsyringe";
import { SubagentRosterSchema, compareRosterEntries, isDelegateTaskToolName, isLiveSubagentStatus, type SubagentRoster, type SubagentRosterEntry, type SubagentDetail, type SubagentDetailRequest, type SubagentRosterRequest, type SubagentStatus } from "@mcode/contracts/models/subagent-roster";
import { ProviderIdSchema } from "@mcode/contracts/models/settings";
import { SUBAGENT_REPORTING, isChildTurnCancellable, type IAgentProvider, type IProviderRegistry, type ProviderId } from "@mcode/contracts/providers/interfaces";
import { type CanonicalSubagentStopRequest, type CanonicalSubagentStopResult } from "@mcode/contracts/models/canonical-subagent-roster";
import { type CanonicalAgentEventEnvelope } from "@mcode/contracts/compat/agent-model";
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
import { canonicalAgentThreads, messages, threads, toolCallRecords } from "../../../runtime/persistence/sqlite/schema.js";
import { NarrativeStore } from "../conversation/narrative/narrative-store.js";
import { broadcast } from "../../../application/transport/push.js";
import { narrativeRosterEntry, narrativeSubagentDetail, rootAgent, subagentStatusFrom, subagentTitle, type RosterToolCall } from "./subagent-roster-projection.js";
import { observesChildActivity, type CanonicalChildActivity, type CanonicalChildRow } from "../canonical/canonical-child-roster.js";
import { subscribeCommittedCanonicalEvents } from "../canonical/committed-canonical-events.js";
import type { DelegatedTaskService } from "../../thread-control/delegation/delegated-task-service.js";
import type { ThreadControlApprovalRepo } from "../../thread-control/authority/persistence/thread-control-approval-repo.js";
import type { ApprovalService } from "../approvals/approval-service.js";
import type { AgentWorkload } from "../workload/agent-workload.js";

type AcceptedSubagentProgress = Pick<import("../canonical/canonical-accepted-progress.js").CanonicalAcceptedProgress,
  "loadSubagentRoster" | "loadLiveSubagentChildren" | "liveSubagentParentIds" | "subagentOwningParent"
  | "loadSubagentStopTarget" | "loadActiveSubagentStopTargets" | "finishSubagentTurn" | "interruptSubagentTurns" | "onSubagentRosterChange">;
type DelegatedRoster = Pick<DelegatedTaskService, "rosterEntries" | "liveRosterStatuses" | "stopForUser" | "coordinatorsWithUnfinishedTasks">;
type DelegatedStopTarget = { tasks: Pick<DelegatedTaskService, "stopForUser">; entry: SubagentRosterEntry };

/** Owns server-authoritative sub-agent rosters and independent cancellation. */
@injectable()
export class SubagentRosterService {
  private readonly epoch = NodeCrypto.randomUUID();
  private readonly revisions = new Map<string, number>();
  private readonly canonicalRevisions = new Map<string, number>();
  private readonly pendingPushes = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<(parentId: string) => void>();
  private readonly stoppedCalls = new Map<string, Set<string>>();
  private readonly activeStops = new Map<string, Promise<CanonicalSubagentStopResult>>();
  private acceptedProgress: AcceptedSubagentProgress | undefined;
  private delegatedTasks: DelegatedRoster | undefined;
  private approvalService: Pick<ApprovalService, "listPendingApprovals"> | undefined;
  private controlApprovals: Pick<ThreadControlApprovalRepo, "listPendingByThread"> | undefined;

  constructor(
    @inject(SUBAGENT_LIFECYCLE_DURABILITY)
    private readonly durability: SubagentLifecycleDurability,
    @inject("IProviderRegistry") private readonly providers: IProviderRegistry,
    @inject(NarrativeStore) private readonly narrative: NarrativeStore,
    @inject("Database") private readonly db: Database,
    @inject("SubagentReporting", { isOptional: true }) private readonly reporting = SUBAGENT_REPORTING,
  ) {}

  /** Compose cross-provider tasks without a dependency cycle through AgentService. */
  bindDelegatedTasks(tasks: DelegatedRoster & Pick<DelegatedTaskService, "onRosterChanged">): () => void {
    this.delegatedTasks = tasks;
    return tasks.onRosterChanged((threadId) => this.changed(threadId));
  }

  /** Resolve controls through retained family identities before their saved rows exist. */
  bindAcceptedProgress(progress: AcceptedSubagentProgress): void {
    this.acceptedProgress = progress;
    progress.onSubagentRosterChange((threadId, revision, activityChanged) => this.canonicalChanged(threadId, revision, activityChanged));
  }

  /** Read both provider requests and thread-control waits for canonical children. */
  bindPendingInput(approvalService: Pick<ApprovalService, "listPendingApprovals">,
    controlApprovals: Pick<ThreadControlApprovalRepo, "listPendingByThread">): void {
    this.approvalService = approvalService;
    this.controlApprovals = controlApprovals;
  }

  /** Refresh the same parent roster when the workload's background calls change. */
  observeWorkload(workload: Pick<AgentWorkload, "onSubagentChange">): () => void {
    return workload.onSubagentChange((parentId) => this.changed(parentId));
  }

  /** Observe a debounced change at the same time as the roster broadcast. */
  onChanged(listener: (parentId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Refresh the owning roster when a canonical child's approval or question changes. */
  inputChanged(threadId: string): void {
    const parentId = this.canonicalParent(threadId);
    if (parentId) this.changed(parentId);
  }

  private canonicalParent(threadId: string): string | null {
    if (this.acceptedProgress) return this.acceptedProgress.subagentOwningParent(threadId);
    const row = drizzle(this.db).select({
      owner: canonicalAgentThreads.owningParentThreadId, parent: canonicalAgentThreads.parentThreadId,
    }).from(canonicalAgentThreads).where(eq(canonicalAgentThreads.id, threadId)).get();
    return row?.owner ?? row?.parent ?? null;
  }

  /** Read the live statuses of the parent's canonical children and delegated tasks. */
  loadLiveStatuses(parentId: string): SubagentStatus[] {
    const children = this.acceptedProgress?.loadLiveSubagentChildren(parentId)
      ?? this.durability.loadLiveSubagentChildren(parentId);
    // Foreground Agent calls belong to their turn, and the workload already tracks background calls.
    return [
      ...children.map((child) => this.canonicalStatus(child)).filter(isLiveSubagentStatus),
      ...this.delegatedTasks?.liveRosterStatuses(parentId) ?? [],
    ];
  }

  /** Include every parent with live canonical or delegated work, and the workload's background parents. */
  liveParentCandidates(backgroundParents: Iterable<string> = []): ReadonlySet<string> {
    return new Set([
      ...this.durability.liveSubagentParentIds(),
      ...this.acceptedProgress?.liveSubagentParentIds() ?? [],
      ...this.delegatedTasks?.coordinatorsWithUnfinishedTasks() ?? [],
      ...backgroundParents,
    ]);
  }

  /** Project one authoritative roster without mutating revisions or persisted state. */
  loadRoster(request: SubagentRosterRequest): SubagentRoster {
    const parentId = request.owningParentThreadId;
    const canonicalRequest = { owningParentThreadId: parentId, limit: 257 };
    const canonical = this.acceptedProgress?.loadSubagentRoster(canonicalRequest)
      ?? this.durability.loadSubagentRoster(canonicalRequest);
    const entries = this.projectEntries(parentId, [...canonical.active, ...canonical.done]);
    for (const entry of this.delegatedTasks?.rosterEntries(parentId) ?? []) entries.set(entry.id, entry);
    const ordered = [...entries.values()].sort(compareRosterEntries);
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
      const entry = narrativeRosterEntry(rootEvidence(call, calls, byId), steps.length, provider, this.reporting[provider]?.childSteps ?? false);
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
    if (call && (rootAgent(call, byId) || isDelegateTaskToolName(call.toolName))) this.changed(threadId);
  }

  /**
   * Invalidate from saved narrative tool calls. Worker-owned turns persist Agent calls and their steps without
   * passing through {@link toolChanged}, so the saved batch is the only live signal for those rosters.
   * A saved turn ending also refreshes: worker-owned turns write their tool-call rows in that same commit,
   * while the release that calls {@link turnFinished} runs once the ending is accepted, before it is saved.
   */
  observeCommittedEvents(subscribe = subscribeCommittedCanonicalEvents): () => void {
    return subscribe((events) => {
      for (const threadId of threadsWhere(events, touchesNarrativeRoster)) this.changed(threadId);
      for (const threadId of threadsWhere(events, observesChildActivity)) this.changed(threadId);
      for (const event of events) {
        if (event.payload.type === "child-thread.recorded") {
          this.changed(event.payload.childThread.owningParentThreadId ?? event.payload.parentThreadId);
        }
      }
      for (const threadId of threadsWhere(events, endsTurn)) this.turnFinished(threadId);
      for (const threadId of threadsWhere(events, (event) => endsTurn(event) || event.payload.type === "turn.started")) {
        this.inputChanged(threadId);
        const owner = drizzle(this.db).select({ id: threads.delegationCoordinatorThreadId }).from(threads)
          .where(eq(threads.id, threadId)).get()?.id;
        if (owner) this.changed(owner);
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

  private canonicalChanged(threadId: string, revision: number, activityChanged: boolean): void {
    if (!activityChanged && (this.canonicalRevisions.get(threadId) ?? 0) === revision) return;
    this.canonicalRevisions.set(threadId, revision);
    this.changed(threadId);
  }

  private changed(threadId: string): void {
    this.revisions.set(threadId, (this.revisions.get(threadId) ?? 0) + 1);
    if (this.pendingPushes.has(threadId)) return;
    const timer = setTimeout(() => {
      this.pendingPushes.delete(threadId);
      broadcast("subagents.changed", { threadId, epoch: this.epoch, revision: this.revisions.get(threadId) ?? 0 });
      for (const listener of this.listeners) listener(threadId);
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
    const status = this.canonicalStatus(row);
    return {
      ...canonicalEntryMetadata(row, narrative),
      id, provider: row.provider, status, tier: "transcript",
      canStop: isLiveSubagentStatus(status) && this.withStopAvailability(parentId, row).canStop,
      sourceToolCallId, childThreadId: row.id, sourceMessageId: narrative?.sourceMessageId ?? null,
      parentEntryId: canonicalParentEntryId(row, children),
    };
  }

  private canonicalStatus(row: CanonicalChildActivity): SubagentStatus {
    const awaitingFirstTurn = row.latestTurnStatus === null && row.endedAt === null && row.activityState === "Idle";
    const status = awaitingFirstTurn ? "setting-up" : subagentStatusFrom(row.latestTurnStatus ?? row.activityState);
    if (!isLiveSubagentStatus(status) || row.endedAt !== null) return status;
    return this.hasPendingInput(row.id) ? "needs-you" : status;
  }

  private hasPendingInput(threadId: string): boolean {
    const pending = this.approvalService?.listPendingApprovals(threadId) ?? [];
    if (pending.length > 0) return true;
    const control = this.controlApprovals?.listPendingByThread(threadId) ?? [];
    return control.length > 0;
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

  private findDelegatedStopTarget(request: CanonicalSubagentStopRequest): DelegatedStopTarget | null {
    const tasks = this.delegatedTasks;
    const entry = tasks?.rosterEntries(request.owningParentThreadId)
      .find((candidate) => candidate.childThreadId === request.childThreadId);
    return tasks && entry ? { tasks, entry } : null;
  }

  private async stopDelegated(
    request: CanonicalSubagentStopRequest,
    { tasks, entry }: DelegatedStopTarget,
  ): Promise<CanonicalSubagentStopResult> {
    try {
      if (!await tasks.stopForUser(request.owningParentThreadId, request.childThreadId)) {
        return this.failed(request.childThreadId, "The selected sub-agent does not belong to this thread.");
      }
    } catch (error) {
      return this.failed(request.childThreadId, error instanceof Error ? error.message : "Sub-agent interruption failed.");
    }
    return { childThreadId: request.childThreadId, status: entry.status === "running" || entry.status === "setting-up" ? "interrupted" : "already-terminal" };
  }

  private async stopOne(request: CanonicalSubagentStopRequest): Promise<CanonicalSubagentStopResult> {
    const delegated = this.findDelegatedStopTarget(request);
    if (delegated) return this.stopDelegated(request, delegated);
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
    // Model and effort describe one run, so they come from the same source.
    ...(narrative.model ? { model: narrative.model, reasoningEffort: narrative.reasoningEffort }
      : { model: fallback.model, reasoningEffort: fallback.reasoningEffort }),
  };
}

function canonicalMetadata(row: CanonicalChildRow) {
  return {
    title: subagentTitle(row.task?.split("\n")[0] ?? "Subagent task"), prompt: row.task ?? null,
    subagentType: row.identity ?? null, model: row.model ?? null, reasoningEffort: row.reasoning ?? null,
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

function threadsWhere(events: readonly CanonicalAgentEventEnvelope[],
  matches: (event: CanonicalAgentEventEnvelope) => boolean): Set<string> {
  return new Set(events.filter(matches).map((event) => event.routing.threadId));
}

const TURN_ENDINGS = new Set(["turn.completed", "turn.cancelled", "turn.interrupted", "turn.errored"]);

function endsTurn(event: CanonicalAgentEventEnvelope): boolean {
  return TURN_ENDINGS.has(event.payload.type);
}

function touchesNarrativeRoster(event: CanonicalAgentEventEnvelope): boolean {
  if (event.payload.type === "publication.recorded") {
    const publication = event.payload.event;
    return publication.type === "toolUse" && typeof publication.toolName === "string" && isDelegateTaskToolName(publication.toolName);
  }
  if (event.payload.type !== "item.recorded" || event.payload.item.kind !== "tool-call") return false;
  const { parentItemId, payload } = event.payload.item;
  // A late background result settles a call from an earlier turn as a saved toolCall item, outside any terminal.
  if (payload.projection === "toolCall") return isRosterToolName(toolName(payload.record));
  if (payload.projection !== "narrativeRecovery" && payload.projection !== "narrativeRecoveryDiscarded") return false;
  return parentItemId !== undefined || isRosterToolName(narrativeToolName(payload.narrative));
}

function isRosterToolName(name: unknown): boolean {
  return typeof name === "string" && (name === "Agent" || isDelegateTaskToolName(name));
}

function narrativeToolName(narrative: unknown): unknown {
  if (typeof narrative !== "object" || narrative === null || !("record" in narrative)) return undefined;
  return toolName(narrative.record);
}

function toolName(record: unknown): unknown {
  return typeof record === "object" && record !== null && "tool_name" in record ? record.tool_name : undefined;
}
