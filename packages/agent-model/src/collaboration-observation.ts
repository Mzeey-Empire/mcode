import { z } from "zod";
import { AgentThreadIdSchema, AgentTurnIdSchema, AgentTurnExecutionIdSchema, ProviderIdentitySchema } from "./identity.js";
import { AgentItemSchema, AgentThreadSchema, AgentTurnSchema, CollaborationActionSchema, type AgentItem, type AgentThread,
  type AgentTurn, type CollaborationAction } from "./records.js";
import type { AgentModelState } from "./reducer.js";

const execution = z.object({ threadId: AgentThreadIdSchema, turnId: AgentTurnIdSchema, executionId: AgentTurnExecutionIdSchema }).strict();
const context = { sourceExecution: execution, parentExecution: execution };

/** Assigned child records carried atomically by their parent's single ordered observation. */
export const CollaborationObservationChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread-recorded"), ...context, thread: AgentThreadSchema }).strict(),
  z.object({ kind: z.literal("thread-bound"), ...context, parentThreadId: AgentThreadIdSchema,
    childThread: AgentThreadSchema, identity: ProviderIdentitySchema }).strict(),
  z.object({ kind: z.literal("turn-started"), ...context, turn: AgentTurnSchema }).strict(),
  z.object({ kind: z.literal("turn-terminal"), ...context, turn: AgentTurnSchema,
    outcome: z.enum(["completed", "cancelled", "interrupted", "errored"]), error: z.string().max(8_000).optional() }).strict(),
  z.object({ kind: z.literal("item-recorded"), ...context, item: AgentItemSchema }).strict(),
  z.object({ kind: z.literal("action-recorded"), ...context, action: CollaborationActionSchema }).strict(),
  z.object({ kind: z.literal("diagnostic"), ...context, item: AgentItemSchema }).strict(),
]);
/** A bounded set of child changes without a child event allocator or provider command. */
export type CollaborationObservationChange = z.infer<typeof CollaborationObservationChangeSchema>;

/** One record an observation writes, as a single key so an owned reducer can journal and undo it. */
export type CollaborationObservationWrite =
  | { readonly map: "threads"; readonly key: string; readonly value: AgentThread }
  | { readonly map: "turns"; readonly key: string; readonly value: AgentTurn }
  | { readonly map: "items"; readonly key: string; readonly value: AgentItem }
  | { readonly map: "collaborationActions"; readonly key: string; readonly value: CollaborationAction };

const terminal = new Set(["Completed", "Cancelled", "Interrupted", "Errored"]);

/**
 * Validate one parent-owned family observation atomically, fencing every child to that exact parent turn.
 * Returns the records it writes, or `undefined` when any change is refused. `state` is never changed.
 */
export function applyCollaborationObservation(state: AgentModelState, owner: z.infer<typeof execution>,
  changes: readonly CollaborationObservationChange[]): readonly CollaborationObservationWrite[] | undefined {
  const records = new ObservedRecords(state);
  for (const change of changes) {
    if (!applyChange(records, change)) return undefined;
  }
  for (const change of changes) {
    if (!validContext(records, owner, change) || !validRecord(records, owner.threadId, change)) return undefined;
  }
  return records.writes();
}

/**
 * The state's records with this observation's writes laid over them. Validation reads through it, so an
 * observation costs its own changes instead of a copy of every record map in a long thread.
 */
class ObservedRecords {
  private readonly threads = new Map<string, AgentThread>();
  private readonly turns = new Map<string, AgentTurn>();
  private readonly items = new Map<string, AgentItem>();
  private readonly actions = new Map<string, CollaborationAction>();

  constructor(private readonly state: AgentModelState) {}

  thread(id: string): AgentThread | undefined { return this.threads.get(id) ?? this.state.threads[id]; }
  turn(id: string): AgentTurn | undefined { return this.turns.get(id) ?? this.state.turns[id]; }
  item(id: string): AgentItem | undefined { return this.items.get(id) ?? this.state.items[id]; }

  putThread(thread: AgentThread): void { this.threads.set(thread.id, thread); }
  putTurn(turn: AgentTurn): void { this.turns.set(turn.id, turn); }
  putItem(item: AgentItem): void { this.items.set(item.id, item); }
  putAction(action: CollaborationAction): void { this.actions.set(action.id, action); }

  writes(): CollaborationObservationWrite[] {
    return [
      ...[...this.threads].map(([key, value]) => ({ map: "threads" as const, key, value })),
      ...[...this.turns].map(([key, value]) => ({ map: "turns" as const, key, value })),
      ...[...this.items].map(([key, value]) => ({ map: "items" as const, key, value })),
      ...[...this.actions].map(([key, value]) => ({ map: "collaborationActions" as const, key, value })),
    ];
  }
}

function applyChange(records: ObservedRecords, change: CollaborationObservationChange): boolean {
  switch (change.kind) {
    case "thread-recorded": records.putThread(change.thread); return true;
    case "thread-bound": records.putThread(change.childThread); return true;
    case "turn-started":
    case "turn-terminal": return applyTurn(records, change.turn);
    case "item-recorded":
    case "diagnostic": return applyItem(records, change.item);
    case "action-recorded": records.putAction(change.action); return true;
  }
}

function applyTurn(records: ObservedRecords, turn: AgentTurn): boolean {
  const existing = records.turn(turn.id);
  if (existing && (existing.threadId !== turn.threadId || existing.executionId !== turn.executionId
    || terminal.has(existing.status) && existing.status !== turn.status)) return false;
  records.putTurn(turn);
  return true;
}

function applyItem(records: ObservedRecords, item: AgentItem): boolean {
  const existing = records.item(item.id);
  if (existing && (existing.threadId !== item.threadId || existing.turnId !== item.turnId)) return false;
  records.putItem(existing?.payload.projection === "narrativeRecovery" && item.payload.projection === "codexSubagent"
    ? { ...item, payload: { ...item.payload, ...existing.payload } } : item);
  return true;
}

function validContext(records: ObservedRecords, owner: z.infer<typeof execution>, change: CollaborationObservationChange): boolean {
  const source = records.turn(change.sourceExecution.turnId);
  const parent = records.turn(change.parentExecution.turnId);
  if (!matchesTurn(source, change.sourceExecution) || !matchesTurn(parent, change.parentExecution)) return false;
  let current = source;
  const seen = new Set<string>();
  while (current.threadId !== owner.threadId) {
    if (seen.has(current.id) || current.trigger.kind !== "child") return false;
    seen.add(current.id);
    const next = records.turn(current.trigger.sourceTurnId);
    if (!next || next.threadId !== current.trigger.sourceThreadId) return false;
    current = next;
  }
  return matchesTurn(current, owner);
}

function matchesTurn(turn: AgentTurn | undefined, identity: z.infer<typeof execution>): turn is AgentTurn {
  return turn?.threadId === identity.threadId && turn.id === identity.turnId && turn.executionId === identity.executionId;
}

function validRecord(records: ObservedRecords, ownerThreadId: string, change: CollaborationObservationChange): boolean {
  switch (change.kind) {
    case "thread-recorded": return inFamily(records, change.thread.id, ownerThreadId);
    case "thread-bound": return validBinding(records, ownerThreadId, change);
    case "turn-started": return change.turn.status === "Running" && validTurn(records, change.turn, ownerThreadId);
    case "turn-terminal": return terminal.has(change.turn.status) && validTurn(records, change.turn, ownerThreadId);
    case "item-recorded":
    case "diagnostic": return validItem(records, ownerThreadId, change.item);
    case "action-recorded": return validAction(records, ownerThreadId, change.action);
  }
}

function validBinding(records: ObservedRecords, ownerThreadId: string,
  change: Extract<CollaborationObservationChange, { kind: "thread-bound" }>): boolean {
  return change.childThread.parentThreadId === change.parentThreadId && inFamily(records, change.childThread.id, ownerThreadId)
    && change.childThread.providerIdentities.some((id) => JSON.stringify(id) === JSON.stringify(change.identity));
}

function validItem(records: ObservedRecords, ownerThreadId: string, item: AgentItem): boolean {
  return records.turn(item.turnId)?.threadId === item.threadId && inFamily(records, item.threadId, ownerThreadId);
}

function validAction(records: ObservedRecords, ownerThreadId: string, action: CollaborationAction): boolean {
  return records.turn(action.source.turnId)?.threadId === action.source.threadId
    && records.item(action.source.itemId)?.threadId === action.source.threadId
    && inFamily(records, action.source.threadId, ownerThreadId) && inFamily(records, action.target.threadId, ownerThreadId);
}

function validTurn(records: ObservedRecords, turn: AgentTurn, ownerThreadId: string): boolean {
  return turn.threadId !== ownerThreadId && turn.executionId !== undefined && inFamily(records, turn.threadId, ownerThreadId);
}

function inFamily(records: ObservedRecords, threadId: string, ownerThreadId: string): boolean {
  const seen = new Set<string>();
  let id: string | undefined = threadId;
  while (id && !seen.has(id)) {
    if (id === ownerThreadId) return records.thread(id) !== undefined;
    seen.add(id);
    id = records.thread(id)?.parentThreadId;
  }
  return false;
}
