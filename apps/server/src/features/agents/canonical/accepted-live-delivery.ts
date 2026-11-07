import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import { isChildRoutedRuntimeEvent, ProviderRuntimeEventSchema } from "@mcode/contracts/events/provider-runtime-event";
import { agentEventDelivery } from "@mcode/contracts/events/agent-event";
import type { AgentItem, CollaborationObservationChange } from "@mcode/contracts/compat/agent-model";
import type { ParentNarrativeRecoveryItem } from "@mcode/contracts/models/narrative-recovery";
import type { ProviderEventDraft } from "@mcode/providers";
import type { ExecutionAcceptedReceipt, ExecutionSemanticOperation, ParentLiveEffects } from "../execution/execution-worker-handler.js";
import type { CanonicalAgentEventDraft } from "./canonical-agent-boundary.js";

/** A stalled stream is saved this long after its first unsaved live piece. */
export const LIVE_CHECKPOINT_INTERVAL_MS = 1_000;
/** A fast stream is saved once this much live text and reasoning is pending. */
export const LIVE_CHECKPOINT_BYTES = 16 * 1024;

type AppendedText = Extract<ParentLiveEffects["text"], { kind: "append" }>["inputs"][number];

/** `collaboration.observed` holds at most this many changes, so a checkpoint saves at most this many child messages. */
const LIVE_CHILD_MESSAGES_MAX = 256;

type ChildMessageRecord = Extract<CollaborationObservationChange, { kind: "item-recorded" }>;

/** Pending parent projections and child message records replace stream fragments at the next checkpoint. */
export interface PendingLiveDelivery {
  /** The latest live operation; the checkpoint takes its execution and turn identity. */
  operation: ExecutionSemanticOperation;
  text: AppendedText[];
  narrative: Map<string, ParentNarrativeRecoveryItem>;
  /** The latest record of each child message shown live, by item id. Each record holds the whole text so far. */
  children: Map<string, ChildMessageRecord>;
  childSourceProviderId?: string;
  droppedEventCount?: number;
  bytes: number;
  cancelTimer(): void;
}

/** A child piece that only grows a message the owner already holds, with the text it appends. */
export interface LiveChildText {
  readonly record: ChildMessageRecord;
  readonly sourceProviderId: string;
  readonly text: { readonly threadId: string; readonly itemId: string; readonly at: number; readonly delta: string };
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
 * Every event the live frame would show must be a stream fragment, whatever label the worker set: a saved event
 * shown live is never saved, and the writer's predecessor check cannot see it was skipped.
 */
export function acceptsLive(operation: ExecutionSemanticOperation, providerStartedAt: string | null | undefined,
  preparedEvents: number, publications: ExecutionSemanticOperation["livePublication"]): boolean {
  return operation.delivery === "live" && operation.mutation.kind === "append-events" && Boolean(providerStartedAt)
    && preparedEvents === 0 && canDeliverLive(operation.mutation.events, operation.mutation.parentLive)
    && NodeUtil.isDeepStrictEqual(publications, operation.livePublication)
    && (publications ?? []).every(({ event }) => agentEventDelivery(event) === "live");
}

/**
 * Child pieces arrive as saved observations, because only parent fragments carry replaceable effects. The owner
 * still shows one live when its whole effect is a longer copy of a streaming child message it already holds: the
 * next checkpoint's latest record then replaces every piece in between. Creating, finishing or rewriting a message,
 * and any other child observation, saves as before.
 */
export function liveChildText(input: {
  readonly operation: ExecutionSemanticOperation;
  readonly providerStartedAt: string | null | undefined;
  readonly observations: readonly CanonicalAgentEventDraft[];
  readonly preparedEvents: number;
  readonly publications: ExecutionSemanticOperation["livePublication"];
  readonly previous: (itemId: string) => AgentItem | undefined;
}): LiveChildText | undefined {
  const observed = onlyChildObservation(input) ? singleItemRecord(input.observations) : undefined;
  if (!observed) return undefined;
  const { record, sourceProviderId } = observed;
  const previous = input.previous(record.item.id);
  const before = previous ? streamingContent(previous) : undefined;
  const content = streamingContent(record.item);
  if (before === undefined || content === undefined || content.length <= before.length || !content.startsWith(before)) return undefined;
  return { record, sourceProviderId,
    text: { threadId: record.item.threadId, itemId: record.item.id, at: before.length, delta: content.slice(before.length) } };
}

/** One child event whose preparation produced nothing but its collaboration observation, after the provider started. */
function onlyChildObservation(input: Parameters<typeof liveChildText>[0]): boolean {
  const { mutation } = input.operation;
  return mutation.kind === "append-events" && !mutation.parentLive && mutation.events.length === 1
    && Boolean(input.providerStartedAt) && input.preparedEvents === 0 && (input.publications ?? []).length === 0;
}

function singleItemRecord(observations: readonly CanonicalAgentEventDraft[]): Pick<LiveChildText, "record" | "sourceProviderId"> | undefined {
  const [observation] = observations;
  if (observations.length !== 1 || observation?.payload.type !== "collaboration.observed") return undefined;
  const [record] = observation.payload.changes;
  return observation.payload.changes.length === 1 && record?.kind === "item-recorded"
    ? { record, sourceProviderId: observation.sourceProviderId } : undefined;
}

/** Keep only the latest record of each child message; it already holds every earlier piece. */
export function mergeLiveChildText(pending: PendingLiveDelivery, operation: ExecutionSemanticOperation, child: LiveChildText): void {
  pending.operation = operation;
  pending.children.set(child.record.item.id, child.record);
  pending.childSourceProviderId = child.sourceProviderId;
  pending.bytes += Buffer.byteLength(child.text.delta);
}

/** Save when enough text is pending, or before the next child message would overflow one observation. */
export function liveCheckpointDue(pending: PendingLiveDelivery): boolean {
  return pending.bytes >= LIVE_CHECKPOINT_BYTES || pending.children.size >= LIVE_CHILD_MESSAGES_MAX;
}

/** One observation that saves the latest record of every child message shown live since the last checkpoint. */
export function liveChildCheckpoint(pending: PendingLiveDelivery, operationId: string): CanonicalAgentEventDraft | undefined {
  if (pending.children.size === 0 || !pending.childSourceProviderId) return undefined;
  return { eventId: `${operationId}:collaboration`, routing: pending.operation.execution, sourceProviderId: pending.childSourceProviderId,
    sourceIdentities: [], payload: { type: "collaboration.observed", changes: [...pending.children.values()] } };
}

/** Merge complete narrative records by identity and preserve assistant append order. */
export function mergeLiveDelivery(pending: PendingLiveDelivery, operation: ExecutionSemanticOperation): void {
  const effects = liveEffects(operation);
  pending.operation = operation;
  if (effects.text.kind === "append") pending.text.push(...effects.text.inputs);
  if (effects.narrative?.droppedEventCount) pending.droppedEventCount = (pending.droppedEventCount ?? 0) + effects.narrative.droppedEventCount;
  for (const item of effects.narrative?.items ?? []) pending.narrative.set(`${item.kind}:${item.record.id}`, item);
  pending.bytes += liveBytes(operation);
}

/**
 * One control operation saves the merged text appends and the latest narrative records. Tool-input fragments
 * leave nothing to save, because the tool's own saved event carries its full input.
 */
export function liveCheckpointOperation(pending: PendingLiveDelivery, operationId: string): ExecutionSemanticOperation | undefined {
  if (pending.text.length === 0 && pending.narrative.size === 0 && !pending.droppedEventCount) return undefined;
  const { delivery: _delivery, ...operation } = pending.operation;
  const executionId = operation.execution.executionId;
  return { ...operation, operationId, livePublication: [],
    mutation: { kind: "live-event", text: pending.text.length ? { kind: "append", inputs: pending.text } : { kind: "unchanged" },
      ...(pending.narrative.size || pending.droppedEventCount ? { narrative: { executionId, items: [...pending.narrative.values()],
        ...(pending.droppedEventCount ? { droppedEventCount: pending.droppedEventCount } : {}) } } : {}) } };
}

/** A fresh identity for one checkpoint, which saves under its own operation. */
export function liveCheckpointId(pending: PendingLiveDelivery): string {
  return `live:${pending.operation.execution.executionId}:${NodeCrypto.randomUUID()}`;
}

function streamingContent(item: AgentItem): string | undefined {
  const { payload } = item;
  if (payload.projection !== "message" || payload.eventKey !== "stream") return undefined;
  const message = payload.message;
  return typeof message === "object" && message !== null && "content" in message && typeof message.content === "string"
    ? message.content : undefined;
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
