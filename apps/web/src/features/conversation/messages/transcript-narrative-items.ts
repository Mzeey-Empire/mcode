import type { ToolCall } from "@/transport/types";
import { buildNarrativeItems } from "../narrative/build-narrative";
import { buildPersistedNarrativeItems, recordToToolCall } from "../narrative/build-persisted-narrative";
import type { NarrativeItem } from "../narrative/types";
import type { ToolCallTransition } from "./useToolCallTransitions";
import { type ChatVirtualItem, type CurrentTurnResponseIdentity, type PersistedNarrativeRecordsByMessage } from "./virtual-items";

/** One independently measured narrative row in the transcript's scroll window. */
export interface TranscriptNarrativeItem {
  readonly type: "narrative-row";
  readonly key: string;
  readonly item: NarrativeItem;
  readonly index: number;
  readonly allToolCalls: readonly ToolCall[];
  readonly transition?: "entering" | "exiting";
}

/** An expanded group child measured and mounted independently of its summary. */
export interface TranscriptToolItem {
  readonly type: "tool-row";
  readonly key: string;
  readonly groupKey: string;
  readonly toolCall: ToolCall;
  readonly index: number;
  readonly count: number;
}

/** Inserts open group children into the existing viewport, without another scroll owner. */
export function expandTranscriptToolGroups(
  items: readonly (ChatVirtualItem | TranscriptNarrativeItem)[],
  expandedGroups: ReadonlySet<string>,
): (ChatVirtualItem | TranscriptNarrativeItem | TranscriptToolItem)[] {
  return items.flatMap((row): (ChatVirtualItem | TranscriptNarrativeItem | TranscriptToolItem)[] => {
    if (row.type !== "narrative-row" || row.item.type !== "tool-group" || !expandedGroups.has(row.key)) return [row];
    const calls = row.item.group.calls;
    return [row, ...calls.map((toolCall, index): TranscriptToolItem => ({
      type: "tool-row", key: `${row.key}:call:${toolCall.id}`, groupKey: row.key, toolCall, index, count: calls.length,
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

function narrativeRows(prefix: string, items: readonly NarrativeItem[], allToolCalls: readonly ToolCall[]): TranscriptNarrativeItem[] {
  const occurrences = new Map<string, number>();
  return items.filter((item) => item.type !== "delta" && item.type !== "hook").map((item, index) => {
    const identity = rowIdentity(item);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { type: "narrative-row", key: `narrative:${prefix}:${identity}:${occurrence}`, item, index, allToolCalls };
  });
}

/** Expands complete turns into rows without changing message or narrative order. */
export function expandTranscriptNarrative(
  items: readonly ChatVirtualItem[],
  recordsByMessage: PersistedNarrativeRecordsByMessage,
  currentTurn?: CurrentTurnResponseIdentity,
  transitions: ReadonlyMap<string, ToolCallTransition> = new Map(),
): (ChatVirtualItem | TranscriptNarrativeItem)[] {
  const messages = new Map(items.flatMap((item) => item.type === "message" ? [[item.message.id, item.message] as const] : []));
  const livePrefix = currentTurn?.executionId ?? currentTurn?.responseKey ?? currentTurn?.threadId ?? "__active_thread__";
  return items.flatMap((item): (ChatVirtualItem | TranscriptNarrativeItem)[] => {
    if (item.type === "narrative-flow") {
      return liveNarrativeRows(item, livePrefix, transitions);
    }
    if (item.type !== "persisted-narrative") return [item];
    const records = recordsByMessage[item.messageId];
    if (!records) return [];
    const message = messages.get(item.messageId);
    const prefix = message?.outcomeExecutionId ?? item.messageId;
    return narrativeRows(prefix, buildPersistedNarrativeItems({ ...records, messageContent: item.messageContent }), records.tools.map(recordToToolCall));
  });
}

function liveNarrativeRows(
  item: Extract<ChatVirtualItem, { type: "narrative-flow" }>,
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
