import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import { isChildRoutedRuntimeEvent, ProviderRuntimeEventSchema } from "@mcode/contracts/events/provider-runtime-event";
import { agentEventDelivery } from "@mcode/contracts/events/agent-event";
import type { ParentNarrativeRecoveryItem } from "@mcode/contracts/models/narrative-recovery";
import type { ProviderEventDraft } from "@mcode/providers";
import type { ExecutionAcceptedReceipt, ExecutionSemanticOperation, ParentLiveEffects } from "../execution/execution-worker-handler.js";

/** A stalled stream is saved this long after its first unsaved live piece. */
export const LIVE_CHECKPOINT_INTERVAL_MS = 1_000;
/** A fast stream is saved once this much live text and reasoning is pending. */
export const LIVE_CHECKPOINT_BYTES = 16 * 1024;

type AppendedText = Extract<ParentLiveEffects["text"], { kind: "append" }>["inputs"][number];

/** Pending parent projections replace stream fragments at the next checkpoint. */
export interface PendingLiveDelivery {
  /** The latest live operation; the checkpoint takes its execution and turn identity. */
  operation: ExecutionSemanticOperation;
  text: AppendedText[];
  narrative: Map<string, ParentNarrativeRecoveryItem>;
  bytes: number;
  cancelTimer(): void;
}

/** Last live receipt survives checkpoints so a producer retry cannot duplicate text. */
export interface LiveDeliveryReceipt {
  operationId: string;
  inputHash: string;
  receipt: ExecutionAcceptedReceipt;
}

/** Admit only parent fragments with effects that can be replaced by a checkpoint. */
export function canDeliverLive(events: readonly ProviderEventDraft[], effects: ParentLiveEffects | undefined): boolean {
  return effects !== undefined && events.length > 0 && hasOnlyReplaceableEffects(effects) && events.every(isLiveParentFragment);
}

/**
 * The accepted owner's final check: the provider has started (the first frame saves that start), and preparing
 * the operation added no events or publications of its own, so the checkpoint rebuilds everything it changed.
 */
export function acceptsLive(operation: ExecutionSemanticOperation, providerStartedAt: string | null | undefined,
  preparedEvents: number, publications: ExecutionSemanticOperation["livePublication"]): boolean {
  return operation.delivery === "live" && operation.mutation.kind === "append-events" && Boolean(providerStartedAt)
    && preparedEvents === 0 && canDeliverLive(operation.mutation.events, operation.mutation.parentLive)
    && NodeUtil.isDeepStrictEqual(publications, operation.livePublication);
}

/** Merge complete narrative records by identity and preserve assistant append order. */
export function mergeLiveDelivery(pending: PendingLiveDelivery, operation: ExecutionSemanticOperation): void {
  const effects = liveEffects(operation);
  pending.operation = operation;
  if (effects.text.kind === "append") pending.text.push(...effects.text.inputs);
  for (const item of effects.narrative?.items ?? []) pending.narrative.set(`${item.kind}:${item.record.id}`, item);
  pending.bytes += liveBytes(operation);
}

/**
 * One control operation saves the merged text appends and the latest narrative records. Tool-input fragments
 * leave nothing to save, because the tool's own saved event carries its full input.
 */
export function liveCheckpointOperation(pending: PendingLiveDelivery): ExecutionSemanticOperation | undefined {
  if (pending.text.length === 0 && pending.narrative.size === 0) return undefined;
  const { delivery: _delivery, ...operation } = pending.operation;
  const executionId = operation.execution.executionId;
  return { ...operation, operationId: `live:${executionId}:${NodeCrypto.randomUUID()}`, livePublication: [],
    mutation: { kind: "live-event", text: pending.text.length ? { kind: "append", inputs: pending.text } : { kind: "unchanged" },
      ...(pending.narrative.size ? { narrative: { executionId, items: [...pending.narrative.values()] } } : {}) } };
}

function hasOnlyReplaceableEffects(effects: ParentLiveEffects): boolean {
  return !settlesRecords(effects) && !requestsWork(effects) && (effects.text.kind === "unchanged" || effects.text.kind === "append");
}

/** Messages, plans and discards settle or remove saved records, which a later checkpoint cannot rebuild. */
function settlesRecords(effects: ParentLiveEffects): boolean {
  return Boolean(effects.message || effects.planQuestions || effects.planOutput || effects.narrative?.discardedItemIds?.length);
}

function requestsWork(effects: ParentLiveEffects): boolean {
  return Boolean(effects.taskIntents?.length || effects.systemIntents?.length);
}

function isLiveParentFragment(draft: ProviderEventDraft): boolean {
  if (draft.delivery !== "live" || draft.payload.type !== "item.recorded") return false;
  const runtime = ProviderRuntimeEventSchema().safeParse(draft.payload.item.payload.runtimeEvent);
  return runtime.success && !isChildRoutedRuntimeEvent(runtime.data.extension) && agentEventDelivery(runtime.data.event) === "live";
}

function liveEffects(operation: ExecutionSemanticOperation): ParentLiveEffects {
  const effects = operation.mutation.kind === "append-events" ? operation.mutation.parentLive : undefined;
  if (!effects) throw new Error("Live delivery requires parent append effects");
  return effects;
}

function liveBytes(operation: ExecutionSemanticOperation): number {
  let bytes = 0;
  for (const { event } of operation.livePublication ?? []) {
    if (event.type === "textDelta" || event.type === "reasoningDelta") bytes += Buffer.byteLength(event.delta);
  }
  return bytes;
}
