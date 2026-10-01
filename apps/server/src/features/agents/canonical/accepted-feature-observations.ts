import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import {
  AgentEventIdSchema, AgentEventSchema, AgentItemSchema, CanonicalTimestampSchema,
  MessageSchema, PlanRecordSchema, PlanSectionNavSchema,
  type AgentEvent, type AgentItem, type AgentThread, type AgentTurn, type Message, type PlanRecord,
} from "@mcode/contracts";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import type {
  ExecutionLivePublicationIntent, ExecutionSemanticOperation, ParentLiveEffects,
} from "../execution/execution-worker-handler.js";
import type { StoredTask } from "../orchestration/persistence/task-repo.js";
import type { TaskToolWriteIntent } from "../tasks/task-tool-intent-reducer.js";
import { sanitizePublicToolInput } from "../tools/input/public-tool-input.js";
import type { CanonicalAgentEventDraft } from "./canonical-agent-boundary.js";
import { prepareAcceptedSystemObservation, type AcceptedSystemObservation } from "./accepted-system-observation.js";
import { matchesCodexSystemIntents } from "./codex-system-intents.js";

const MAX_FEATURE_BYTES = 2 * 1024 * 1024;
const MAX_FEATURE_EVENTS = 256;
const storedTaskSchema = z.object({
  id: z.string().max(256).optional(), content: z.string().min(1).max(16 * 1024),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  activeForm: z.string().max(4096).optional(), group: z.string().max(128).optional(),
}).strict();
const taskIntentsSchema = z.array(z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upsert-group"), group: z.string().max(128), tasks: z.array(storedTaskSchema).max(256) }).strict(),
  z.object({ kind: z.literal("append-task"), task: storedTaskSchema }).strict(),
  z.object({ kind: z.literal("update-task"), id: z.string().min(1).max(256), group: z.string().max(128),
    patch: storedTaskSchema.pick({ status: true, content: true, activeForm: true }).partial() }).strict(),
  z.object({ kind: z.literal("remove-task"), id: z.string().min(1).max(256), group: z.string().max(128) }).strict(),
])).max(16);
const planOutputSchema = z.object({
  title: z.string().trim().min(1).max(512), contentMd: z.string().min(1).max(256 * 1024),
  sectionsJson: z.string().max(64 * 1024), changeSummary: z.string().max(4096).nullable(),
}).strict();
const taskBoardSchema = z.array(storedTaskSchema);
const planSectionsSchema = z.array(PlanSectionNavSchema()).max(128);
const expiredNoticeIdsSchema = z.array(z.string().min(1).max(256)).max(8_192);

/** Feature projections and notifications assigned before their ordered storage write. */
export interface AcceptedFeatureObservations {
  readonly events: CanonicalAgentEventDraft[];
  readonly publications: readonly ExecutionLivePublicationIntent[];
  readonly threadPatch?: AcceptedSystemObservation["threadPatch"];
  readonly compacting?: boolean;
  readonly noticeSessionId?: string;
  readonly expiredNoticeMessageIds?: readonly string[];
  readonly planOutput?: PlanRecord;
  readonly planRecords?: readonly PlanRecord[];
  readonly planGenerated?: { readonly threadId: string; readonly plan: PlanRecord };
}

/** Exact child records resolved by the collaboration adapter before live acceptance. */
export interface AcceptedChildPublicationOwner {
  readonly thread: AgentThread;
  readonly turn: AgentTurn;
}

/**
 * Prepares changed task, plan, and system observations from accepted state.
 * IDs, versions, timestamps, and message order are retained for storage to use unchanged.
 * Separate plan notifications use the existing plan.generated channel, outside AgentEvent.
 */
export function prepareAcceptedFeatureObservations(input: {
  readonly operation: ExecutionSemanticOperation;
  readonly thread: AgentThread;
  readonly turn: AgentTurn;
  readonly items: Readonly<Record<string, AgentItem>>;
  readonly acceptedAt: string;
  readonly messageSequence: number;
  readonly compaction: { readonly active: boolean };
  readonly currentNoticeSessionId?: string;
  readonly persistedPlans?: readonly PlanRecord[];
  readonly persistedTasks?: readonly StoredTask[];
  readonly childPublicationOwners?: readonly AcceptedChildPublicationOwner[];
}): AcceptedFeatureObservations {
  validateContext(input);
  const effects = liveEffects(input.operation);
  const systems = prepareSystems(input, effects);
  const tasks = prepareTasks(input, effects?.taskIntents);
  const plans = preparePlan(input, effects);
  const events = [...systems.events, ...tasks, ...plans.events];
  assertStorageMetadata(systems, plans);
  if (events.length > MAX_FEATURE_EVENTS || Buffer.byteLength(JSON.stringify(events)) > MAX_FEATURE_BYTES) {
    throw new Error("Accepted feature observations exceed their retention limit");
  }
  return { ...systems, ...plans, events };
}

function assertStorageMetadata(systems: AcceptedFeatureObservations, plans: PlanPreparation): void {
  assertMetadataCount(systems.expiredNoticeMessageIds?.length, 8_192);
  assertMetadataCount(plans.planRecords?.length, MAX_FEATURE_EVENTS);
  const patch = systems.threadPatch;
  assertContextMetric(patch?.contextTokensUsed, 1, "occupancy");
  assertContextMetric(patch?.contextWindow, 0, "capacity");
  const metadata = { threadPatch: patch, expiredNoticeMessageIds: systems.expiredNoticeMessageIds, planRecords: plans.planRecords,
    ...(Object.hasOwn(systems, "noticeSessionId") ? { noticeSession: { sessionId: systems.noticeSessionId ?? null } } : {}) };
  if (Buffer.byteLength(JSON.stringify(metadata)) > MAX_FEATURE_BYTES) throw new Error("Accepted feature metadata exceeds its retention limit");
}

function assertMetadataCount(count: number | undefined, maximum: number): void {
  if (count !== undefined && count > maximum) throw new Error("Accepted feature metadata exceeds its count limit");
}

function assertContextMetric(value: number | undefined, minimum: number, name: string): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Accepted context ${name} must be a ${minimum ? "positive" : "nonnegative"} safe integer`);
  }
}

type PreparationInput = Parameters<typeof prepareAcceptedFeatureObservations>[0];
type PlanPreparation = Pick<AcceptedFeatureObservations, "events" | "planOutput" | "planRecords" | "planGenerated">;

function validateContext(input: PreparationInput): void {
  const { execution, operationId } = input.operation;
  AgentEventIdSchema.parse(operationId);
  CanonicalTimestampSchema.parse(input.acceptedAt);
  if (operationId.length > 240 || operationId.trim() !== operationId) throw new Error("Invalid accepted operation identity");
  if (execution.threadId !== input.thread.id || execution.turnId !== input.turn.id
    || input.turn.threadId !== input.thread.id || input.turn.executionId !== execution.executionId) {
    throw new Error("Accepted feature observations require matching hydrated execution state");
  }
  if (!Number.isSafeInteger(input.messageSequence) || input.messageSequence < 0) throw new Error("Invalid accepted message sequence");
}

function liveEffects(operation: ExecutionSemanticOperation): ParentLiveEffects | undefined {
  const mutation = operation.mutation;
  return mutation.kind === "live-event" ? mutation : mutation.kind === "append-events" ? mutation.parentLive : undefined;
}

function prepareSystems(input: PreparationInput, effects: ParentLiveEffects | undefined): AcceptedFeatureObservations {
  const sources = input.operation.livePublication ?? [];
  if (sources.length > MAX_FEATURE_EVENTS) throw new Error("Too many accepted feature publications");
  validateSystemIntents(sources, effects);
  const events: CanonicalAgentEventDraft[] = [];
  const publications: ExecutionLivePublicationIntent[] = [];
  let messageSequence = input.messageSequence;
  let result: AcceptedFeatureObservations = { events, publications };
  for (const [index, source] of sources.entries()) {
    const event = publicEvent(source.event);
    const operationId = sources.length === 1 ? input.operation.operationId
      : uuidv5(`${input.operation.operationId}:system:${index}`, uuidv5.URL);
    const notices = prepareSystemPublication(input, { operationId,
      execution: input.operation.execution, providerId: input.thread.providerId, event,
      acceptedAt: input.acceptedAt, messageSequence,
      compacting: result.compacting ?? input.compaction.active });
    if (notices.observation.message) {
      events.push(noticeMessageEvent(input, notices.observation.message));
      if (notices.observation.message.id === notices.assignedMessageId) messageSequence += 1;
    }
    if (notices.expiredIds.length) {
      events.push(itemEvent(input, featureItem(input, `notice-status:${uuidv5(operationId, uuidv5.URL)}`, "system",
        { projection: "noticeStatus", expiredNoticeMessageIds: notices.expiredIds })));
    }
    result = advanceSystemEffects(result, notices.observation, notices.expiredIds);
    publications.push({ ...source, event: notices.observation.event });
  }
  return result;
}

function prepareSystemPublication(input: PreparationInput,
  observationInput: Parameters<typeof prepareAcceptedSystemObservation>[0]):
  ReturnType<typeof prepareNoticeObservation> & { assignedMessageId?: string } {
  if (isChildPublication(input, observationInput.event)) {
    if (liveEffects(input.operation)) throw new Error("Accepted child publication cannot carry parent feature effects");
    return { observation: { event: observationInput.event }, expiredIds: [] };
  }
  const observation = prepareAcceptedSystemObservation(observationInput);
  return { ...prepareNoticeObservation(input, observation), assignedMessageId: observation.message?.id };
}

function isChildPublication(input: PreparationInput, event: AgentEvent): boolean {
  if (event.threadId === input.operation.execution.threadId
    && event.turnExecutionId === input.operation.execution.executionId) return false;
  const owner = input.childPublicationOwners?.find(({ thread, turn }) => thread.id === event.threadId
    && turn.threadId === thread.id && turn.executionId === event.turnExecutionId);
  if (!owner?.thread.parentThreadId || owner.thread.owningParentThreadId !== input.thread.id
    || owner.thread.providerId !== input.thread.providerId) {
    throw new Error("Accepted feature publication lacks exact execution ownership");
  }
  return true;
}

function validateSystemIntents(sources: readonly ExecutionLivePublicationIntent[], effects: ParentLiveEffects | undefined): void {
  if (effects?.systemIntents === undefined) return;
  const source = sources.length === 1 ? sources[0]?.event : undefined;
  if (source?.type !== "system" || !matchesCodexSystemIntents(source, effects.systemIntents)) {
    throw new Error("Accepted system intents do not match their publication");
  }
}

function advanceSystemEffects(result: AcceptedFeatureObservations, observation: AcceptedSystemObservation,
  expiredIds: readonly string[]): AcceptedFeatureObservations {
  return { ...result,
    ...(observation.compacting === undefined ? {} : { compacting: observation.compacting }),
    ...(observation.threadPatch ? { threadPatch: { ...result.threadPatch, ...observation.threadPatch } } : {}),
    ...(Object.hasOwn(observation, "noticeSessionId") ? { noticeSessionId: observation.noticeSessionId } : {}),
    ...(expiredIds.length ? { expiredNoticeMessageIds: [...new Set([...result.expiredNoticeMessageIds ?? [], ...expiredIds])] } : {}),
  };
}

function prepareNoticeObservation(input: PreparationInput, observation: AcceptedSystemObservation): {
  observation: AcceptedSystemObservation; expiredIds: string[];
} {
  const event = observation.event;
  if (event.type !== "system") return { observation, expiredIds: [] };
  if (event.subtype === "provider.session.started") {
    const expiredIds = acceptedNotices(input, false).filter((message) => message.systemNotice?.scope === "session"
      && message.systemNotice.sessionId !== observation.noticeSessionId).map((message) => message.id);
    return { observation, expiredIds };
  }
  if (!observation.message) return { observation, expiredIds: [] };
  const notices = acceptedNotices(input);
  const existing = matchingNotice(notices, observation.message);
  if (existing) {
    const message = { ...existing, content: observation.message.content, systemNotice: observation.message.systemNotice };
    return { observation: { ...observation, message: NodeUtil.isDeepStrictEqual(message, existing) ? undefined : message,
      event: { ...event, messageId: message.id } }, expiredIds: [] };
  }
  return { observation, expiredIds: prunableNoticeIds(notices, observation.message) };
}

function acceptedNotices(input: PreparationInput, selectedSessionOnly = true): Message[] {
  const items = Object.values(input.items).filter((item) => item.threadId === input.thread.id);
  const expired = new Set(items.flatMap((item) => item.payload.projection === "noticeStatus"
    ? expiredNoticeIdsSchema.parse(item.payload.expiredNoticeMessageIds) : []));
  const messages = new Map<string, { message: Message; updatedAt: number }>();
  for (const item of items) {
    const message = noticeFromItem(input, item);
    if (!message || expired.has(message.id)) continue;
    if (selectedSessionOnly && !inSelectedNoticeSession(input, message)) continue;
    const current = messages.get(message.id);
    const updatedAt = Date.parse(item.updatedAt);
    if (!current || updatedAt >= current.updatedAt) messages.set(message.id, { message, updatedAt });
  }
  return [...messages.values()].map(({ message }) => message).sort((a, b) => b.sequence - a.sequence);
}

function inSelectedNoticeSession(input: PreparationInput, message: Message): boolean {
  return message.systemNotice?.scope !== "session" || message.systemNotice.sessionId === input.currentNoticeSessionId;
}

function noticeFromItem(input: PreparationInput, item: AgentItem): Message | null {
  if (item.payload.projection !== "message") return null;
  const message = MessageSchema().parse(item.payload.message);
  if (message.role !== "system" || !message.systemNotice) return null;
  if (message.thread_id !== input.thread.id) throw new Error("Accepted notice has conflicting ownership");
  return message;
}

function matchingNotice(notices: readonly Message[], message: Message): Message | undefined {
  const metadata = message.systemNotice;
  if (!metadata?.noticeKey) return undefined;
  return notices.find((notice) => notice.systemNotice?.sessionId === metadata.sessionId
    && (notice.systemNotice?.noticeKey === metadata.noticeKey
      || (metadata.kind === "model-rerouted" && notice.systemNotice?.kind === "model-rerouted")));
}

function prunableNoticeIds(notices: readonly Message[], message: Message): string[] {
  const metadata = message.systemNotice;
  return metadata?.scope === "session" ? notices.filter((notice) => notice.systemNotice?.scope === "session"
    && notice.systemNotice.sessionId === metadata.sessionId).slice(19).map((notice) => notice.id) : [];
}

function noticeMessageEvent(input: PreparationInput, message: Message): CanonicalAgentEventDraft {
  const original = input.items[`message:${message.id}`];
  const id = original && original.turnId !== input.turn.id
    ? `message-update:${uuidv5(`${input.operation.operationId}:${message.id}`, uuidv5.URL)}` : `message:${message.id}`;
  return itemEvent(input, featureItem(input, id, "message", { projection: "message", message }, original?.createdAt));
}

function publicEvent(source: ExecutionLivePublicationIntent["event"]): ExecutionLivePublicationIntent["event"] {
  const event = AgentEventSchema().parse(source);
  return event.type === "toolUse" ? { ...event, toolInput: sanitizePublicToolInput(event.toolInput, event.toolName) } : event;
}

function prepareTasks(input: PreparationInput, source: readonly TaskToolWriteIntent[] | undefined): CanonicalAgentEventDraft[] {
  if (!source?.length) return [];
  const intents = taskIntentsSchema.parse(source);
  const id = `taskBoard:${input.thread.id}`;
  const board = taskBoardState(input, id);
  let tasks: StoredTask[] = board.tasks;
  for (const intent of intents) tasks = applyTaskIntent(tasks, intent);
  if (NodeUtil.isDeepStrictEqual(board.tasks, tasks)) return [];
  return [itemEvent(input, featureItem(input, id, "system", { projection: "taskBoard", tasks }, board.createdAt))];
}

function taskBoardState(input: PreparationInput, id: string): { tasks: StoredTask[]; createdAt?: string } {
  const existing = input.items[id];
  if (existing && (existing.threadId !== input.thread.id || existing.payload.projection !== "taskBoard")) {
    throw new Error("Accepted task board has conflicting ownership");
  }
  return { tasks: taskBoardSchema.parse(existing ? existing.payload.tasks : input.persistedTasks ?? []), createdAt: existing?.createdAt };
}

function applyTaskIntent(tasks: StoredTask[], intent: TaskToolWriteIntent): StoredTask[] {
  switch (intent.kind) {
    case "upsert-group": return [...tasks.filter((task) => (task.group ?? "Tasks") !== intent.group), ...intent.tasks];
    case "append-task": return [...tasks.filter((task) => !sameTask(task, intent.task)), intent.task];
    case "update-task": {
      const index = findTaskIndex(tasks, intent.id, intent.group);
      const patch = intent.patch;
      return index < 0 ? tasks : tasks.map((task, position) => position === index ? { ...task,
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.content === undefined ? {} : { content: patch.content }),
        ...(patch.activeForm === undefined ? {} : { activeForm: patch.activeForm }),
      } : task);
    }
    case "remove-task": {
      const index = findTaskIndex(tasks, intent.id, intent.group);
      return index < 0 ? tasks : tasks.filter((_, position) => position !== index);
    }
  }
}

function sameTask(a: StoredTask, b: StoredTask): boolean {
  const sameGroup = (a.group ?? "Tasks") === (b.group ?? "Tasks");
  return sameGroup && (a.id != null && b.id != null ? a.id === b.id : a.content === b.content);
}

function findTaskIndex(tasks: readonly StoredTask[], id: string, group: string): number {
  let soleMatch = -1;
  let count = 0;
  for (let index = 0; index < tasks.length; index += 1) {
    if (tasks[index].id !== id) continue;
    if ((tasks[index].group ?? "Tasks") === group) return index;
    soleMatch = index;
    count += 1;
  }
  return count === 1 ? soleMatch : -1;
}

function preparePlan(input: PreparationInput, effects: ParentLiveEffects | undefined): PlanPreparation {
  if (!effects?.planOutput) return { events: [] };
  if (!effects.message?.messageId) throw new Error("Accepted plan requires its assigned assistant message");
  const source = planOutputSchema.parse(effects.planOutput);
  const sectionsJson = planSectionsSchema.parse(JSON.parse(source.sectionsJson));
  const prior = priorPlans(input);
  const messageId = effects.message.messageId;
  const existing = prior.find((plan) => plan.messageId === messageId);
  if (existing) {
    if (!NodeUtil.isDeepStrictEqual({ title: existing.title, contentMd: existing.contentMd,
      sectionsJson: existing.sectionsJson, changeSummary: existing.changeSummary }, { ...source, sectionsJson })) {
      throw new Error("Accepted plan has conflicting content for its assistant message");
    }
    return { events: [] };
  }
  const version = prior.reduce((maximum, plan) => Math.max(maximum, plan.version), 0) + 1;
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Accepted plan version is invalid");
  const plan = PlanRecordSchema().parse({ ...source, sectionsJson, id: uuidv5(`mcode:accepted-plan:${input.operation.operationId}`, uuidv5.URL),
    threadId: input.thread.id, messageId, version, status: "draft", createdAt: input.acceptedAt });
  if (prior.some((record) => record.id === plan.id)) throw new Error("Accepted operation has a conflicting plan identity");
  const superseded = prior.filter((record) => record.status === "draft").map((record): PlanRecord => ({ ...record, status: "superseded" }));
  const events = superseded.map((record) => itemEvent(input, featureItem(input,
    `plan-update:${uuidv5(`${input.operation.operationId}:${record.id}`, uuidv5.URL)}`, "system", { projection: "plan", plan: record })));
  events.push(itemEvent(input, featureItem(input, `plan:${plan.id}`, "system", { projection: "plan", plan })));
  return { events, planOutput: plan, planRecords: [...superseded, plan], planGenerated: { threadId: input.thread.id, plan } };
}

function priorPlans(input: PreparationInput): PlanRecord[] {
  const latest = new Map<string, { plan: PlanRecord; updatedAt: number }>();
  for (const value of input.persistedPlans ?? []) {
    const plan = validatedPriorPlan(input, value);
    latest.set(plan.id, { plan, updatedAt: Number.NEGATIVE_INFINITY });
  }
  for (const item of Object.values(input.items)) {
    if (item.threadId !== input.thread.id || item.payload.projection !== "plan") continue;
    const plan = validatedPriorPlan(input, item.payload.plan);
    const updatedAt = Date.parse(item.updatedAt);
    const current = latest.get(plan.id);
    if (!current || updatedAt >= current.updatedAt) latest.set(plan.id, { plan, updatedAt });
  }
  return [...latest.values()].map(({ plan }) => plan);
}

function validatedPriorPlan(input: PreparationInput, value: unknown): PlanRecord {
  const plan = PlanRecordSchema().parse(value);
  if (plan.threadId !== input.thread.id || !Number.isSafeInteger(plan.version) || plan.version < 1) {
    throw new Error("Accepted plan projection has conflicting ownership or version");
  }
  return plan;
}

function featureItem(input: PreparationInput, id: string, kind: AgentItem["kind"],
  payload: AgentItem["payload"], createdAt = input.acceptedAt): AgentItem {
  return AgentItemSchema.parse({ id, threadId: input.thread.id, turnId: input.turn.id, kind,
    providerIdentities: input.turn.providerIdentities, payload, createdAt, updatedAt: input.acceptedAt });
}

function itemEvent(input: PreparationInput, item: AgentItem): CanonicalAgentEventDraft {
  const fingerprint = NodeCrypto.createHash("sha256").update(JSON.stringify(item.payload)).digest("hex");
  return { eventId: uuidv5(`${input.operation.operationId}:feature:${item.id}:${fingerprint}`, uuidv5.URL),
    routing: { ...input.operation.execution, itemId: item.id },
    sourceProviderId: input.thread.providerId, sourceIdentities: item.providerIdentities, payload: { type: "item.recorded", item } };
}
