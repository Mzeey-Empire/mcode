import { ProviderRuntimeEventSchema, type AgentEvent, type ProviderRuntimeEvent } from "@mcode/contracts";
import type { ProviderEventDraft } from "@mcode/providers";
import { processProviderEventWorkerTask } from "../../providers/composition/provider-event-worker-protocol.js";
import { CodexLiveEventReducer, type CodexPlanFeature, type SyntheticTerminalInput } from "./codex-live-event-reducer.js";
import { CodexLiveEventEffects, type PreparedCodexLiveEvent } from "./codex-live-event-effects.js";
import type { ExecutionIdentity } from "./execution-mailbox-protocol.js";
import { OtherProviderLiveEventEffects, type OtherProviderRuntimeIntent } from "./provider-live-event-effects.js";

/** Providers whose parent event effects have an execution worker implementation. */
export type ExecutionLiveProviderId = "codex" | "claude" | "cursor";

/** Immutable reducer setup supplied with the same durable parent start. */
export interface ExecutionParentStartContext {
  readonly planFeature: CodexPlanFeature;
  readonly precedingMessageId: string;
}

/** A provider preparation retains all runtime work alongside its writer data. */
export type PreparedProviderLiveEvent = Omit<PreparedCodexLiveEvent, "runtime"> & {
  readonly runtime: readonly OtherProviderRuntimeIntent[];
};

/** Parent effects are prepared only for ordinary, explicitly routed provider events. */
export type PreparedExecutionParentEvent =
  | { readonly kind: "writer-owned" }
  | { readonly kind: "parent"; readonly prepared: PreparedProviderLiveEvent }
  | { readonly kind: "rejected" };

/** Owns the volatile parent reducer; the execution must be poisoned after a failed write. */
export class ProviderExecutionEventState {
  private readonly parent: ParentReducer;

  constructor(private readonly providerId: ExecutionLiveProviderId, private readonly execution: ExecutionIdentity, context: ExecutionParentStartContext) {
    this.parent = createParentReducer(providerId, execution, context);
  }

  /** Validate the whole draft before any reducer state changes. Child evidence stays writer-owned. */
  prepare(drafts: readonly ProviderEventDraft[], allowTerminal = false): PreparedExecutionParentEvent {
    const parents: AgentEvent[] = [];
    for (const draft of drafts) {
      const result = this.parentEvent(draft);
      if (result.kind === "rejected") return result;
      if (result.kind === "parent") parents.push(result.event);
    }
    if (parents.length === 0) return { kind: "writer-owned" };
    if (parents.length !== 1 || drafts.length !== 1) return { kind: "rejected" };
    const event = parents[0];
    if (!event) return { kind: "rejected" };
    return this.reduceParent(event, allowTerminal);
  }

  /** Synthesize terminal projection from this execution's buffers without host-side reconstruction. */
  finishFromState(input: SyntheticTerminalInput): PreparedExecutionParentEvent {
    switch (this.parent.providerId) {
      case "codex": {
        const reduction = this.parent.reducer.finishFromState(input);
        return reduction.kind === "reduced"
          ? { kind: "parent", prepared: this.parent.effects.prepare(reduction) } : { kind: "rejected" };
      }
      case "claude": return preparedOtherResult(this.parent.effects.finishFromState(input));
      case "cursor": return preparedOtherResult(this.parent.effects.finishFromState(input));
    }
  }

  /** Publish the admission-owned start before the provider can stream its first event. */
  startFromAdmission(): PreparedExecutionParentEvent {
    return this.reduceParent({ type: "turnStarted", threadId: this.execution.threadId,
      turnExecutionId: this.execution.executionId }, false);
  }

  private reduceParent(event: AgentEvent, allowTerminal: boolean): PreparedExecutionParentEvent {
    if (!allowTerminal && isTerminalEvent(event)) return { kind: "rejected" };
    switch (this.parent.providerId) {
      case "codex": {
        const reduction = this.parent.reducer.reduce(event);
        return reduction.kind === "reduced"
          ? { kind: "parent", prepared: this.parent.effects.prepare(reduction) } : { kind: "rejected" };
      }
      case "claude": return prepareOtherParent(this.parent.effects, event);
      case "cursor": return prepareOtherParent(this.parent.effects, event);
    }
  }

  private parentEvent(draft: ProviderEventDraft):
    | { kind: "parent"; event: AgentEvent }
    | { kind: "writer-owned" }
    | { kind: "rejected" } {
    if (draft.sourceProviderId !== this.providerId || !this.matchesExecution(draft)) {
      return { kind: "rejected" };
    }
    if (draft.payload.type !== "item.recorded") return { kind: "writer-owned" };
    const item = draft.payload.item;
    if (item.payload.projection !== "providerRuntimeEvent") return { kind: "writer-owned" };
    const runtime = this.validatedRuntimeEvent(draft, item);
    if (!runtime) return { kind: "rejected" };
    if (hasWriterOwnedExtension(runtime)) return { kind: "writer-owned" };
    return { kind: "parent", event: runtime.event };
  }

  private validatedRuntimeEvent(
    draft: ProviderEventDraft,
    item: Extract<ProviderEventDraft["payload"], { type: "item.recorded" }>["item"],
  ): ProviderRuntimeEvent | undefined {
    const runtime = ProviderRuntimeEventSchema().safeParse(item.payload.runtimeEvent);
    if (!runtime.success || item.threadId !== draft.routing.threadId || item.turnId !== draft.routing.turnId
      || item.id !== draft.routing.itemId) return undefined;
    const parsed = processProviderEventWorkerTask({ kind: "provider-runtime", providerId: this.providerId, runtimeEvent: runtime.data });
    if (parsed.status === "rejected") return undefined;
    if (parsed.status !== "accepted" || parsed.event.event.threadId !== this.execution.threadId
      || parsed.event.event.turnExecutionId !== this.execution.executionId) return undefined;
    return { ...runtime.data, event: parsed.event.event };
  }

  private matchesExecution(draft: ProviderEventDraft): boolean {
    return draft.routing.threadId === this.execution.threadId && draft.routing.turnId === this.execution.turnId
      && draft.routing.executionId === this.execution.executionId;
  }
}

type ParentReducer =
  | { readonly providerId: "codex"; readonly reducer: CodexLiveEventReducer; readonly effects: CodexLiveEventEffects }
  | { readonly providerId: "claude" | "cursor"; readonly effects: OtherProviderLiveEventEffects };

function createParentReducer(providerId: ExecutionLiveProviderId, execution: ExecutionIdentity, context: ExecutionParentStartContext): ParentReducer {
  switch (providerId) {
    case "codex": return { providerId, reducer: new CodexLiveEventReducer(execution, context.planFeature),
      effects: new CodexLiveEventEffects(execution, context.precedingMessageId) };
    case "claude": return { providerId, effects: new OtherProviderLiveEventEffects("claude", execution, context.precedingMessageId, context.planFeature) };
    case "cursor": return { providerId, effects: new OtherProviderLiveEventEffects("cursor", execution, context.precedingMessageId, context.planFeature) };
  }
}

function prepareOtherParent(effects: OtherProviderLiveEventEffects, event: AgentEvent): PreparedExecutionParentEvent {
  return preparedOtherResult(effects.prepare(event));
}

function preparedOtherResult(prepared: ReturnType<OtherProviderLiveEventEffects["prepare"]>): PreparedExecutionParentEvent {
  return prepared.kind === "prepared" ? { kind: "parent", prepared } : { kind: "rejected" };
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === "turnComplete" || event.type === "error"
    || event.type === "ended" && event.outcome !== undefined;
}

function hasWriterOwnedExtension(runtime: ProviderRuntimeEvent): boolean {
  const extension = runtime.extension;
  return Boolean(extension?.child || extension?.collaboration || extension?.continuation);
}
