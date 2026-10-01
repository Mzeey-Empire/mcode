import { z } from "zod";
import { AgentThreadIdSchema, AgentTurnIdSchema, AgentTurnExecutionIdSchema, ProviderIdentitySchema } from "./identity.js";
import { AgentItemSchema, AgentThreadSchema, AgentTurnSchema, CollaborationActionSchema } from "./records.js";
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

const terminal = new Set(["Completed", "Cancelled", "Interrupted", "Errored"]);

/** Reduce one parent-owned family observation atomically, fencing every child to that exact parent turn. */
export function applyCollaborationObservation(state: AgentModelState, owner: z.infer<typeof execution>,
  changes: readonly CollaborationObservationChange[]): AgentModelState | undefined {
  const candidate = { ...state, threads: { ...state.threads }, turns: { ...state.turns },
    items: { ...state.items }, collaborationActions: { ...state.collaborationActions } };
  for (const change of changes) {
    if (!applyChange(candidate, change)) return undefined;
  }
  for (const change of changes) {
    if (!validContext(candidate, owner, change) || !validRecord(candidate, owner.threadId, change)) return undefined;
  }
  return candidate;
}

function applyChange(state: AgentModelState, change: CollaborationObservationChange): boolean {
  switch (change.kind) {
    case "thread-recorded": state.threads[change.thread.id] = change.thread; return true;
    case "thread-bound": state.threads[change.childThread.id] = change.childThread; return true;
    case "turn-started":
    case "turn-terminal": return applyTurn(state, change.turn);
    case "item-recorded":
    case "diagnostic": return applyItem(state, change.item);
    case "action-recorded": state.collaborationActions[change.action.id] = change.action; return true;
  }
}

function applyTurn(state: AgentModelState, turn: AgentModelState["turns"][string]): boolean {
  const existing = state.turns[turn.id];
  if (existing && (existing.threadId !== turn.threadId || existing.executionId !== turn.executionId
    || terminal.has(existing.status) && existing.status !== turn.status)) return false;
  state.turns[turn.id] = turn;
  return true;
}

function applyItem(state: AgentModelState, item: AgentModelState["items"][string]): boolean {
  const existing = state.items[item.id];
  if (existing && (existing.threadId !== item.threadId || existing.turnId !== item.turnId)) return false;
  state.items[item.id] = existing?.payload.projection === "narrativeRecovery" && item.payload.projection === "codexSubagent"
    ? { ...item, payload: { ...item.payload, ...existing.payload } } : item;
  return true;
}

function validContext(state: AgentModelState, owner: z.infer<typeof execution>, change: CollaborationObservationChange): boolean {
  const source = state.turns[change.sourceExecution.turnId];
  const parent = state.turns[change.parentExecution.turnId];
  if (!matchesTurn(source, change.sourceExecution) || !matchesTurn(parent, change.parentExecution)) return false;
  let current = source;
  const seen = new Set<string>();
  while (current.threadId !== owner.threadId) {
    if (seen.has(current.id) || current.trigger.kind !== "child") return false;
    seen.add(current.id);
    const next = state.turns[current.trigger.sourceTurnId];
    if (!next || next.threadId !== current.trigger.sourceThreadId) return false;
    current = next;
  }
  return matchesTurn(current, owner);
}

function matchesTurn(turn: AgentModelState["turns"][string] | undefined, identity: z.infer<typeof execution>):
  turn is AgentModelState["turns"][string] {
  return turn?.threadId === identity.threadId && turn.id === identity.turnId && turn.executionId === identity.executionId;
}

function validRecord(state: AgentModelState, ownerThreadId: string, change: CollaborationObservationChange): boolean {
  switch (change.kind) {
    case "thread-recorded": return inFamily(state, change.thread.id, ownerThreadId);
    case "thread-bound": return validBinding(state, ownerThreadId, change);
    case "turn-started": return change.turn.status === "Running" && validTurn(state, change.turn, ownerThreadId);
    case "turn-terminal": return terminal.has(change.turn.status) && validTurn(state, change.turn, ownerThreadId);
    case "item-recorded":
    case "diagnostic": return validItem(state, ownerThreadId, change.item);
    case "action-recorded": return validAction(state, ownerThreadId, change.action);
  }
}

function validBinding(state: AgentModelState, ownerThreadId: string,
  change: Extract<CollaborationObservationChange, { kind: "thread-bound" }>): boolean {
  return change.childThread.parentThreadId === change.parentThreadId && inFamily(state, change.childThread.id, ownerThreadId)
    && change.childThread.providerIdentities.some((id) => JSON.stringify(id) === JSON.stringify(change.identity));
}

function validItem(state: AgentModelState, ownerThreadId: string, item: AgentModelState["items"][string]): boolean {
  return state.turns[item.turnId]?.threadId === item.threadId && inFamily(state, item.threadId, ownerThreadId);
}

function validAction(state: AgentModelState, ownerThreadId: string, action: AgentModelState["collaborationActions"][string]): boolean {
  return state.turns[action.source.turnId]?.threadId === action.source.threadId
    && state.items[action.source.itemId]?.threadId === action.source.threadId
    && inFamily(state, action.source.threadId, ownerThreadId) && inFamily(state, action.target.threadId, ownerThreadId);
}

function validTurn(state: AgentModelState, turn: AgentModelState["turns"][string], ownerThreadId: string): boolean {
  return turn.threadId !== ownerThreadId && turn.executionId !== undefined && inFamily(state, turn.threadId, ownerThreadId);
}

function inFamily(state: AgentModelState, threadId: string, ownerThreadId: string): boolean {
  const seen = new Set<string>();
  let id: string | undefined = threadId;
  while (id && !seen.has(id)) {
    if (id === ownerThreadId) return state.threads[id] !== undefined;
    seen.add(id);
    id = state.threads[id]?.parentThreadId;
  }
  return false;
}
