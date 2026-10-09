import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import {
  AgentEventSchema, AgentEventType, CANONICAL_SUBAGENT_TASK_MAX_LENGTH, MessageSchema, createAgentModelState, resolveSubagentDisplayName, resolveSubagentMetadata,
  type AgentEvent,
  type AgentItem, type AgentModelState, type AgentThread, type AgentTurn, type CollaborationAction, type Message,
  type ProviderIdentity, type TurnOutcome,
} from "@mcode/contracts";
import { CodexCollaborationEventAdapter } from "../collaboration/adapters/codex-collaboration-event-adapter.js";
import type {
  CanonicalChildTurnFinishInput, CodexChildDelegation, CodexChildDelegationInput, CodexChildDeliveryInput,
  CodexChildIdentityInput, CodexChildItemInput, CodexChildRetryInput, CodexChildRoutingDiagnosticInput,
  CodexChildTurnFinishInput, CodexChildTurnStartInput, CodexCollaborationActionInput,
  CodexCollaborationDurability,
} from "../collaboration/codex-collaboration-durability.js";
import type { ExecutionIdentity } from "../execution/execution-mailbox-protocol.js";
import { sanitizePublicToolInput } from "../tools/input/public-tool-input.js";
import type { ProviderEventProjection } from "../../providers/composition/provider-event-adapter.js";
import type { ProviderEventIngressEvent } from "../../providers/composition/provider-event-ingress.js";

const MAX_CHANGES = 256;
const MAX_CHANGE_BYTES = 2 * 1024 * 1024;
const TERMINAL_STATUS = { completed: "Completed", cancelled: "Cancelled", interrupted: "Interrupted", errored: "Errored" } as const;

/** Exact domain ownership; the acceptance wrapper supplies the lease and stream ordering. */
export interface AcceptedCollaborationContext {
  readonly sourceExecution: ExecutionIdentity;
  readonly parentExecution: ExecutionIdentity;
}

/** Assigned domain records, ordered as observed, without canonical envelopes or provider commands. */
export type AcceptedCollaborationChange = AcceptedCollaborationContext & (
  | { readonly kind: "thread-recorded"; readonly thread: AgentThread }
  | { readonly kind: "thread-bound"; readonly parentThreadId: string; readonly childThread: AgentThread; readonly identity: ProviderIdentity }
  | { readonly kind: "turn-started"; readonly turn: AgentTurn }
  | { readonly kind: "turn-terminal"; readonly turn: AgentTurn; readonly outcome: TurnOutcome; readonly error?: string }
  | { readonly kind: "item-recorded"; readonly item: AgentItem }
  | { readonly kind: "action-recorded"; readonly action: CollaborationAction }
  | { readonly kind: "diagnostic"; readonly diagnostic: CodexChildRoutingDiagnosticInput; readonly item: AgentItem }
);

type StateMapName = "threads" | "turns" | "items" | "collaborationActions";
type IndexName = "nativeThreads" | "nativeTurns" | "executions" | "delegations" | "receivers" | "nativeActions";
type CollaborationIndexes = Record<IndexName, Map<string, ReadonlySet<string>>>;
type PreparationCheckpoint = { readonly state: AgentModelState; readonly indexes: CollaborationIndexes };

/**
 * Interprets Codex collaboration against accepted domain state. Prepare on a fork and install
 * that candidate only after admission. This helper owns its collaboration indexes; other accepted
 * parent records can be supplied to the next fork without reindexing ordinary history.
 */
export class AcceptedCodexCollaboration implements CodexCollaborationDurability {
  private state: AgentModelState;
  private readonly adapter: CodexCollaborationEventAdapter;
  private changes: AcceptedCollaborationChange[] = [];
  private indexes: CollaborationIndexes = { nativeThreads: new Map(), nativeTurns: new Map(), executions: new Map(),
    delegations: new Map(), receivers: new Map(), nativeActions: new Map() };
  private readonly ownedStateMaps = new Set<StateMapName>();
  private readonly ownedIndexes = new Set<IndexName>();

  constructor(hydrated: AgentModelState) {
    this.state = hydrated;
    for (const thread of Object.values(hydrated.threads)) this.indexThread(thread);
    for (const turn of Object.values(hydrated.turns)) this.indexTurn(turn);
    for (const action of Object.values(hydrated.collaborationActions)) this.indexAction(action);
    this.releaseOwnership();
    this.adapter = new CodexCollaborationEventAdapter(this);
  }

  /** Shares immutable records/indexes; supplied accepted records refresh reads without a history scan. */
  fork(currentAcceptedState?: AgentModelState): AcceptedCodexCollaboration {
    const candidate = new AcceptedCodexCollaboration(createAgentModelState());
    this.releaseOwnership();
    candidate.state = currentAcceptedState ?? this.state;
    candidate.indexes = this.indexes;
    return candidate;
  }

  /** Returns the adapter's sanitized projection and at most 256 changes within 2 MiB. */
  prepare(input: ProviderEventIngressEvent): { projection: ProviderEventProjection; changes: readonly AcceptedCollaborationChange[] } {
    const before = this.beginPreparation();
    try {
      const projection = publicProjection(this.adapter.project(input));
      if (projection.status === "rejected") this.retainDiagnosticChanges(before);
      return { projection, changes: this.preparedChanges() };
    } catch (error) {
      this.restoreState(before);
      this.changes = [];
      throw error;
    }
  }

  /** Prepares an owner interruption for the exact running child, without dispatching its native Stop. */
  prepareChildInterruption(input: {
    readonly childThreadId: string;
    readonly nativeTurnId?: string;
    readonly error: string;
  }): { turn: AgentTurn | null; changes: readonly AcceptedCollaborationChange[] } {
    const before = this.beginPreparation();
    try {
      const turn = this.interruptibleChildTurn(input);
      if (!turn || isTerminal(turn)) return { turn, changes: [] };
      this.settleInterruptedChildItems(turn, input.error);
      const finished = input.nativeTurnId === undefined
        ? this.finishCanonicalChildTurn({ childThreadId: turn.threadId, outcome: "interrupted", error: input.error })
        : this.finishCodexChildTurn({ childThreadId: turn.threadId, nativeTurnId: input.nativeTurnId, outcome: "interrupted", error: input.error });
      return { turn: finished, changes: this.preparedChanges() };
    } catch (error) {
      this.restoreState(before);
      this.changes = [];
      throw error;
    }
  }

  private interruptibleChildTurn(input: { childThreadId: string; nativeTurnId?: string }): AgentTurn | null {
    if (!this.loadThread(input.childThreadId)?.parentThreadId) return null;
    const turn = this.activeTurn(input.childThreadId) ?? this.loadLatestTurn(input.childThreadId);
    if (!turn || turn.status !== "Running" && !isTerminal(turn)) return null;
    if (input.nativeTurnId !== undefined
      && this.loadTurnByProviderIdentity(input.childThreadId, nativeIdentity("turn", input.nativeTurnId))?.id !== turn.id) return null;
    return turn;
  }

  private settleInterruptedChildItems(turn: AgentTurn, error: string): void {
    const items = Object.values(this.state.items).filter((item) => item.turnId === turn.id && item.threadId === turn.threadId);
    const completedTools = new Set(items.filter((item) => item.payload.projection === "codexChildToolResult")
      .map((item) => childNativeItemId(item)));
    const context = this.context(turn);
    const now = timestamp();
    for (const item of items) {
      if (item.payload.projection === "message") this.stampInterruptedChildMessage(item, turn, context, now);
      if (item.payload.projection === "codexChildToolCall" && !completedTools.has(childNativeItemId(item))) {
        this.recordInterruptedToolResult(item, context, error, now);
        completedTools.add(childNativeItemId(item));
      }
      if (this.changes.length > MAX_CHANGES) throw new Error("Accepted Codex collaboration exceeds its change limit");
    }
  }

  private stampInterruptedChildMessage(item: AgentItem, turn: AgentTurn, context: AcceptedCollaborationContext, now: string): void {
    const message = MessageSchema().parse(item.payload.message);
    if (message.role !== "assistant") return;
    this.recordItem({ ...item, payload: { ...item.payload, message: {
      ...message, outcome: "interrupted", outcomeExecutionId: this.execution(turn).executionId, is_internal: false,
    } }, updatedAt: now }, context);
  }

  private recordInterruptedToolResult(item: AgentItem, context: AcceptedCollaborationContext, error: string, now: string): void {
    const nativeItemId = childNativeItemId(item);
    this.recordItem({ ...item, id: `item:codex-child:${hash(`${item.turnId}:${nativeItemId}:interrupted:tool-result`)}`,
      kind: "tool-result", payload: { projection: "codexChildToolResult", nativeItemId, eventKey: "interrupted",
        output: error, isError: true }, createdAt: now, updatedAt: now }, context);
  }

  private retainDiagnosticChanges(before: PreparationCheckpoint): void {
    const diagnostics = this.changes.filter((change) => change.kind === "diagnostic");
    this.restoreState(before);
    this.changes = diagnostics;
    for (const change of diagnostics) this.putItem(change.item);
  }

  private beginPreparation(): PreparationCheckpoint {
    const checkpoint = { state: this.state, indexes: this.indexes };
    this.releaseOwnership();
    this.changes = [];
    return checkpoint;
  }

  private preparedChanges(): readonly AcceptedCollaborationChange[] {
    if (this.changes.length > MAX_CHANGES || Buffer.byteLength(JSON.stringify(this.changes)) > MAX_CHANGE_BYTES) {
      throw new Error("Accepted Codex collaboration exceeds its change limit");
    }
    return [...this.changes];
  }

  private restoreState(before: PreparationCheckpoint): void {
    this.state = before.state;
    this.indexes = before.indexes;
    this.releaseOwnership();
  }

  private releaseOwnership(): void {
    this.ownedStateMaps.clear();
    this.ownedIndexes.clear();
  }

  loadThread(id: string): AgentThread | null { return this.state.threads[id] ?? null; }
  loadTurn(id: string): AgentTurn | null { return this.state.turns[id] ?? null; }
  loadThreadByProviderIdentity(identity: ProviderIdentity): AgentThread | null {
    return this.loadThread(unique(this.indexes.nativeThreads, identityKey(identity), "Codex native thread") ?? "");
  }
  loadTurnByExecution(id: string): AgentTurn | null {
    if (!this.indexes.executions.has(id)) {
      for (const turn of Object.values(this.state.turns)) if (turn.executionId === id) this.indexTurn(turn);
    }
    return this.loadTurn(unique(this.indexes.executions, id, "Codex execution") ?? "");
  }
  loadTurnByProviderIdentity(threadId: string, identity: ProviderIdentity): AgentTurn | null {
    return this.loadTurn(unique(this.indexes.nativeTurns, `${threadId}:${identityKey(identity)}`, "Codex native turn") ?? "");
  }
  loadLatestTurn(threadId: string): AgentTurn | null {
    return Object.values(this.state.turns).filter((turn) => turn.threadId === threadId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))[0] ?? null;
  }
  loadExecutionIdForTurn(turnId: string): string { return this.execution(this.requireTurn(turnId)).executionId; }
  loadCollaborationActionBySourceProviderIdentity(threadId: string, turnId: string, identity: ProviderIdentity): CollaborationAction | null {
    const id = unique(this.indexes.nativeActions, `${threadId}:${turnId}:${identityKey(identity)}`, "Codex native action");
    return id ? this.state.collaborationActions[id] ?? null : null;
  }
  loadCodexChildDelegation(threadId: string, itemId: string): CodexChildDelegation | null {
    return this.delegation(unique(this.indexes.delegations, `${threadId}:${itemId}`, "Codex delegation"));
  }
  loadCodexChildDelegationByReceiverThreadId(nativeId: string): CodexChildDelegation | null {
    return this.delegation(unique(this.indexes.receivers, nativeId, "Codex receiver"));
  }

  startCodexChildDelegation(input: CodexChildDelegationInput): CodexChildDelegation {
    const parent = this.requireTurn(input.parentTurnId);
    this.assertExecution(parent, input.parentThreadId, input.parentExecutionId);
    const existing = this.loadCodexChildDelegation(input.parentThreadId, input.parentItemId);
    if (existing) return this.updateDelegation(existing, input);
    const parentThread = this.requireThread(input.parentThreadId);
    const now = timestamp();
    const child: AgentThread = { id: `thread:codex-child:${NodeCrypto.randomUUID()}`,
      workspaceId: parentThread.workspaceId, parentThreadId: parentThread.id, rootThreadId: parentThread.rootThreadId,
      owningParentThreadId: parentThread.owningParentThreadId ?? parentThread.id, providerId: "codex", providerIdentities: [],
      activityState: "Starting", conversationRevision: 0, rosterRevision: 0, createdAt: now, updatedAt: now };
    const metadata = delegationMetadata(input);
    const item: AgentItem = { id: input.parentItemId, threadId: parentThread.id, turnId: parent.id, kind: "tool-call",
      providerIdentities: [...input.providerIdentities], payload: { projection: "codexSubagent", toolName: "Agent",
        childThreadId: child.id, receiverThreadIds: [...new Set(input.receiverThreadIds ?? [])], ...metadata,
        ...(input.replacementForActionId ? { replacementForActionId: input.replacementForActionId } : {}) }, createdAt: now, updatedAt: now };
    const action: CollaborationAction = { id: `collaboration:codex:${hash(`${parentThread.id}:${item.id}`)}`, kind: "delegate",
      source: { threadId: parentThread.id, turnId: parent.id, itemId: item.id }, target: { threadId: child.id },
      status: "Dispatched", deliveryUnknown: false, ...(text(input.prompt) ? { message: text(input.prompt) } : {}),
      providerIdentities: identities([...input.providerIdentities, ...(input.receiverThreadIds ?? []).map(receiverIdentity)]),
      createdAt: now, updatedAt: now };
    const context = this.context(parent);
    this.recordThread(child, context);
    this.recordThread({ ...parentThread, rosterRevision: parentThread.rosterRevision + 1, updatedAt: now }, context);
    this.recordItem(item, context);
    this.recordAction(action, context);
    return { childThread: child, parentItem: item, collaborationAction: action };
  }

  registerCodexReceiverThreadIds(input: CodexChildIdentityInput & { receiverThreadIds: readonly string[] }): CodexChildDelegation {
    const delegation = this.requireDelegation(input);
    assertAcknowledgable(delegation.collaborationAction);
    this.assertNativeBinding(delegation, input.nativeThreadId);
    const action = delegation.collaborationAction;
    const updated = { ...action, providerIdentities: identities([...action.providerIdentities, ...input.receiverThreadIds.map(receiverIdentity)]) };
    if (!NodeUtil.isDeepStrictEqual(updated.providerIdentities, action.providerIdentities)) {
      this.recordAction({ ...updated, updatedAt: timestamp() }, this.context(this.requireTurn(input.parentTurnId)));
    }
    return this.requireDelegation(input);
  }

  bindCodexChildIdentity(input: CodexChildIdentityInput): CodexChildDelegation {
    const delegation = this.requireDelegation(input);
    const action = delegation.collaborationAction;
    assertAcknowledgable(action);
    if (!action.providerIdentities.some((id) => sameIdentity(id, receiverIdentity(input.nativeThreadId)))) {
      throw new Error(`Codex child identity is not a registered receiver: ${input.nativeThreadId}`);
    }
    this.assertNativeBinding(delegation, input.nativeThreadId);
    const context = this.context(this.requireTurn(input.parentTurnId));
    const identity = nativeIdentity("thread", input.nativeThreadId);
    if (!delegation.childThread.providerIdentities.some((id) => sameIdentity(id, identity))) {
      const childThread = { ...delegation.childThread, providerIdentities: [...delegation.childThread.providerIdentities, identity], updatedAt: timestamp() };
      this.putThread(childThread);
      this.changes.push({ kind: "thread-bound", ...context, parentThreadId: input.parentThreadId, childThread, identity });
    }
    if (action.status !== "Acknowledged" || action.deliveryUnknown) {
      this.recordAction({ ...action, status: "Acknowledged", deliveryUnknown: false, updatedAt: timestamp() }, context);
    }
    return this.requireDelegation(input);
  }

  startCodexChildTurn(input: CodexChildTurnStartInput): AgentTurn {
    const delegation = this.bindCodexChildIdentity(input);
    const existing = this.loadTurnByProviderIdentity(delegation.childThread.id, nativeIdentity("turn", input.nativeTurnId));
    if (existing) return existing;
    const action = input.triggerActionId ? this.requireAction(input.triggerActionId) : delegation.collaborationAction;
    if (action.target.threadId !== delegation.childThread.id) throw new Error("Codex child trigger action does not target child");
    assertAcknowledgable(action);
    const now = timestamp();
    const turn = startedTurn(`turn:codex-child:${NodeCrypto.randomUUID()}`, NodeCrypto.randomUUID(), delegation.childThread.id,
      action, "full", identities([...delegation.childThread.providerIdentities, nativeIdentity("turn", input.nativeTurnId)]), now);
    this.putTurn(turn);
    const context = this.context(turn);
    this.recordThread({ ...delegation.childThread, activityState: "Active", updatedAt: now }, context);
    this.changes.push({ kind: "turn-started", ...context, turn });
    if (input.prompt !== undefined) this.recordPrompt(turn, action, input.prompt);
    this.recordAction({ ...action, target: { threadId: turn.threadId, turnId: turn.id }, status: "Acknowledged",
      deliveryUnknown: false, updatedAt: now }, this.context(this.requireTurn(action.source.turnId)));
    return turn;
  }

  recordCodexChildItem(input: CodexChildItemInput): AgentItem {
    const turn = this.childTurn(input.childThreadId, input.nativeTurnId);
    const stream = input.kind === "message" && ["stream", "stream-complete"].includes(input.eventKey);
    const id = `item:codex-child:${hash(`${turn.id}:${input.nativeItemId}:${stream ? "stream" : input.eventKey}:${input.kind}`)}`;
    const existing = this.state.items[id];
    if (existing) return this.updateChildItem(existing, input, turn, stream);
    if (isTerminal(turn)) throw new Error(`Codex child turn is terminal: ${turn.id}`);
    const now = timestamp();
    const payload = input.kind === "message" ? this.messagePayload(input.childThreadId, input.payload)
      : publicChildPayload(input.payload);
    const item: AgentItem = { id, threadId: turn.threadId, turnId: turn.id, kind: input.kind,
      ...(input.parentItemId ? { parentItemId: input.parentItemId } : {}), providerIdentities: [...turn.providerIdentities],
      payload: { ...payload, nativeItemId: input.nativeItemId, eventKey: input.eventKey }, createdAt: now, updatedAt: now };
    this.recordItem(item, this.context(turn));
    return item;
  }

  finishCodexChildTurn(input: CodexChildTurnFinishInput): AgentTurn {
    return this.finishTurn(this.childTurn(input.childThreadId, input.nativeTurnId), input.outcome, input.error);
  }
  finishCanonicalChildTurn(input: CanonicalChildTurnFinishInput): AgentTurn | null {
    const turn = Object.values(this.state.turns).filter((entry) => entry.threadId === input.childThreadId && entry.status === "Running")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))[0];
    return turn ? this.finishTurn(turn, input.outcome, input.error) : null;
  }

  markCodexChildDeliveryUnknown(input: CodexChildDeliveryInput): CodexChildDelegation { return this.markDelivery(input, true); }
  markCodexChildDeliveryRejected(input: CodexChildDeliveryInput): CodexChildDelegation { return this.markDelivery(input, false); }
  markUnresolvedCodexChildDeliveriesUnknown(executionId: string): string[] {
    const turn = this.loadTurnByExecution(executionId);
    if (!turn) throw new Error(`Codex owning execution was not found: ${executionId}`);
    const actions = Object.values(this.state.collaborationActions).filter((action) => action.source.turnId === turn.id
      && ["Pending", "Dispatched"].includes(action.status) && !action.target.turnId && !action.deliveryUnknown);
    if (actions.length > MAX_CHANGES / 3) throw new Error("Accepted Codex unresolved delivery limit exceeded");
    for (const action of actions) this.markDelivery({ parentThreadId: turn.threadId, parentTurnId: turn.id,
      parentExecutionId: executionId, parentItemId: action.source.itemId, nativeThreadId: "" }, true);
    return actions.map((action) => action.id);
  }
  retryCodexChildDelegation(input: CodexChildRetryInput): CodexChildDelegation {
    const previous = this.requireAction(input.previousActionId);
    if (previous.source.threadId !== input.parentThreadId || previous.status !== "Failed" && !previous.deliveryUnknown) {
      throw new Error(`Codex child action is not retryable: ${input.previousActionId}`);
    }
    if (previous.source.itemId === input.parentItemId) throw new Error("Codex child retry requires a new parent item");
    return this.startCodexChildDelegation({ ...input, replacementForActionId: previous.id });
  }

  recordCollaborationAction(input: CodexCollaborationActionInput): CollaborationAction {
    const turn = this.requireTurn(input.sourceTurnId);
    this.assertExecution(turn, input.sourceThreadId, input.sourceExecutionId);
    const target = this.collaborationTarget(input);
    const existing = this.state.collaborationActions[input.actionId];
    const now = timestamp();
    const action = collaborationAction(input, target, existing, now);
    assertActionIdentity(existing, action);
    const item = this.state.items[input.sourceItemId];
    assertSourceItem(item, turn);
    const context = this.context(turn);
    if (!item) this.recordItem({ id: input.sourceItemId, threadId: turn.threadId, turnId: turn.id, kind: "tool-call",
      providerIdentities: [...input.providerIdentities], payload: input.payload, createdAt: now, updatedAt: now }, context);
    if (!existing || !sameAction(existing, action)) this.recordAction(action, context);
    return this.requireAction(action.id);
  }

  private collaborationTarget(input: CodexCollaborationActionInput): AgentTurn | null {
    this.requireThread(input.targetThreadId);
    const target = input.targetTurnId ? this.requireTurn(input.targetTurnId) : this.activeTurn(input.targetThreadId);
    if (target && target.threadId !== input.targetThreadId) throw new Error("Collaboration target turn is not owned by target thread");
    return target;
  }

  recordCodexChildRoutingDiagnostic(input: CodexChildRoutingDiagnosticInput): boolean {
    const diagnostic = { ...input, event: publicEvent(AgentEventSchema().parse(input.event)) };
    const turn = this.diagnosticTurn(input);
    if (!turn || turn.threadId !== input.threadId || !this.loadThread(turn.threadId)) return false;
    const id = `item:codex-child-routing-failure:${hash(`${turn.id}:${input.parentItemId ?? ""}:${input.reason}`)}`;
    if (this.state.items[id]) return true;
    const now = timestamp();
    const item: AgentItem = { id, threadId: turn.threadId, turnId: turn.id, kind: "error",
      ...(input.parentItemId ? { parentItemId: input.parentItemId } : {}), providerIdentities: [...turn.providerIdentities],
      payload: { projection: "codexChildRoutingFailure", status: "action-required", recovery: "retry-child-routing",
        reason: input.reason, ...(input.parentItemId ? { parentItemId: input.parentItemId } : {}) }, createdAt: now, updatedAt: now };
    this.putItem(item);
    this.changes.push({ kind: "diagnostic", ...this.context(turn), diagnostic, item });
    return true;
  }

  private diagnosticTurn(input: CodexChildRoutingDiagnosticInput): AgentTurn | null {
    if (input.executionId) return this.loadTurnByExecution(input.executionId);
    const item = input.parentItemId ? this.state.items[input.parentItemId] : undefined;
    return item?.turnId ? this.loadTurn(item.turnId) : this.loadLatestTurn(input.threadId);
  }
  private markDelivery(input: CodexChildDeliveryInput, unknown: boolean): CodexChildDelegation {
    const delegation = this.requireDelegation(input);
    const action = delegation.collaborationAction;
    assertDeliveryChange(action, unknown);
    if (action.deliveryUnknown === unknown && action.status === (unknown ? "Dispatched" : "Failed")) return delegation;
    const now = timestamp();
    const context = this.context(this.requireTurn(input.parentTurnId));
    this.recordAction({ ...action, status: unknown ? "Dispatched" : "Failed", deliveryUnknown: unknown, updatedAt: now }, context);
    this.recordThread({ ...delegation.childThread, activityState: "Unavailable", updatedAt: now }, context);
    const parent = this.requireThread(input.parentThreadId);
    this.recordThread({ ...parent, rosterRevision: parent.rosterRevision + 1, updatedAt: now }, context);
    return this.requireDelegation(input);
  }
  private updateDelegation(existing: CodexChildDelegation, input: CodexChildDelegationInput): CodexChildDelegation {
    if (existing.parentItem.turnId !== input.parentTurnId) throw new Error("Codex delegation parent turn identity conflict");
    const metadata = delegationMetadata(input);
    if (existing.parentItem.payload.projection === "narrativeRecovery") delete metadata.description;
    const item = { ...existing.parentItem, providerIdentities: identities([...existing.parentItem.providerIdentities, ...input.providerIdentities]),
      payload: { ...existing.parentItem.payload, ...metadata } };
    const context = this.context(this.requireTurn(input.parentTurnId));
    if (!NodeUtil.isDeepStrictEqual(item, existing.parentItem)) this.recordItem({ ...item, updatedAt: timestamp() }, context);
    const prompt = text(input.prompt);
    if (prompt && prompt !== existing.collaborationAction.message) this.recordAction({ ...existing.collaborationAction, message: prompt, updatedAt: timestamp() }, context);
    const updated = this.requireDelegation(input);
    if (prompt && updated.collaborationAction.target.turnId) this.recordPrompt(this.requireTurn(updated.collaborationAction.target.turnId), updated.collaborationAction, prompt);
    return updated;
  }
  private recordPrompt(turn: AgentTurn, action: CollaborationAction, prompt: string): void {
    const id = `item:codex-child-prompt:${hash(turn.id)}`;
    if (this.state.items[id]) return;
    const now = timestamp();
    const message = MessageSchema().parse({ id: `codex-child-prompt:${hash(turn.id)}`, thread_id: turn.threadId,
      role: "user", content: prompt, tool_calls: null, files_changed: null, cost_usd: null, tokens_used: null,
      timestamp: now, sequence: this.nextMessageSequence(turn.threadId), attachments: null,
      parentAgentProvenance: { parentThreadId: action.source.threadId, parentTurnId: action.source.turnId,
        parentItemId: action.source.itemId, providerIdentities: action.providerIdentities } });
    this.recordItem({ id, threadId: turn.threadId, turnId: turn.id, kind: "message", providerIdentities: turn.providerIdentities,
      payload: { projection: "message", message }, createdAt: now, updatedAt: now }, this.context(turn));
  }
  private updateChildItem(existing: AgentItem, input: CodexChildItemInput, turn: AgentTurn, stream: boolean): AgentItem {
    if (input.kind !== "message") {
      assertSameChildPayload(existing, input);
      return existing;
    }
    const source = messageSource(input.payload);
    const message = MessageSchema().parse(existing.payload.message);
    if (!stream) {
      assertSameChildMessage(existing, source, message);
      return existing;
    }
    if (typeof source.content !== "string" || typeof source.id === "string" && source.id !== message.id) throw new Error(`Codex child streamed message identity conflict: ${existing.id}`);
    if (isTerminal(turn)) return existing;
    const content = input.eventKey === "stream-complete" ? source.content : message.content + source.content;
    const item = { ...existing, payload: { ...existing.payload, message: { ...message, content },
      nativeItemId: input.nativeItemId, eventKey: input.eventKey }, updatedAt: timestamp() };
    this.recordItem(item, this.context(turn));
    return item;
  }
  private messagePayload(threadId: string, payload: Record<string, unknown>): Record<string, unknown> {
    const source = messageSource(payload);
    const next = this.nextMessageSequence(threadId);
    const sequence = childMessageSequence(source.sequence, next);
    const content = typeof source.content === "string" ? source.content : "";
    const message = MessageSchema().parse({ ...source,
      id: typeof source.id === "string" && source.id ? source.id : `codex-child-message:${hash(`${threadId}:${sequence}:${content}`)}`,
      thread_id: threadId, role: source.role ?? "assistant", content, timestamp: source.timestamp ?? timestamp(), sequence,
      ...nullableMessageFields(source) });
    return { ...payload, projection: "message", message };
  }
  private nextMessageSequence(threadId: string): number {
    return Object.values(this.state.items).filter((item) => item.threadId === threadId && item.kind === "message" && item.payload.projection === "message").length;
  }
  private finishTurn(turn: AgentTurn, outcome: TurnOutcome, error?: string): AgentTurn {
    if (isTerminal(turn)) return turn;
    const now = timestamp();
    const finished: AgentTurn = { ...turn, status: TERMINAL_STATUS[outcome], endedAt: now, updatedAt: now };
    const context = this.context(turn);
    this.recordThread({ ...this.requireThread(turn.threadId), activityState: "Idle", updatedAt: now }, context);
    this.putTurn(finished);
    this.changes.push({ kind: "turn-terminal", ...context, turn: finished, outcome, ...(error ? { error } : {}) });
    return finished;
  }
  private childTurn(threadId: string, nativeId: string): AgentTurn {
    const turn = this.loadTurnByProviderIdentity(threadId, nativeIdentity("turn", nativeId));
    if (!turn) throw new Error(`Codex child turn not found: ${nativeId}`);
    return turn;
  }
  private activeTurn(threadId: string): AgentTurn | null {
    const turns = Object.values(this.state.turns).filter((turn) => turn.threadId === threadId && !isTerminal(turn));
    if (turns.length > 1) throw new Error(`Codex thread has conflicting active turns: ${threadId}`);
    return turns[0] ?? null;
  }
  private requireThread(id: string): AgentThread {
    const thread = this.loadThread(id);
    if (!thread) throw new Error(`Codex canonical thread not found: ${id}`);
    return thread;
  }
  private requireTurn(id: string): AgentTurn {
    const turn = this.loadTurn(id);
    if (!turn) throw new Error(`Codex canonical turn not found: ${id}`);
    return turn;
  }
  private requireAction(id: string): CollaborationAction {
    const action = this.state.collaborationActions[id];
    if (!action) throw new Error(`Codex collaboration action not found: ${id}`);
    return action;
  }
  private requireDelegation(input: Pick<CodexChildIdentityInput, "parentThreadId" | "parentTurnId" | "parentExecutionId" | "parentItemId">): CodexChildDelegation {
    this.assertExecution(this.requireTurn(input.parentTurnId), input.parentThreadId, input.parentExecutionId);
    const delegation = this.loadCodexChildDelegation(input.parentThreadId, input.parentItemId);
    if (!delegation || delegation.parentItem.turnId !== input.parentTurnId) throw new Error(`Codex child delegation not found: ${input.parentItemId}`);
    return delegation;
  }
  private delegation(actionId: string | undefined): CodexChildDelegation | null {
    if (!actionId) return null;
    const action = this.requireAction(actionId);
    const item = this.state.items[action.source.itemId];
    if (!item || item.threadId !== action.source.threadId || item.turnId !== action.source.turnId) throw new Error("Codex delegation parent item is incomplete");
    return { childThread: this.requireThread(action.target.threadId), parentItem: item, collaborationAction: action };
  }
  private assertNativeBinding(delegation: CodexChildDelegation, nativeId: string): void {
    const native = delegation.childThread.providerIdentities.find((identity) => identity.providerId === "codex" && identity.scope === "thread");
    if (native && native.value !== nativeId) throw new Error("Codex child native thread identity conflict");
    const bound = this.loadThreadByProviderIdentity(nativeIdentity("thread", nativeId));
    if (bound && bound.id !== delegation.childThread.id) throw new Error("Codex child native thread is already owned");
  }
  private assertExecution(turn: AgentTurn, threadId: string, executionId: string): void {
    if (turn.threadId !== threadId || this.loadExecutionIdForTurn(turn.id) !== executionId) throw new Error("Codex canonical execution ownership conflict");
  }
  private execution(turn: AgentTurn): ExecutionIdentity {
    if (!turn.executionId) throw new Error(`Codex canonical turn has no execution identity: ${turn.id}`);
    return { threadId: turn.threadId, turnId: turn.id, executionId: turn.executionId };
  }
  private context(turn: AgentTurn): AcceptedCollaborationContext {
    const action = Object.values(this.state.collaborationActions).find((entry) => entry.kind === "delegate" && entry.target.threadId === turn.threadId);
    return { sourceExecution: this.execution(turn), parentExecution: action ? this.execution(this.requireTurn(action.source.turnId)) : this.execution(turn) };
  }
  private putThread(thread: AgentThread): void {
    this.writableStateMap("threads")[thread.id] = thread;
    this.indexThread(thread);
  }
  private putTurn(turn: AgentTurn): void {
    this.writableStateMap("turns")[turn.id] = turn;
    this.indexTurn(turn);
  }
  private putItem(item: AgentItem): void { this.writableStateMap("items")[item.id] = item; }

  private writableStateMap<Name extends StateMapName>(name: Name): AgentModelState[Name] {
    if (!this.ownedStateMaps.has(name)) {
      this.state = { ...this.state, [name]: { ...this.state[name] } };
      this.ownedStateMaps.add(name);
    }
    return this.state[name];
  }

  private writableIndex(name: IndexName): CollaborationIndexes[IndexName] {
    if (!this.ownedIndexes.has(name)) {
      this.indexes = { ...this.indexes, [name]: new Map(this.indexes[name]) };
      this.ownedIndexes.add(name);
    }
    return this.indexes[name];
  }
  private recordThread(thread: AgentThread, context: AcceptedCollaborationContext): void {
    this.putThread(thread);
    this.changes.push({ kind: "thread-recorded", ...context, thread });
  }
  private recordItem(item: AgentItem, context: AcceptedCollaborationContext): void {
    this.putItem(item);
    this.changes.push({ kind: "item-recorded", ...context, item });
  }
  private recordAction(action: CollaborationAction, context: AcceptedCollaborationContext): void {
    this.writableStateMap("collaborationActions")[action.id] = action;
    this.indexAction(action);
    this.changes.push({ kind: "action-recorded", ...context, action });
  }
  private indexThread(thread: AgentThread): void {
    for (const identity of thread.providerIdentities) add(this.writableIndex("nativeThreads"), identityKey(identity), thread.id);
  }
  private indexTurn(turn: AgentTurn): void {
    if (turn.executionId) add(this.writableIndex("executions"), turn.executionId, turn.id);
    for (const identity of turn.providerIdentities) add(this.writableIndex("nativeTurns"), `${turn.threadId}:${identityKey(identity)}`, turn.id);
  }
  private indexAction(action: CollaborationAction): void {
    if (action.kind === "delegate") add(this.writableIndex("delegations"), `${action.source.threadId}:${action.source.itemId}`, action.id);
    for (const identity of action.providerIdentities) {
      if (identity.providerId === "codex" && identity.scope === "parentItem" && identity.provenance === "native" && action.kind === "delegate"
        && identity.value.startsWith("receiverThreadId:")) add(this.writableIndex("receivers"), identity.value.slice("receiverThreadId:".length), action.id);
      if (identity.scope === "item") add(this.writableIndex("nativeActions"), `${action.source.threadId}:${action.source.turnId}:${identityKey(identity)}`, action.id);
    }
  }
}

function timestamp(): string { return new Date().toISOString(); }
function childNativeItemId(item: AgentItem): string { return typeof item.payload.nativeItemId === "string" ? item.payload.nativeItemId : item.id; }
function hash(value: string): string { return NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 32); }
function identityKey(identity: ProviderIdentity): string { return JSON.stringify([identity.providerId, identity.scope, identity.value, identity.provenance]); }
function sameIdentity(left: ProviderIdentity, right: ProviderIdentity): boolean { return identityKey(left) === identityKey(right); }
function nativeIdentity(scope: ProviderIdentity["scope"], value: string): ProviderIdentity { return { providerId: "codex", scope, value, provenance: "native" }; }
function receiverIdentity(value: string): ProviderIdentity { return { providerId: "codex", scope: "parentItem", value: `receiverThreadId:${value}`, provenance: "native" }; }
function identities(values: readonly ProviderIdentity[]): ProviderIdentity[] { return [...new Map(values.map((value) => [identityKey(value), value])).values()]; }
function add(index: Map<string, ReadonlySet<string>>, key: string, id: string): void {
  const values = index.get(key);
  if (!values?.has(id)) index.set(key, new Set([...(values ?? []), id]));
}
function unique(index: ReadonlyMap<string, ReadonlySet<string>>, key: string, label: string): string | undefined {
  const values = index.get(key);
  if (values && values.size > 1) throw new Error(`${label} identity is ambiguous: ${key}`);
  return values?.values().next().value;
}
function isTerminal(turn: AgentTurn): boolean { return Object.values(TERMINAL_STATUS).some((status) => status === turn.status); }
function text(value: string | undefined): string | undefined { return value?.trim().slice(0, CANONICAL_SUBAGENT_TASK_MAX_LENGTH) || undefined; }
function delegationMetadata(input: CodexChildDelegationInput): Record<string, string> {
  const values = { description: text(input.description), identity: resolveSubagentDisplayName({ agentName: input.identity }),
    model: resolveSubagentMetadata(input.model), reasoningEffort: resolveSubagentMetadata(input.reasoningEffort) };
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
function assertAcknowledgable(action: CollaborationAction): void {
  if (action.status === "Failed" && !action.deliveryUnknown) throw new Error(`Cannot acknowledge confirmed Codex child rejection: ${action.id}`);
}
function assertDeliveryChange(action: CollaborationAction, unknown: boolean): void {
  if (unknown && action.status === "Failed" && !action.deliveryUnknown) throw new Error("Cannot replace confirmed Codex child rejection");
  if (!unknown && action.status === "Acknowledged" && !action.deliveryUnknown) throw new Error("Cannot reject acknowledged Codex child delivery");
}
function collaborationAction(input: CodexCollaborationActionInput, target: AgentTurn | null,
  existing: CollaborationAction | undefined, now: string): CollaborationAction {
  return { id: input.actionId, kind: input.kind, source: { threadId: input.sourceThreadId, turnId: input.sourceTurnId, itemId: input.sourceItemId },
    target: { threadId: input.targetThreadId, ...(target ? { turnId: target.id } : {}) }, status: input.status,
    deliveryUnknown: false, providerIdentities: identities(input.providerIdentities), createdAt: existing?.createdAt ?? now, updatedAt: now };
}
function assertSourceItem(item: AgentItem | undefined, turn: AgentTurn): void {
  if (item && (item.threadId !== turn.threadId || item.turnId !== turn.id)) throw new Error("Collaboration source item identity conflict");
}
function assertSameChildPayload(existing: AgentItem, input: CodexChildItemInput): void {
  if (!NodeUtil.isDeepStrictEqual(existing.payload, { ...publicChildPayload(input.payload), nativeItemId: input.nativeItemId, eventKey: input.eventKey })) {
    throw new Error(`Codex child item identity conflict: ${existing.id}`);
  }
}
function assertSameChildMessage(existing: AgentItem, source: Record<string, unknown>, message: Message): void {
  if (message.content !== source.content || message.role !== (source.role ?? "assistant")) throw new Error(`Codex child message identity conflict: ${existing.id}`);
}
function childMessageSequence(value: unknown, next: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value >= next ? value : next;
}
function nullableMessageFields(source: Record<string, unknown>): Record<string, unknown> {
  return { tool_calls: source.tool_calls ?? null, files_changed: source.files_changed ?? null, cost_usd: source.cost_usd ?? null,
    tokens_used: source.tokens_used ?? null, attachments: source.attachments ?? null };
}
function assertActionIdentity(existing: CollaborationAction | undefined, action: CollaborationAction): void {
  if (existing && (existing.kind !== action.kind || !NodeUtil.isDeepStrictEqual(existing.source, action.source) || existing.target.threadId !== action.target.threadId)) {
    throw new Error(`Collaboration action identity conflict: ${action.id}`);
  }
}
function sameAction(left: CollaborationAction, right: CollaborationAction): boolean {
  return NodeUtil.isDeepStrictEqual({ ...left, updatedAt: "" }, { ...right, updatedAt: "" });
}
function startedTurn(id: string, executionId: string, threadId: string, action: CollaborationAction,
  permissionMode: AgentTurn["permissionMode"], providerIdentities: ProviderIdentity[], now: string): AgentTurn {
  return { id, executionId, threadId, status: "Running", trigger: { kind: "child", sourceThreadId: action.source.threadId,
    sourceTurnId: action.source.turnId, sourceItemId: action.source.itemId }, permissionMode,
    approvalReviewMode: "manual", approvalReviewReason: "manual-requested", providerIdentities,
    startedAt: now, providerStartedAt: null, endedAt: null, createdAt: now, updatedAt: now };
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function messageSource(payload: Record<string, unknown>): Record<string, unknown> { return isRecord(payload.message) ? payload.message : payload; }
function publicChildPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(payload.toolInput)) return payload;
  return { ...payload, toolInput: sanitizePublicToolInput(payload.toolInput, typeof payload.toolName === "string" ? payload.toolName : undefined) };
}
function publicProjection(projection: ProviderEventProjection): ProviderEventProjection {
  if (projection.status === "forward") return { ...projection, event: publicEvent(projection.event) };
  if (projection.status === "rejected") return { ...projection, diagnostic: { ...projection.diagnostic,
    event: publicEvent(AgentEventSchema().parse(projection.diagnostic.event)) } };
  return projection;
}
function publicEvent(event: AgentEvent): AgentEvent {
  if (event.type !== AgentEventType.ToolUse && event.type !== AgentEventType.ToolResult) return event;
  const { codexCollabKind: _kind, senderThreadId: _sender, receiverThreadIds: _receivers, prompt: _prompt,
    agentName: _name, agentPath: _path, model: _model, reasoningEffort: _reasoning, ...input } = event.toolInput ?? {};
  const toolInput = sanitizePublicToolInput(input, event.type === AgentEventType.ToolUse ? event.toolName : undefined);
  if (event.type === AgentEventType.ToolUse) return { ...event, toolInput };
  const { toolInput: _input, ...withoutInput } = event;
  return Object.keys(toolInput).length ? { ...withoutInput, toolInput } : withoutInput;
}
