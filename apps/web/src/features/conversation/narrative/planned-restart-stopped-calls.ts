import type { AgentItem, AgentModelState, AgentTurn } from "@mcode/contracts/compat/agent-model";
import type { BackgroundCallKind } from "@mcode/contracts/models/tool-call-record";
import { ORPHANED_BACKGROUND_TOOL_OUTPUT, PLANNED_RESTART_NOTICE_KEY_PREFIX } from "@mcode/shared/planned-restart";

/** One background call a planned restart stopped, as the wake row lists it. */
export interface StoppedBackgroundCall {
  id: string;
  kind: BackgroundCallKind;
  label: string;
  /** Launch order within the thread. */
  createdAt: string;
  /** When settlement stopped the call, from the tool-call record's `completed_at`. */
  settledAt: string;
}

const NO_CALLS: readonly StoppedBackgroundCall[] = [];

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

function recordOf(payload: Record<string, unknown>): Record<string, unknown> | null {
  return objectOf(payload.record) ?? objectOf(objectOf(payload.narrative)?.record);
}

function stoppedCallOf(item: AgentItem): StoppedBackgroundCall | null {
  const record = recordOf(item.payload);
  if (!record || record.background !== true || record.status !== "cancelled" || record.output_summary !== ORPHANED_BACKGROUND_TOOL_OUTPUT) return null;
  if (typeof record.id !== "string" || typeof record.completed_at !== "string") return null;
  const kind: BackgroundCallKind = record.background_kind === "subagent" ? "subagent" : "command";
  const label = [record.background_label, record.display_name, record.input_summary, record.tool_name]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? "";
  return { id: record.id, kind, label, createdAt: item.createdAt, settledAt: record.completed_at };
}

// Canonical updates keep unchanged items by identity, so each call is parsed once and the returned objects stay
// stable for shallow comparison while unrelated items stream.
const stoppedCallByItem = new WeakMap<AgentItem, StoppedBackgroundCall | null>();

function cachedStoppedCall(item: AgentItem): StoppedBackgroundCall | null {
  let call = stoppedCallByItem.get(item);
  if (call === undefined) {
    call = stoppedCallOf(item);
    stoppedCallByItem.set(item, call);
  }
  return call;
}

function isAfter(left: AgentTurn, right: AgentTurn): boolean {
  return left.createdAt > right.createdAt || left.createdAt === right.createdAt && left.id > right.id;
}

function anchorTurnOf(state: AgentModelState, noticeKey: string | undefined): AgentTurn | null {
  if (!noticeKey?.startsWith(PLANNED_RESTART_NOTICE_KEY_PREFIX)) return null;
  return state.turns[noticeKey.slice(PLANNED_RESTART_NOTICE_KEY_PREFIX.length)] ?? null;
}

function stoppedCallFor(state: AgentModelState, anchor: AgentTurn, item: AgentItem): StoppedBackgroundCall | null {
  if (item.kind !== "tool-call" || item.threadId !== anchor.threadId) return null;
  const turn = state.turns[item.turnId];
  if (!turn || isAfter(turn, anchor)) return null;
  const call = cachedStoppedCall(item);
  return call && anchor.endedAt && call.settledAt > anchor.endedAt ? call : null;
}

/** Identifies the turns up to the anchor; while it holds, an unchanged item keeps its place inside or outside the window. */
function windowKeyOf(state: AgentModelState, anchor: AgentTurn): string {
  const ids: string[] = [];
  for (const turn of Object.values(state.turns)) {
    if (turn.threadId === anchor.threadId && !isAfter(turn, anchor)) ids.push(turn.id);
  }
  return ids.sort().join("\n");
}

interface StoppedCallsCache {
  anchor: AgentTurn;
  items: AgentModelState["items"];
  turns: AgentModelState["turns"];
  windowKey: string;
  byItemId: Map<string, StoppedBackgroundCall>;
  result: readonly StoppedBackgroundCall[];
}

function sortedCalls(byItemId: ReadonlyMap<string, StoppedBackgroundCall>): readonly StoppedBackgroundCall[] {
  if (byItemId.size === 0) return NO_CALLS;
  return [...byItemId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function scanAll(state: AgentModelState, anchor: AgentTurn): Map<string, StoppedBackgroundCall> {
  const byItemId = new Map<string, StoppedBackgroundCall>();
  for (const item of Object.values(state.items)) {
    const call = stoppedCallFor(state, anchor, item);
    if (call) byItemId.set(item.id, call);
  }
  return byItemId;
}

/** Visits only the items whose identity changed; returns whether the stopped calls changed. */
function applyChangedItems(state: AgentModelState, cache: StoppedCallsCache): boolean {
  let changed = false;
  for (const id in state.items) {
    const item = state.items[id];
    if (!item || item === cache.items[id]) continue;
    const call = stoppedCallFor(state, cache.anchor, item);
    if (cache.byItemId.get(id) === call) continue;
    if (call) cache.byItemId.set(id, call);
    else if (!cache.byItemId.delete(id)) continue;
    changed = true;
  }
  for (const id of cache.byItemId.keys()) {
    if (id in state.items) continue;
    cache.byItemId.delete(id);
    changed = true;
  }
  return changed;
}

/**
 * Builds a selector for the background calls a planned-restart wake stopped, in launch order. A wake holds only
 * calls launched after any earlier start, and its anchor is the thread's latest turn, so this start settled its
 * calls after the anchor ended while any earlier start settled its own before. The list is therefore every orphaned
 * call in turns up to the anchor whose settlement came after the anchor's end. Resume notices key on an execution
 * id, not a turn, so they resolve to none.
 *
 * Canonical updates keep unchanged items by identity and the store has no per-turn item index, so after the first
 * scan each update compares item references and reads only the items that changed. Streaming items in later turns
 * then cost one reference check each, with no parse and no sort, and the same array comes back.
 */
export function createPlannedRestartStoppedCallsSelector(noticeKey: string | undefined): (state: AgentModelState) => readonly StoppedBackgroundCall[] {
  let cache: StoppedCallsCache | null = null;
  return (state) => {
    const anchor = anchorTurnOf(state, noticeKey);
    if (!anchor?.endedAt) {
      cache = null;
      return NO_CALLS;
    }
    cache = nextCache(cache, state, anchor);
    return cache.result;
  };
}

function freshCache(state: AgentModelState, anchor: AgentTurn, windowKey: string): StoppedCallsCache {
  const byItemId = scanAll(state, anchor);
  return { anchor, items: state.items, turns: state.turns, windowKey, byItemId, result: sortedCalls(byItemId) };
}

function nextCache(cache: StoppedCallsCache | null, state: AgentModelState, anchor: AgentTurn): StoppedCallsCache {
  if (cache?.anchor !== anchor) return freshCache(state, anchor, windowKeyOf(state, anchor));
  if (cache.items === state.items && cache.turns === state.turns) return cache;
  const windowKey = cache.turns === state.turns ? cache.windowKey : windowKeyOf(state, anchor);
  if (windowKey !== cache.windowKey) return freshCache(state, anchor, windowKey);
  if (applyChangedItems(state, cache)) cache.result = sortedCalls(cache.byItemId);
  cache.items = state.items;
  cache.turns = state.turns;
  return cache;
}
