import type { Message, ToolCall } from "@/transport/types";
import { buildNarrativeItems } from "../narrative/build-narrative";
import { buildPersistedNarrativeItems, recordToToolCall } from "../narrative/build-persisted-narrative";
import type { NarrativeItem } from "../narrative/types";
import { rendersAsSingleCallRow } from "../narrative/ToolSummaryLine";
import type { ToolCallTransition } from "./useToolCallTransitions";
import { type ChatVirtualItem, type CurrentTurnResponseIdentity, type PersistedNarrativeRecords, type PersistedNarrativeRecordsByMessage } from "./virtual-items";

const PERSISTED_NARRATIVE_VISIBLE_TOOL_LIMIT = 32;

type PersistedNarrativeRecordSet = NonNullable<PersistedNarrativeRecords>;
type PersistedToolRecord = PersistedNarrativeRecordSet["tools"][number];

/** One independently measured narrative row in the transcript's scroll window. */
export interface TranscriptNarrativeItem {
  readonly type: "narrative-row";
  readonly key: string;
  /** Assistant message whose persisted detail produced this virtual row. */
  readonly messageId?: string;
  readonly item: NarrativeItem;
  readonly index: number;
  readonly allToolCalls: readonly ToolCall[];
  readonly transition?: "entering" | "exiting";
}

/** An expanded group child measured and mounted independently of its summary. */
export interface TranscriptToolItem {
  readonly type: "tool-row";
  readonly key: string;
  /** Assistant message whose persisted tool group produced this virtual row. */
  readonly messageId?: string;
  readonly groupKey: string;
  /** Output keys of every call in the group, any of which holds the group open. */
  readonly groupCallKeys: readonly string[];
  readonly toolCall: ToolCall;
  readonly index: number;
  readonly count: number;
}

/** The approval-review sentence that opens an expanded work fold. */
export interface TranscriptFoldNoteItem {
  readonly type: "fold-note";
  readonly key: string;
  readonly messageId: string;
  readonly text: string;
}

function callDisclosureKey(call: ToolCall): string {
  return `tool-call:${call.id}`;
}

/**
 * Open-state key for the output of the one call a row discloses. Running,
 * lone, and grouped rows of a call share it, so a manual open survives the
 * call completing or its group growing.
 */
export function toolCallDisclosureKey(row: TranscriptNarrativeItem | TranscriptToolItem): string | undefined {
  const call = row.type === "tool-row" ? row.toolCall
    : row.item.type === "active-tool" ? row.item.toolCall
    : row.item.type === "tool-group" && rendersAsSingleCallRow(row.item.group.calls) ? row.item.group.calls[0]
    : undefined;
  return call ? callDisclosureKey(call) : undefined;
}

/** Output keys of the calls in the tool group a row belongs to. */
export function transcriptGroupCallKeys(row: TranscriptNarrativeItem | TranscriptToolItem): readonly string[] {
  if (row.type === "tool-row") return row.groupCallKeys;
  return row.item.type === "tool-group" ? row.item.group.calls.map(callDisclosureKey) : [];
}

/**
 * A group is open while its own key or any of its calls' output is open, so a
 * call the user opened never lands hidden in a collapsed group when it completes.
 */
export function isTranscriptGroupOpen(row: TranscriptNarrativeItem | TranscriptToolItem, open: ReadonlySet<string>): boolean {
  return open.has(row.type === "tool-row" ? row.groupKey : row.key)
    || transcriptGroupCallKeys(row).some((key) => open.has(key));
}

/** Inserts open group children into the existing viewport, without another scroll owner. */
export function expandTranscriptToolGroups(
  items: readonly (ChatVirtualItem | TranscriptNarrativeItem | TranscriptFoldNoteItem)[],
  expandedGroups: ReadonlySet<string>,
): (ChatVirtualItem | TranscriptNarrativeItem | TranscriptFoldNoteItem | TranscriptToolItem)[] {
  return items.flatMap((row): (ChatVirtualItem | TranscriptNarrativeItem | TranscriptFoldNoteItem | TranscriptToolItem)[] => {
    if (row.type !== "narrative-row" || row.item.type !== "tool-group" || !isTranscriptGroupOpen(row, expandedGroups)) return [row];
    const calls = row.item.group.calls;
    if (rendersAsSingleCallRow(calls)) return [row];
    const groupCallKeys = transcriptGroupCallKeys(row);
    return [row, ...calls.map((toolCall, index): TranscriptToolItem => ({
      type: "tool-row", key: `${row.key}:call:${toolCall.id}`, groupKey: row.key, groupCallKeys, toolCall, index, count: calls.length,
      messageId: row.messageId,
    }))];
  });
}

function rowIdentity(item: NarrativeItem): string {
  switch (item.type) {
    case "thought": return `thought:${item.segment.startedAt}`;
    case "tool-group": return `tool:${item.group.calls[0]?.id}`;
    case "active-tool": return `tool:${item.toolCall.id}`;
    case "hook": return `hook:${item.hook.hookName}:${item.hook.startedAt}`;
    case "subagent": return `subagent:${item.toolCall.id}`;
    case "delta": return "delta";
  }
}


function includePersistedToolWithParents(
  record: PersistedToolRecord,
  byId: ReadonlyMap<string, PersistedToolRecord>,
  selected: Set<string>,
): void {
  if (selected.has(record.id)) return;
  selected.add(record.id);
  const parent = record.parent_tool_call_id ? byId.get(record.parent_tool_call_id) : undefined;
  if (parent) includePersistedToolWithParents(parent, byId, selected);
}

function visiblePersistedTools(
  tools: PersistedNarrativeRecordSet["tools"],
): PersistedNarrativeRecordSet["tools"] {
  if (tools.length <= PERSISTED_NARRATIVE_VISIBLE_TOOL_LIMIT) return tools;
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  const ordered = [...tools].sort((left, right) => left.sort_order - right.sort_order || left.id.localeCompare(right.id));
  const selected = new Set<string>();
  for (let index = ordered.length - 1; index >= 0 && selected.size < PERSISTED_NARRATIVE_VISIBLE_TOOL_LIMIT; index -= 1) {
    includePersistedToolWithParents(ordered[index]!, byId, selected);
  }
  return tools.filter((tool) => selected.has(tool.id));
}

function visiblePersistedRecords(
  records: PersistedNarrativeRecordSet,
): PersistedNarrativeRecordSet {
  const tools = visiblePersistedTools(records.tools);
  return tools === records.tools ? records : { ...records, tools };
}

function narrativeRows(
  prefix: string,
  items: readonly NarrativeItem[],
  allToolCalls: readonly ToolCall[],
  messageId?: string,
): TranscriptNarrativeItem[] {
  const occurrences = new Map<string, number>();
  return items.filter((item) => item.type !== "delta" && item.type !== "hook").map((item, index) => {
    const identity = rowIdentity(item);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return {
      type: "narrative-row",
      key: `narrative:${prefix}:${identity}:${occurrence}`,
      messageId,
      item,
      index,
      allToolCalls,
    };
  });
}

type ExpandedTranscriptItem = ChatVirtualItem | TranscriptNarrativeItem | TranscriptFoldNoteItem;
type WorkFoldVirtualItem = Extract<ChatVirtualItem, { type: "work-fold" }>;
type NarrativeFlowVirtualItem = Extract<ChatVirtualItem, { type: "narrative-flow" }>;

/**
 * Expands open work folds into their narrative rows without changing message order.
 * A settled current turn still carries its live narrative-flow item after the fold,
 * so an open fold shows those live rows and a closed fold drops them. Saved records stand in only when the
 * live state shows nothing, because a stopped turn can drop its tools and keep only the answer's thought.
 */
export function expandTranscriptNarrative(
  items: readonly ChatVirtualItem[],
  recordsByMessage: PersistedNarrativeRecordsByMessage,
  expandedFolds: ReadonlySet<string>,
  currentTurn?: CurrentTurnResponseIdentity,
  transitions: ReadonlyMap<string, ToolCallTransition> = new Map(),
): ExpandedTranscriptItem[] {
  const context: ExpansionContext = {
    recordsByMessage,
    expandedFolds,
    transitions,
    livePrefix: livePrefixFor(currentTurn),
    messages: new Map(items.flatMap((item) => item.type === "message" ? [[item.message.id, item.message] as const] : [])),
  };
  const expanded: ExpandedTranscriptItem[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const next = items[index + 1];
    const live = item.type === "work-fold" && next?.type === "narrative-flow" ? next : undefined;
    if (live) index += 1;
    expanded.push(...expandItem(item, live, context));
  }
  return expanded;
}

interface ExpansionContext {
  recordsByMessage: PersistedNarrativeRecordsByMessage;
  expandedFolds: ReadonlySet<string>;
  transitions: ReadonlyMap<string, ToolCallTransition>;
  livePrefix: string;
  messages: ReadonlyMap<string, Message>;
}

function livePrefixFor(currentTurn: CurrentTurnResponseIdentity | undefined): string {
  return currentTurn?.executionId ?? currentTurn?.responseKey ?? currentTurn?.threadId ?? "__active_thread__";
}

function expandItem(
  item: ChatVirtualItem,
  live: NarrativeFlowVirtualItem | undefined,
  context: ExpansionContext,
): ExpandedTranscriptItem[] {
  if (item.type === "narrative-flow") return liveNarrativeRows(item, context.livePrefix, context.transitions);
  if (item.type !== "work-fold") return [item];
  return context.expandedFolds.has(item.key) ? [item, ...foldChildren(item, live, context)] : [item];
}

function foldChildren(
  fold: WorkFoldVirtualItem,
  live: NarrativeFlowVirtualItem | undefined,
  context: ExpansionContext,
): ExpandedTranscriptItem[] {
  const note: TranscriptFoldNoteItem[] = fold.approvalNote
    ? [{ type: "fold-note", key: `${fold.key}:approval`, messageId: fold.messageId, text: fold.approvalNote }]
    : [];
  const liveRows = live ? liveNarrativeRows(live, context.livePrefix, context.transitions) : [];
  const rows = live && (liveRows.length > 0 || !context.recordsByMessage[fold.messageId])
    ? liveRows
    : persistedFoldRows(fold, context.recordsByMessage, context.messages.get(fold.messageId)?.outcomeExecutionId);
  return [...note, ...rows];
}

function persistedFoldRows(
  fold: WorkFoldVirtualItem,
  recordsByMessage: PersistedNarrativeRecordsByMessage,
  outcomeExecutionId: string | null | undefined,
): TranscriptNarrativeItem[] {
  const records = recordsByMessage[fold.messageId];
  if (!records) return [];
  const visibleRecords = visiblePersistedRecords(records);
  return narrativeRows(
    outcomeExecutionId ?? fold.messageId,
    buildPersistedNarrativeItems({ ...visibleRecords, messageContent: fold.messageContent }),
    visibleRecords.tools.map(recordToToolCall),
    fold.messageId,
  );
}

function liveNarrativeRows(
  item: NarrativeFlowVirtualItem,
  prefix: string,
  transitions: ReadonlyMap<string, ToolCallTransition>,
): TranscriptNarrativeItem[] {
  const toolCalls = item.toolCalls.map((call) => {
    const transition = transitions.get(call.id);
    return transition?.phase === "exiting" ? transition.call : call;
  });
  const current = new Map(item.toolCalls.map((call) => [call.id, call]));
  const rows = narrativeRows(prefix, buildNarrativeItems({ ...item, toolCalls }).items, item.toolCalls);
  return rows.map((row) => {
    if (row.item.type !== "active-tool") return row;
    return {
      ...row,
      transition: transitions.get(row.item.toolCall.id)?.phase,
      item: { ...row.item, toolCall: current.get(row.item.toolCall.id)! },
    };
  });
}
