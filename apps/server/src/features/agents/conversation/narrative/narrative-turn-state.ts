import * as NodeCrypto from "node:crypto";
import { logger } from "@mcode/shared";
import {
  createSubagentPresentation, mergeSubagentPresentation, resolveBrowserNarrativeTool,
  resolveSubagentDuration, resolveSubagentMetadata, resolveSubagentPrompt,
  encodeCanonicalSubagentDetailTarget, encodeSubagentAliasDetailTarget,
  type ParentNarrativeRecoveryItem, type SubagentPresentation,
} from "@mcode/contracts";
import type { CreateToolCallRecordInput } from "../../tools/persistence/tool-call-record-repo.js";
import type { CreateThoughtSegmentInput } from "./persistence/thought-segment-repo.js";
import type { CreateHookExecutionInput } from "../../events/persistence/hook-execution-repo.js";
import type { TurnOutcome } from "../../turns/turn-outcome.js";
import { ACTIVE_TURN_WRITE_BATCH_LIMITS } from "../../../../runtime/persistence/sqlite/bounded-write-batches.js";
import { assertActiveTurnRecoveryRetention } from "../../turns/active-turn-recovery-retention-policy.js";
import type { ExecutionIdentity } from "../../execution/execution-mailbox-protocol.js";

/** Buffered tool call with raw input preserved for deferred summarization. */
export interface BufferedToolCall extends CreateToolCallRecordInput {
  _rawToolInput?: Record<string, unknown>;
  _subagentPresentation?: SubagentPresentation;
}

/** Extracts bounded provider metadata that must survive a persisted Agent card. */
function persistedSubagentMetadata(input: Record<string, unknown>) {
  return {
    subagentPrompt: resolveSubagentPrompt(input.prompt),
    subagentType: resolveSubagentMetadata(input.subagentType),
    subagentAgentId: resolveSubagentMetadata(input.agentId),
    subagentDurationMs: resolveSubagentDuration(input.durationMs),
  };
}

function persistedSubagentIdentityKey(presentation: SubagentPresentation | undefined): string | undefined {
  if (!presentation) return undefined;
  if (presentation.detail.kind === "canonical-child") {
    return encodeCanonicalSubagentDetailTarget(presentation.detail.threadId);
  }
  return presentation.detail.kind === "canonical-alias"
    ? encodeSubagentAliasDetailTarget(presentation.detail.identityKey)
    : undefined;
}

/** In-flight thought segment accumulated from consecutive textDelta events. */
interface OpenThought {
  id: string;
  text: string;
  startedAt: string;
  sortOrder: number;
}

/** In-flight hook execution awaiting its paired HookCompleted. */
export interface OpenHook {
  id: string;
  hookName: string;
  toolName: string | null;
  phase: string;
  payload: string;
  startedAt: string;
  sortOrder: number;
}

/** One narration record staged for a durable ownership transfer. */
export interface StagedNarrationSegment {
  id: string;
  text: string;
  startedAt: string;
  endedAt: string;
  sortOrder: number;
  openThoughtId?: string;
}

/** Tool-use event shape consumed by {@link NarrativeTurnState.bufferToolCall}. */
export interface BufferToolCallEvent {
  toolCallId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  parentToolCallId?: string;
  subagentPresentation?: SubagentPresentation;
}

/** Complete narrative rows prepared for one terminal persistence pass. */
export interface PreparedNarrativePersistence {
  toolCalls: BufferedToolCall[];
  thoughts: CreateThoughtSegmentInput[];
  hooks: CreateHookExecutionInput[];
}

/** Bounds persisted shell commands while retaining enough text for readable expansion. */
const MAX_PERSISTED_COMMAND_CHARS = 4096;

const NARRATIVE_INPUT_SUMMARIZERS: Record<string, (input: Record<string, unknown>) => string> = {
  read: fileInputSummary,
  edit: fileInputSummary,
  write: fileInputSummary,
  move: renameInputSummary,
  rename: renameInputSummary,
  bash: commandInputSummary,
  shell: commandInputSummary,
  terminal: commandInputSummary,
  command_execution: commandInputSummary,
  grep: patternInputSummary,
  glob: patternInputSummary,
  agent: agentInputSummary,
};

function fileInputSummary(input: Record<string, unknown>): string {
  return String(firstProvidedInputValue(input, ["file_path", "filePath"]) ?? "");
}

function renameInputSummary(input: Record<string, unknown>): string {
  const source = firstProvidedInputValue(input, [
    "oldPath", "old_path", "oldFilePath", "sourcePath", "source_path", "source", "from",
  ]);
  const destination = firstProvidedInputValue(input, [
    "newPath", "new_path", "destinationPath", "destination_path", "destination", "to", "path",
    "file_path", "filePath", "target_file", "targetFile",
  ]);
  return [source, destination]
    .filter((value): value is string => typeof value === "string")
    .join(" -> ")
    .slice(0, 200);
}

function commandInputSummary(input: Record<string, unknown>): string {
  return String(firstProvidedInputValue(input, ["command"]) ?? "").slice(0, MAX_PERSISTED_COMMAND_CHARS);
}

function patternInputSummary(input: Record<string, unknown>): string {
  return String(firstProvidedInputValue(input, ["pattern"]) ?? "");
}

function agentInputSummary(input: Record<string, unknown>): string {
  return String(firstProvidedInputValue(input, ["description"]) ?? "").slice(0, 100);
}

function genericInputSummary(input: Record<string, unknown>): string {
  return JSON.stringify(input).slice(0, 200);
}

function firstProvidedInputValue(input: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = input[key];
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

/** Data-only update emitted when a buffered Agent gains its durable identity. */
export type NarrativeTurnStateEffect = {
  readonly kind: "update-subagent-identity";
  readonly toolCallId: string;
  readonly messageId: string;
  readonly identityKey: string;
};

/** Owns one identity's narrative buffers; the live store currently binds by thread. */
export class NarrativeTurnState {
  private turnToolCalls: BufferedToolCall[] = [];
  private agentCallStack: string[] = [];
  private turnSortCounters = 0;
  private turnOpenThought: OpenThought | null = null;
  private turnThoughts: CreateThoughtSegmentInput[] = [];
  private turnOpenHooks = new Map<string, OpenHook>();
  private turnHooks: CreateHookExecutionInput[] = [];
  private readonly effectSink: ((effect: NarrativeTurnStateEffect) => void) | undefined;
  private readonly pendingEffects: NarrativeTurnStateEffect[] = [];
  readonly threadId: string;
  readonly execution: ExecutionIdentity | undefined;

  constructor(
    owner: string | ExecutionIdentity,
    effectSink?: (effect: NarrativeTurnStateEffect) => void,
  ) {
    this.threadId = typeof owner === "string" ? owner : owner.threadId;
    this.execution = typeof owner === "string" ? undefined : { ...owner };
    this.effectSink = effectSink;
  }

  /** Fence a worker command to the exact turn attempt bound to this state. */
  assertExecution(execution: ExecutionIdentity): void {
    const owner = this.execution;
    if (!owner || owner.threadId !== execution.threadId
      || owner.turnId !== execution.turnId || owner.executionId !== execution.executionId) {
      throw new Error(`Narrative turn belongs to a different execution: ${execution.executionId}`);
    }
  }

  private assertThread(threadId: string): void {
    if (threadId !== this.threadId) {
      throw new Error(`Narrative turn belongs to ${this.threadId}, received ${threadId}`);
    }
  }

  /** Return any data-only effects emitted without a live persistence adapter. */
  takeEffects(): NarrativeTurnStateEffect[] {
    return this.pendingEffects.splice(0);
  }

  private emitEffect(effect: NarrativeTurnStateEffect): void {
    if (this.effectSink) this.effectSink(effect);
    else this.pendingEffects.push(effect);
  }

  /**
   * Reset the volatile per-turn buffers at the START of a turn (Trap 3). Mirrors
   * the seeding AgentService used to do in its `sendMessage`/turnStarted prelude.
   * Note: the sort counter and Agent stack are reset separately via
   * {@link resetTurnCounters} on the TurnStarted event so late hooks from the
   * prior turn can still increment the old counter.
   */
  beginTurn(threadId: string): void {
    this.assertThread(threadId);
    this.turnToolCalls = [];
    this.turnOpenThought = null;
    this.turnThoughts = [];
    this.turnOpenHooks = new Map();
    this.turnHooks = [];
  }

  /**
   * Reset the per-turn sort counter and Agent stack. Called from the
   * TurnStarted handler rather than {@link beginTurn} so a fresh counter is
   * available for each new turn while late hooks from the prior turn can still
   * increment the old one (see {@link clearTurn}).
   */
  resetTurnCounters(threadId: string): void {
    this.assertThread(threadId);
    this.turnSortCounters = 0;
    this.agentCallStack = [];
  }

  /** Allocate the next shared sort order for the thread's current turn. */
  nextSortOrder(threadId: string): number {
    this.assertThread(threadId);
    const sortOrder = this.turnSortCounters;
    this.turnSortCounters = sortOrder + 1;
    return sortOrder;
  }

  /**
   * Open or extend the in-flight thought segment from a non-final `textDelta`.
   * The sort order is allocated lazily on the first delta so consecutive deltas
   * keep the same slot, taken BEFORE any following tool call's slot — matching
   * the live client builder. Never touches the `agentCallStack` (Trap 2).
   */
  openOrExtendThought(threadId: string, delta: string): void {
    this.assertThread(threadId);
    const open = this.turnOpenThought;
    if (!open) {
      const sortOrder = this.nextSortOrder(threadId);
      this.turnOpenThought = {
        id: NodeCrypto.randomUUID(),
        text: delta,
        startedAt: new Date().toISOString(),
        sortOrder,
      };
    } else {
      open.text += delta;
    }
  }

  /**
   * Close any in-flight thought segment for the thread and push it onto the
   * closed-thoughts list. Called before a tool call begins (so the thought
   * sorts strictly before the tool) and during turn-end drain.
   */
  closeOpenThought(threadId: string): void {
    this.assertThread(threadId);
    const open = this.turnOpenThought;
    if (!open) return;
    const list = this.turnThoughts;
    list.push({
      id: open.id,
      messageId: "",
      text: open.text,
      startedAt: open.startedAt,
      endedAt: new Date().toISOString(),
      sortOrder: open.sortOrder,
    });
    this.turnThoughts = list;
    this.turnOpenThought = null;
  }

  /**
   * Discards the open thought without persisting it.
   *
   * Called when `AssistantMessageBoundary` reports `isFinalResponse: true` —
   * the streamed text was actually the final assistant response and will be
   * persisted via the `Message` event, so keeping the matching thought row
   * would duplicate the body as a ThoughtBlock in the narrative.
   */
  dropOpenThought(threadId: string): void {
    this.assertThread(threadId);
    this.turnOpenThought = null;
  }

  /**
   * Move the open thought text out of NarrativeStore without persisting it.
   *
   * Used when an authoritative boundary retroactively classifies previously
   * unknown deltas as the final assistant response. Ownership moves to
   * TurnFinalizer so the same text is not buffered in both stores.
   */
  takeOpenThought(threadId: string): string {
    this.assertThread(threadId);
    const open = this.turnOpenThought;
    this.turnOpenThought = null;
    return open?.text ?? "";
  }

  /**
   * Get the current parent tool call ID for a thread's active Agent nesting.
   * This is the fallback consulted by `index.ts` enrichment and
   * {@link bufferToolCall} when the SDK omits `parent_tool_use_id` (Trap 1).
   */
  getCurrentParentToolCallId(threadId: string): string | undefined {
    this.assertThread(threadId);
    return this.getStackDerivedParentFallback(threadId);
  }

  /**
   * A single running Agent on the stack (buffer `status === "running"`) can
   * serve as a parent fallback when the SDK omits `parent_tool_use_id`.
   * Zero or multiple running Agents means the fallback is ambiguous (parallel
   * dispatch, nested agents, or coordinator work after children); return
   * undefined so tools do not attach under the wrong subagent row.
   */
  private getStackDerivedParentFallback(threadId: string): string | undefined {
    this.assertThread(threadId);
    const stack = this.agentCallStack;
    if (stack.length === 0) return undefined;

    const buffer = this.turnToolCalls;
    const runningAgentIds: string[] = [];
    for (const agentId of stack) {
      const row = buffer.find(
        (b) => b.toolCallId === agentId && b.toolName === "Agent",
      );
      if (row?.status === "running") {
        runningAgentIds.push(agentId);
      }
    }

    return runningAgentIds.length === 1 ? runningAgentIds[0] : undefined;
  }

  /**
   * Buffer a tool call event for later persistence and return the parent tool
   * call ID attributed to it. An explicit provider parent always wins. The
   * stack fallback applies only to non-Agent calls when exactly one Agent is
   * still running (Trap 1). Agent calls never inherit a stack-derived parent
   * and are pushed onto the `agentCallStack` (Trap 2 push site).
   */
  bufferToolCall(threadId: string, event: BufferToolCallEvent): string | undefined {
    this.assertThread(threadId);
    const buffer = this.turnToolCalls;
    const stack = this.agentCallStack;
    const parentToolCallId = this.resolveParentToolCallId(threadId, event);
    this.logParentToolCallAttribution(threadId, event, parentToolCallId, stack.length);
    const existing = buffer.find((tc) => tc.toolCallId === event.toolCallId);
    if (existing) {
      return this.updateExistingBufferedToolCall(existing, event, parentToolCallId);
    }
    return this.addBufferedToolCall(
      threadId,
      buffer,
      stack,
      event,
      parentToolCallId,
    );
  }

  private resolveParentToolCallId(
    threadId: string,
    event: BufferToolCallEvent,
  ): string | undefined {
    this.assertThread(threadId);
    if (event.toolName === "Agent") return event.parentToolCallId;
    return event.parentToolCallId ?? this.getStackDerivedParentFallback(threadId);
  }

  private logParentToolCallAttribution(
    threadId: string,
    event: BufferToolCallEvent,
    parentToolCallId: string | undefined,
    stackDepth: number,
  ): void {
    this.assertThread(threadId);
    if (event.toolName === "Agent" || !parentToolCallId) return;
    logger.debug("bufferToolCall: parent attribution", {
      threadId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      sdkParent: event.parentToolCallId ?? null,
      stackDepth,
      attributed: parentToolCallId,
      source: event.parentToolCallId ? "sdk" : "stack-fallback",
    });
  }

  private updateExistingBufferedToolCall(
    existing: BufferedToolCall,
    event: BufferToolCallEvent,
    parentToolCallId: string | undefined,
  ): string | undefined {
    const shouldMergeDuplicate = this.shouldMergeDuplicateToolCall(existing, event);
    if (shouldMergeDuplicate) {
      this.mergeDuplicateToolCall(existing, event);
    }
    this.mergeParentToolCallId(
      existing,
      event.parentToolCallId,
      parentToolCallId,
      shouldMergeDuplicate,
    );
    return existing.parentToolCallId;
  }

  private shouldMergeDuplicateToolCall(
    existing: BufferedToolCall,
    event: BufferToolCallEvent,
  ): boolean {
    if (existing.toolName === "Agent" && event.toolName === "Agent") return true;
    const rawToolInput = existing._rawToolInput ?? {};
    return existing.status === "running" && (
      Object.keys(rawToolInput).length === 0 || existing.toolName !== event.toolName
    );
  }

  private mergeDuplicateToolCall(existing: BufferedToolCall, event: BufferToolCallEvent): void {
    existing.toolName = event.toolName;
    const mergedToolInput = {
      ...existing._rawToolInput,
      ...event.toolInput,
    };
    existing._rawToolInput = mergedToolInput;
    if (event.toolName === "Agent") {
      existing._subagentPresentation = mergeSubagentPresentation(
        existing._subagentPresentation,
        event.subagentPresentation
          ?? createSubagentPresentation(mergedToolInput, event.toolCallId),
        event.toolCallId,
      );
      this.applyAgentPresentation(existing, mergedToolInput, event.toolCallId);
    }
  }

  private mergeParentToolCallId(
    existing: BufferedToolCall,
    providerParentToolCallId: string | undefined,
    inferredParentToolCallId: string | undefined,
    mergedDuplicate: boolean,
  ): void {
    if (providerParentToolCallId) {
      existing.parentToolCallId = providerParentToolCallId;
      return;
    }
    if (mergedDuplicate && inferredParentToolCallId && !existing.parentToolCallId) {
      existing.parentToolCallId = inferredParentToolCallId;
    }
  }

  private applyAgentPresentation(
    toolCall: BufferedToolCall,
    rawToolInput: Record<string, unknown>,
    toolCallId: string,
  ): void {
    const presentation = toolCall._subagentPresentation
      ?? createSubagentPresentation(rawToolInput, toolCallId);
    toolCall.displayName = presentation.hasExplicitIdentity ? presentation.displayName : undefined;
    toolCall.providerAgentKey = presentation.providerAgentKey;
    toolCall.subagentIdentityKey = persistedSubagentIdentityKey(presentation) ?? toolCall.subagentIdentityKey;
    toolCall.subagentProviderName = this.subagentProviderName(presentation);
    Object.assign(toolCall, persistedSubagentMetadata(rawToolInput));
    if (toolCall.messageId && toolCall.subagentIdentityKey) {
      this.emitEffect({
        kind: "update-subagent-identity",
        toolCallId: toolCall.toolCallId!,
        messageId: toolCall.messageId,
        identityKey: toolCall.subagentIdentityKey,
      });
    }
    toolCall.model = presentation.model;
    toolCall.reasoningEffort = presentation.reasoningEffort;
  }

  private addBufferedToolCall(
    threadId: string,
    buffer: BufferedToolCall[],
    stack: string[],
    event: BufferToolCallEvent,
    parentToolCallId: string | undefined,
  ): string | undefined {
    this.assertThread(threadId);
    const sortOrder = this.nextSortOrder(threadId);
    if (event.toolName === "Agent") {
      stack.push(event.toolCallId);
      this.agentCallStack = stack;
    }
    const presentation = this.subagentPresentation(event);
    buffer.push(this.createBufferedToolCall(event, presentation, sortOrder, parentToolCallId));
    this.turnToolCalls = buffer;
    return parentToolCallId;
  }

  private subagentPresentation(event: BufferToolCallEvent): SubagentPresentation | undefined {
    if (event.toolName !== "Agent") return undefined;
    return event.subagentPresentation ?? createSubagentPresentation(event.toolInput, event.toolCallId);
  }

  private createBufferedToolCall(
    event: BufferToolCallEvent,
    presentation: SubagentPresentation | undefined,
    sortOrder: number,
    parentToolCallId: string | undefined,
  ): BufferedToolCall {
    const isAgent = event.toolName === "Agent";
    return {
      toolCallId: event.toolCallId,
      messageId: "",
      toolName: event.toolName,
      displayName: presentation?.hasExplicitIdentity ? presentation.displayName : undefined,
      providerAgentKey: presentation?.providerAgentKey,
      subagentIdentityKey: isAgent ? persistedSubagentIdentityKey(presentation) : undefined,
      subagentProviderName: this.subagentProviderName(presentation),
      ...(isAgent ? persistedSubagentMetadata(event.toolInput) : {}),
      model: presentation?.model,
      reasoningEffort: presentation?.reasoningEffort,
      inputSummary: "",
      outputSummary: "",
      status: "running",
      startedAt: new Date().toISOString(),
      sortOrder,
      parentToolCallId,
      _rawToolInput: event.toolInput,
      ...(presentation ? { _subagentPresentation: presentation } : {}),
    };
  }

  private subagentProviderName(presentation: SubagentPresentation | undefined): string | undefined {
    if (presentation?.detail.kind !== "transcript-unavailable") return undefined;
    return presentation.detail.providerName;
  }

  /**
   * Update a buffered tool call with its output when its result arrives, and
   * pop the call from the `agentCallStack` if it was an Agent (Trap 2 pop site).
   */
  updateBufferedToolCallOutput(
    threadId: string,
    toolCallId: string,
    output: string,
    isError: boolean,
    toolInput?: Record<string, unknown>,
    outputMeta?: {
      outputTruncated?: boolean;
      outputTotalBytes?: number;
      outputArtifactPath?: string;
      exitCode?: number;
    },
    subagentPresentation?: SubagentPresentation,
  ): void {
    this.assertThread(threadId);
    this.removeAgentFromStack(threadId, toolCallId);
    const toolCall = this.latestBufferedToolCall(threadId, toolCallId);
    if (!toolCall) return;
    this.applyToolCallOutput(toolCall, output, isError, outputMeta);
    this.mergeToolCallInput(toolCall, toolInput);
    if (toolCall.toolName === "Agent") {
      const incomingPresentation = subagentPresentation
        ?? createSubagentPresentation(toolCall._rawToolInput ?? {}, toolCallId);
      toolCall._subagentPresentation = mergeSubagentPresentation(
        toolCall._subagentPresentation,
        incomingPresentation,
        toolCallId,
      );
      this.applyAgentPresentation(toolCall, toolCall._rawToolInput ?? {}, toolCallId);
    }
  }

  private removeAgentFromStack(threadId: string, toolCallId: string): void {
    this.assertThread(threadId);
    const stack = this.agentCallStack;
    const stackIndex = stack.indexOf(toolCallId);
    if (stackIndex < 0) return;
    stack.splice(stackIndex, 1);
    this.agentCallStack = stack;
    logger.debug("updateBufferedToolCallOutput: popped Agent from stack", {
      threadId,
      toolCallId,
      remainingDepth: stack.length,
    });
  }

  private latestBufferedToolCall(threadId: string, toolCallId: string): BufferedToolCall | undefined {
    this.assertThread(threadId);
    const buffer = this.turnToolCalls;
    for (let index = buffer.length - 1; index >= 0; index -= 1) {
      if (buffer[index].toolCallId === toolCallId) return buffer[index];
    }
    return undefined;
  }

  private applyToolCallOutput(
    toolCall: BufferedToolCall,
    output: string,
    isError: boolean,
    outputMeta: {
      outputTruncated?: boolean;
      outputTotalBytes?: number;
      outputArtifactPath?: string;
      exitCode?: number;
    } | undefined,
  ): void {
    const outputLimit = resolveBrowserNarrativeTool(toolCall.toolName) ? 4_000 : 500;
    toolCall.outputSummary = output.slice(0, outputLimit);
    toolCall.outputTruncated = outputMeta?.outputTruncated === true;
    this.applyOutputMetadata(toolCall, outputMeta);
    toolCall.status = isError ? "failed" : "completed";
    toolCall.completedAt = new Date().toISOString();
  }

  private applyOutputMetadata(
    toolCall: BufferedToolCall,
    outputMeta: {
      outputTotalBytes?: number;
      outputArtifactPath?: string;
      exitCode?: number;
    } | undefined,
  ): void {
    delete toolCall.outputTotalBytes;
    delete toolCall.outputArtifactPath;
    delete toolCall.exitCode;
    if (outputMeta?.outputTotalBytes != null) toolCall.outputTotalBytes = outputMeta.outputTotalBytes;
    if (outputMeta?.outputArtifactPath) toolCall.outputArtifactPath = outputMeta.outputArtifactPath;
    if (outputMeta?.exitCode !== undefined) toolCall.exitCode = outputMeta.exitCode;
  }

  private mergeToolCallInput(toolCall: BufferedToolCall, toolInput: Record<string, unknown> | undefined): void {
    if (!toolInput || Object.keys(toolInput).length === 0) return;
    toolCall._rawToolInput = {
      ...toolCall._rawToolInput,
      ...toolInput,
    };
  }

  /**
   * Clear the whole Agent stack when a final `Message` event arrives — the turn
   * is over and any Agent calls still on the stack are implicitly done (Trap 2
   * end-of-turn clear). No-ops when the stack is already empty.
   */
  clearAgentStackOnMessage(threadId: string): void {
    this.assertThread(threadId);
    const stack = this.agentCallStack;
    if (stack.length > 0) {
      stack.length = 0;
    }
  }

  /** Snapshot of the thread's buffered tool calls (read-only inspection). */
  getBufferedToolCalls(threadId: string): readonly BufferedToolCall[] {
    this.assertThread(threadId);
    return this.turnToolCalls;
  }

  /**
   * Snapshot the visible structured narrative for an unfinished turn without
   * retaining provider protocol traffic or private raw tool input.
   */
  recoverySnapshot(threadId: string): ParentNarrativeRecoveryItem[] {
    this.assertThread(threadId);
    const snapshot: ParentNarrativeRecoveryItem[] = [];
    let bytes = 0;
    bytes = this.appendBufferedToolCallRecoveryItems(snapshot, bytes, threadId);
    for (const thought of this.turnThoughts) {
      bytes = this.appendRecoverySnapshotItem(
        snapshot,
        bytes,
        this.thoughtRecoveryItem(thought),
        threadId,
      );
    }
    const openThought = this.turnOpenThought;
    if (openThought) {
      bytes = this.appendRecoverySnapshotItem(
        snapshot,
        bytes,
        this.openThoughtRecoveryItem(openThought),
        threadId,
      );
    }
    for (const hook of this.turnHooks) {
      bytes = this.appendRecoverySnapshotItem(
        snapshot,
        bytes,
        this.hookRecoveryItem(hook),
        threadId,
      );
    }
    for (const hook of this.turnOpenHooks.values()) {
      bytes = this.appendRecoverySnapshotItem(
        snapshot,
        bytes,
        this.openHookRecoveryItem(hook),
        threadId,
      );
    }
    return this.sortRecoverySnapshot(snapshot);
  }

  private appendBufferedToolCallRecoveryItems(
    snapshot: ParentNarrativeRecoveryItem[],
    bytes: number,
    threadId: string,
  ): number {
    for (const toolCall of this.turnToolCalls) {
      bytes = this.appendRecoverySnapshotItem(
        snapshot,
        bytes,
        this.toolCallRecoveryItem(toolCall),
        threadId,
      );
    }
    return bytes;
  }

  private appendRecoverySnapshotItem(
    snapshot: ParentNarrativeRecoveryItem[],
    bytes: number,
    item: ParentNarrativeRecoveryItem,
    threadId: string,
  ): number {
    const nextBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    this.assertRecoveryItemFitsWriteBatch(nextBytes, threadId);
    const retainedBytes = bytes + nextBytes;
    assertActiveTurnRecoveryRetention(snapshot.length + 1, retainedBytes);
    snapshot.push(item);
    return retainedBytes;
  }

  private toolCallRecoveryItem(toolCall: BufferedToolCall): ParentNarrativeRecoveryItem {
    return {
      kind: "toolCall",
      record: {
        ...this.toolCallRecoveryIdentityFields(toolCall),
        ...this.toolCallRecoveryPresentationFields(toolCall),
        ...this.toolCallRecoveryOutputFields(toolCall),
        ...this.toolCallRecoveryStateFields(toolCall),
      },
    };
  }

  private toolCallRecoveryIdentityFields(toolCall: BufferedToolCall) {
    return {
      id: this.requireRecoveryString(toolCall.toolCallId, "tool call id"),
      message_id: this.requireRecoveryString(toolCall.messageId, "tool call message id"),
      parent_tool_call_id: toolCall.parentToolCallId ?? null,
      tool_name: toolCall.toolName,
      display_name: toolCall.displayName ?? null,
      provider_agent_key: toolCall.providerAgentKey ?? null,
      subagent_identity_key: toolCall.subagentIdentityKey ?? null,
      subagent_provider_name: toolCall.subagentProviderName ?? null,
    };
  }

  private toolCallRecoveryPresentationFields(toolCall: BufferedToolCall) {
    return {
      subagent_prompt: toolCall.subagentPrompt ?? null,
      subagent_type: toolCall.subagentType ?? null,
      subagent_agent_id: toolCall.subagentAgentId ?? null,
      subagent_duration_ms: toolCall.subagentDurationMs ?? null,
      model: toolCall.model ?? null,
      reasoning_effort: toolCall.reasoningEffort ?? null,
    };
  }

  private toolCallRecoveryOutputFields(toolCall: BufferedToolCall) {
    return {
      input_summary: this.toolCallRecoveryInputSummary(toolCall),
      output_summary: toolCall.outputSummary,
      ...(toolCall.outputTruncated ? { output_truncated: 1 } : {}),
      output_total_bytes: toolCall.outputTotalBytes ?? null,
      output_artifact_path: toolCall.outputArtifactPath ?? null,
      exit_code: toolCall.exitCode ?? null,
    };
  }

  private toolCallRecoveryInputSummary(toolCall: BufferedToolCall): string {
    if (toolCall.inputSummary) return toolCall.inputSummary;
    return this.summarizeInput(toolCall.toolName, toolCall._rawToolInput ?? {});
  }

  private toolCallRecoveryStateFields(toolCall: BufferedToolCall) {
    return {
      status: toolCall.status,
      started_at: this.requireRecoveryString(toolCall.startedAt, "tool call start time"),
      completed_at: toolCall.completedAt ?? null,
      sort_order: toolCall.sortOrder,
    };
  }

  private thoughtRecoveryItem(thought: CreateThoughtSegmentInput): ParentNarrativeRecoveryItem {
    return {
      kind: "narrationSegment",
      record: {
        id: this.requireRecoveryString(thought.id, "thought id"),
        message_id: this.requireRecoveryString(thought.messageId, "thought message id"),
        text: this.requireRecoveryString(thought.text, "thought text"),
        started_at: this.requireRecoveryString(thought.startedAt, "thought start time"),
        ended_at: thought.endedAt ?? null,
        sort_order: thought.sortOrder,
        ...(thought.isFinalResponse ? { is_final_response: thought.isFinalResponse } : {}),
      },
    };
  }

  private openThoughtRecoveryItem(openThought: OpenThought): ParentNarrativeRecoveryItem {
    return {
      kind: "narrationSegment",
      record: {
        id: openThought.id,
        message_id: "",
        text: openThought.text,
        started_at: openThought.startedAt,
        ended_at: null,
        sort_order: openThought.sortOrder,
      },
    };
  }

  private hookRecoveryItem(hook: CreateHookExecutionInput): ParentNarrativeRecoveryItem {
    return {
      kind: "hook",
      record: {
        id: this.requireRecoveryString(hook.id, "hook id"),
        message_id: this.requireRecoveryString(hook.messageId, "hook message id"),
        hook_name: hook.hookName,
        tool_name: hook.toolName,
        phase: hook.phase,
        payload: hook.payload,
        duration_ms: hook.durationMs ?? null,
        did_block: hook.didBlock,
        started_at: this.requireRecoveryString(hook.startedAt, "hook start time"),
        ended_at: hook.endedAt ?? null,
        sort_order: hook.sortOrder,
      },
    };
  }

  private openHookRecoveryItem(hook: OpenHook): ParentNarrativeRecoveryItem {
    return {
      kind: "hook",
      record: {
        id: hook.id,
        message_id: "",
        hook_name: hook.hookName,
        tool_name: hook.toolName,
        phase: hook.phase,
        payload: hook.payload,
        duration_ms: null,
        did_block: false,
        started_at: hook.startedAt,
        ended_at: null,
        sort_order: hook.sortOrder,
      },
    };
  }

  private sortRecoverySnapshot(
    snapshot: ParentNarrativeRecoveryItem[],
  ): ParentNarrativeRecoveryItem[] {
    return snapshot.sort((left, right) => (
      left.record.sort_order - right.record.sort_order || left.record.id.localeCompare(right.record.id)
    ));
  }

  /** Stage narration for recovery without mutating the active turn buffer. */
  stageNarrationSegment(threadId: string, text: string): StagedNarrationSegment | null {
    this.assertThread(threadId);
    const open = this.turnOpenThought;
    const endedAt = new Date().toISOString();
    if (open) {
      return {
        id: open.id,
        text: `${open.text}${text}`,
        startedAt: open.startedAt,
        endedAt,
        sortOrder: open.sortOrder,
        openThoughtId: open.id,
      };
    }
    if (!text) return null;
    return {
      id: NodeCrypto.randomUUID(),
      text,
      startedAt: endedAt,
      endedAt,
      sortOrder: this.turnSortCounters,
    };
  }

  /** Add staged narration to a recovery snapshot without mutating the active turn buffer. */
  recoverySnapshotWithStagedNarration(
    threadId: string,
    staged: StagedNarrationSegment,
  ): ParentNarrativeRecoveryItem[] {
    this.assertThread(threadId);
    const snapshot = this.recoverySnapshot(threadId).filter((item) => (
      item.kind !== "narrationSegment" || item.record.id !== staged.id
    ));
    snapshot.push({
      kind: "narrationSegment",
      record: {
        id: staged.id,
        message_id: "",
        text: staged.text,
        started_at: staged.startedAt,
        ended_at: staged.endedAt,
        sort_order: staged.sortOrder,
      },
    });
    let bytes = 0;
    for (const [index, item] of snapshot.entries()) {
      const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
      this.assertRecoveryItemFitsWriteBatch(itemBytes, threadId);
      bytes += itemBytes;
      assertActiveTurnRecoveryRetention(index + 1, bytes);
    }
    return snapshot.sort((left, right) => (
      left.record.sort_order - right.record.sort_order || left.record.id.localeCompare(right.record.id)
    ));
  }

  /** Apply a narration record only after its recovery projection is durable. */
  applyStagedNarrationSegment(threadId: string, staged: StagedNarrationSegment): void {
    this.assertThread(threadId);
    if (staged.openThoughtId) {
      const open = this.turnOpenThought;
      if (!open || open.id !== staged.openThoughtId) {
        throw new Error(`Staged narration no longer matches the open thought: ${staged.id}`);
      }
      this.turnOpenThought = null;
    } else {
      const nextSortOrder = this.turnSortCounters;
      if (nextSortOrder <= staged.sortOrder) {
        this.turnSortCounters = staged.sortOrder + 1;
      }
    }
    const thoughts = this.turnThoughts;
    thoughts.push({
      id: staged.id,
      messageId: "",
      text: staged.text,
      startedAt: staged.startedAt,
      endedAt: staged.endedAt,
      sortOrder: staged.sortOrder,
    });
    this.turnThoughts = thoughts;
  }

  private requireRecoveryString(value: string | undefined, field: string): string {
    if (value === undefined) throw new Error(`Narrative recovery is missing ${field}`);
    return value;
  }

  private assertRecoveryItemFitsWriteBatch(byteLength: number, threadId: string): void {
    if (byteLength > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxBytes) {
      throw new Error(`Parent narrative recovery item exceeds the active-turn byte limit: ${threadId}`);
    }
  }

  /**
   * True when the current turn has buffered at least one narrative contributor —
   * a tool call, a narration segment (open or closed), or a hook (open or
   * closed). Feeds the {@link TurnFinalizer.hasRecordableActivity} predicate so
   * a turn with narrative but no assistant body still earns a persisted row.
   */
  hasBufferedNarrative(threadId: string): boolean {
    this.assertThread(threadId);
    return this.narrativeBufferStates(threadId).some(Boolean);
  }

  private narrativeBufferStates(threadId: string): boolean[] {
    this.assertThread(threadId);
    return [
      this.turnToolCalls.length > 0,
      Boolean(this.turnOpenThought),
      this.turnThoughts.length > 0,
      this.turnOpenHooks.size > 0,
      this.turnHooks.length > 0,
    ];
  }

  /**
   * Record an in-flight hook execution (HookStarted). The caller supplies the
   * already-allocated sort order (the late-hook path in AgentService allocates
   * it before deciding routing). Returns the generated row id.
   */
  openHook(
    threadId: string,
    hook: { hookName: string; toolName: string | null; phase: string; payload: string; sortOrder: number },
  ): string {
    this.assertThread(threadId);
    const map = this.turnOpenHooks;
    const id = NodeCrypto.randomUUID();
    map.set(hook.hookName, {
      id,
      hookName: hook.hookName,
      toolName: hook.toolName,
      phase: hook.phase,
      payload: hook.payload,
      startedAt: new Date().toISOString(),
      sortOrder: hook.sortOrder,
    });
    this.turnOpenHooks = map;
    return id;
  }

  /** Look up (without removing) an open hook by name. */
  peekOpenHook(threadId: string, hookName: string): OpenHook | undefined {
    this.assertThread(threadId);
    return this.turnOpenHooks.get(hookName);
  }

  /** Remove an open hook by name (after it has been completed or flushed). */
  removeOpenHook(threadId: string, hookName: string): void {
    this.assertThread(threadId);
    this.turnOpenHooks.delete(hookName);
  }

  /** Push a completed hook execution onto the closed-hooks list for persistence. */
  pushClosedHook(threadId: string, hook: CreateHookExecutionInput): void {
    this.assertThread(threadId);
    const list = this.turnHooks;
    list.push(hook);
    this.turnHooks = list;
  }

  /** Settle one turn's buffered records into data-only persistence rows. */
  prepareNarrativePersistence(
    threadId: string,
    messageId: string,
    messageContent: string,
    outcome: TurnOutcome,
  ): PreparedNarrativePersistence {
    this.assertThread(threadId);
    const toolCalls = this.prepareToolCallsForPersistence(threadId, messageId, outcome);
    this.closeOpenThought(threadId);
    this.closeOpenHooksForPersistence(threadId);
    const thoughts = this.prepareThoughtsForPersistence(threadId, messageId, messageContent);
    const hooks = this.prepareHooksForPersistence(threadId, messageId);
    return { toolCalls, thoughts, hooks };
  }

  private prepareToolCallsForPersistence(
    threadId: string,
    messageId: string,
    outcome: TurnOutcome,
  ): BufferedToolCall[] {
    this.assertThread(threadId);
    const toolCalls = this.turnToolCalls;
    const settledAt = new Date().toISOString();
    for (const toolCall of toolCalls) {
      toolCall.toolCallId ??= NodeCrypto.randomUUID();
      this.settleRunningToolCall(toolCall, outcome, settledAt);
      toolCall.messageId = messageId;
      this.prepareToolCallInput(toolCall);
    }
    return toolCalls;
  }

  private settleRunningToolCall(
    toolCall: BufferedToolCall,
    outcome: TurnOutcome,
    settledAt: string,
  ): void {
    if (toolCall.status !== "running") return;
    toolCall.status = this.settledToolCallStatus(outcome);
    toolCall.completedAt = settledAt;
  }

  private settledToolCallStatus(outcome: TurnOutcome): BufferedToolCall["status"] {
    if (outcome === "errored" || outcome === "interrupted") return "failed";
    if (outcome === "cancelled") return "cancelled";
    return "completed";
  }

  private prepareToolCallInput(toolCall: BufferedToolCall): void {
    const rawToolInput = toolCall._rawToolInput;
    if (toolCall.inputSummary || !rawToolInput) return;
    if (toolCall.toolName === "Agent") {
      this.applyAgentPersistenceMetadata(toolCall, rawToolInput);
    }
    toolCall.inputSummary = this.summarizeInput(toolCall.toolName, rawToolInput);
    delete toolCall._rawToolInput;
  }

  private applyAgentPersistenceMetadata(
    toolCall: BufferedToolCall,
    rawToolInput: Record<string, unknown>,
  ): void {
    const presentation = createSubagentPresentation(rawToolInput, toolCall.toolCallId!);
    const persistedPresentation = toolCall._subagentPresentation ?? presentation;
    toolCall.displayName = persistedPresentation.hasExplicitIdentity
      ? persistedPresentation.displayName
      : undefined;
    toolCall.providerAgentKey = persistedPresentation.providerAgentKey;
    toolCall.subagentIdentityKey = persistedSubagentIdentityKey(persistedPresentation)
      ?? toolCall.subagentIdentityKey;
    toolCall.subagentProviderName = this.subagentProviderName(persistedPresentation);
    Object.assign(toolCall, persistedSubagentMetadata(rawToolInput));
    toolCall.model = persistedPresentation.model;
    toolCall.reasoningEffort = persistedPresentation.reasoningEffort;
  }

  private closeOpenHooksForPersistence(threadId: string): void {
    this.assertThread(threadId);
    const openHookMap = this.turnOpenHooks;
    if (!openHookMap || openHookMap.size === 0) return;
    const list = this.turnHooks;
    const endedAt = new Date().toISOString();
    for (const open of openHookMap.values()) {
      list.push({
        id: open.id,
        messageId: "",
        hookName: open.hookName,
        toolName: open.toolName,
        phase: open.phase,
        payload: open.payload,
        durationMs: Date.parse(endedAt) - Date.parse(open.startedAt),
        didBlock: false,
        startedAt: open.startedAt,
        endedAt,
        sortOrder: open.sortOrder,
      });
    }
    this.turnHooks = list;
    openHookMap.clear();
  }

  private prepareThoughtsForPersistence(
    threadId: string,
    messageId: string,
    messageContent: string,
  ): CreateThoughtSegmentInput[] {
    this.assertThread(threadId);
    const bufferedThoughts = this.turnThoughts;
    for (const thought of bufferedThoughts) thought.id ??= NodeCrypto.randomUUID();
    const thoughts = bufferedThoughts.map((thought) => ({ ...thought, messageId }));
    const message = messageContent.trim();
    if (message.length > 0 && thoughts.length > 0) {
      this.markFinalResponseThoughts(thoughts, message);
    }
    return thoughts;
  }

  private markFinalResponseThoughts(
    thoughts: CreateThoughtSegmentInput[],
    message: string,
  ): void {
    const maxSortOrder = Math.max(...thoughts.map((thought) => thought.sortOrder));
    for (const thought of thoughts) {
      const text = thought.text.trim();
      if (text.length > 0 && this.isFinalResponseThought(thought, text, message, maxSortOrder)) {
        thought.isFinalResponse = 1;
      }
    }
  }

  private isFinalResponseThought(
    thought: CreateThoughtSegmentInput,
    text: string,
    message: string,
    maxSortOrder: number,
  ): boolean {
    if (text === message) return true;
    return thought.sortOrder === maxSortOrder
      && (thought.isFinalResponse === 1 || message.endsWith(text));
  }

  private prepareHooksForPersistence(
    threadId: string,
    messageId: string,
  ): CreateHookExecutionInput[] {
    this.assertThread(threadId);
    const bufferedHooks = this.turnHooks;
    for (const hook of bufferedHooks) hook.id ??= NodeCrypto.randomUUID();
    return bufferedHooks.map((hook) => ({ ...hook, messageId }));
  }

  /**
   * Clear the per-turn narrative buffers this store owns. The sort counter and
   * Agent stack are intentionally NOT cleared here — they are reset in the
   * TurnStarted handler so late hooks that arrive after this point can still
   * increment the completed turn's counter (mirrors the old clearTurnState).
   */
  clearTurn(threadId: string): void {
    this.assertThread(threadId);
    this.turnToolCalls = [];
    this.turnOpenThought = null;
    this.turnThoughts = [];
    this.turnOpenHooks = new Map<string, OpenHook>();
    this.turnHooks = [];
  }

  /** Generate a human-readable summary of tool input. */
  private summarizeInput(toolName: string, input: Record<string, unknown>): string {
    if (resolveBrowserNarrativeTool(toolName)) return JSON.stringify(input).slice(0, 4_000);
    return (NARRATIVE_INPUT_SUMMARIZERS[toolName.toLowerCase()] ?? genericInputSummary)(input);
  }
}
