import type {
  ToolCallRecord,
  NarrationSegmentRecord,
  HookExecutionRecord,
  ToolCall,
  HookExecution,
} from "@/transport/types";
import { isLikelyFinalResponseTail } from "@mcode/contracts";
import type { NarrationSegment, NarrativeItem } from "./types";

/** Inputs for `buildPersistedNarrativeItems`. */
export interface PersistedNarrativeInputs {
  tools: readonly ToolCallRecord[];
  narrationSegments: readonly NarrationSegmentRecord[];
  hooks: readonly HookExecutionRecord[];
  /** Assistant message body — used for client-side safety-net filtering. */
  messageContent?: string;
}

const AGENT_TOOL_NAME = "Agent";

/**
 * Parse an ISO-8601 timestamp string to epoch ms. Returns 0 on parse failure
 * so chronological sort still orders unparseable rows together at the front.
 */
function isoToMs(s: string | null | undefined): number {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

/** Map a persisted tool record to the live `ToolCall` shape used by row components. */
function recordToToolCall(r: ToolCallRecord): ToolCall {
  return {
    id: r.id,
    toolName: r.tool_name,
    // Live components only inspect a few fields; the input summary suffices
    // for label derivation in the persisted view.
    toolInput: { _summary: r.input_summary },
    output: r.output_summary || null,
    isError: r.status === "failed",
    isComplete: r.status === "completed" || r.status === "failed" || r.status === "cancelled",
    parentToolCallId: r.parent_tool_call_id ?? undefined,
    startedAt: isoToMs(r.started_at),
  };
}

/** Map a persisted narration record to the live `NarrationSegment` shape. */
function recordToNarrationSegment(r: NarrationSegmentRecord): NarrationSegment {
  return {
    text: r.text,
    startedAt: isoToMs(r.started_at),
    endedAt: r.ended_at ? isoToMs(r.ended_at) : undefined,
  };
}

/** Map a persisted hook record to the live `HookExecution` shape. */
function recordToHookExecution(r: HookExecutionRecord): HookExecution {
  // Phase strings from server are arbitrary; coerce to the live discriminator.
  const hookType: HookExecution["hookType"] =
    r.phase === "stop" ? "stop" : "permission";
  return {
    hookName: r.hook_name,
    hookType,
    toolName: r.tool_name ?? undefined,
    status: "completed",
    outputLines: [],
    fullOutput: [],
    durationMs: r.duration_ms ?? undefined,
    didBlock: r.did_block,
    startedAt: isoToMs(r.started_at),
  };
}

/** A unified timeline event sorted by persisted `sort_order` ascending. */
type TimelineEvent =
  | { kind: "narration"; segment: NarrationSegment; sortOrder: number }
  | { kind: "tool"; call: ToolCall; sortOrder: number }
  | { kind: "hook"; hook: HookExecution; sortOrder: number };

/**
 * WeakMap-based memo so `buildPersistedNarrativeItems` does not rebuild the
 * item tree on every render when inputs are stable. Keyed by the
 * `narrationSegments` array reference plus trimmed `messageContent` because
 * the safety-net filter depends on the assistant body even when DB rows are
 * unchanged.
 */
const _memoCache = new WeakMap<
  readonly NarrationSegmentRecord[],
  Map<string, NarrativeItem[]>
>();

/**
 * Build a chronological `NarrativeItem[]` from persisted DB records.
 *
 * Mirrors `buildNarrativeItems` for the live path but sorts by the
 * server-allocated `sort_order` (not wall-clock time) and never emits a
 * `delta` or `active-tool` item — both are live-only constructs.
 *
 * Sub-agent children nest under their parent's `subagent` item via the
 * `parent_tool_call_id` field. Consecutive completed non-Agent tool calls
 * are coalesced into `tool-group` items, matching the live grouping.
 */
export function buildPersistedNarrativeItems(
  inputs: PersistedNarrativeInputs,
): NarrativeItem[] {
  const { tools, narrationSegments, hooks, messageContent } = inputs;

  if (tools.length === 0 && narrationSegments.length === 0 && hooks.length === 0) {
    return [];
  }

  const msgTrimmed = (messageContent ?? "").trim();
  const cachedByContent = _memoCache.get(narrationSegments);
  const cached = cachedByContent?.get(msgTrimmed);
  if (cached !== undefined) return cached;

  // Filter out narration segments that are the assistant's final response to
  // prevent them appearing as narration rows alongside the message body.
  // Server `is_final_response` is primary; client backstop covers older rows
  // persisted before the server-side tagging existed. Backstop reuses the
  // shared classifier in `@mcode/contracts` so the rule lives in one place.
  let filteredSegments = narrationSegments;

  if (narrationSegments.length > 0 && msgTrimmed.length > 0) {
    const adapted = narrationSegments.map((r) => ({
      text: r.text,
      sortOrder: r.sort_order,
    }));
    filteredSegments = narrationSegments.filter((r, idx) => {
      if (r.is_final_response) return false;
      return !isLikelyFinalResponseTail(adapted[idx]!, adapted, msgTrimmed);
    });
  } else if (narrationSegments.length > 0) {
    filteredSegments = narrationSegments.filter((r) => !r.is_final_response);
  }

  // Split tools by parent_tool_call_id.
  const topLevel: ToolCallRecord[] = [];
  const childrenByParent = new Map<string, ToolCallRecord[]>();
  for (const t of tools) {
    if (t.parent_tool_call_id == null) {
      topLevel.push(t);
    } else {
      const siblings = childrenByParent.get(t.parent_tool_call_id) ?? [];
      siblings.push(t);
      childrenByParent.set(t.parent_tool_call_id, siblings);
    }
  }

  // Map all hooks to live shape once.
  const liveHooks: HookExecution[] = hooks.map(recordToHookExecution);

  // Build unified timeline of TOP-LEVEL items, sorted by sort_order.
  const timeline: TimelineEvent[] = [];
  for (const seg of filteredSegments) {
    timeline.push({
      kind: "narration",
      segment: recordToNarrationSegment(seg),
      sortOrder: seg.sort_order,
    });
  }
  for (const t of topLevel) {
    timeline.push({
      kind: "tool",
      call: recordToToolCall(t),
      sortOrder: t.sort_order,
    });
  }
  for (const h of hooks) {
    timeline.push({
      kind: "hook",
      hook: recordToHookExecution(h),
      sortOrder: h.sort_order,
    });
  }
  timeline.sort((a, b) => a.sortOrder - b.sortOrder);

  const items: NarrativeItem[] = [];
  const pendingGroup: ToolCall[] = [];

  const flushGroup = () => {
    if (pendingGroup.length === 0) return;
    items.push({
      type: "tool-group",
      group: { calls: pendingGroup.slice() },
      hasError: pendingGroup.some((c) => c.isError),
      hasCancelled: pendingGroup.some(
        (c) => typeof c.output === "string" && c.output.toLowerCase().includes("cancelled"),
      ),
    });
    pendingGroup.length = 0;
  };

  for (const evt of timeline) {
    if (evt.kind === "narration") {
      flushGroup();
      // Persisted narration segments are always closed — never `isActive`.
      items.push({ type: "narration", segment: evt.segment, isActive: false });
      continue;
    }

    if (evt.kind === "hook") {
      flushGroup();
      items.push({ type: "hook", hook: evt.hook });
      continue;
    }

    const tc = evt.call;
    if (tc.toolName === AGENT_TOOL_NAME) {
      flushGroup();
      const childRecords = childrenByParent.get(tc.id) ?? [];
      const children = childRecords
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order)
        .map(recordToToolCall);
      items.push({
        type: "subagent",
        toolCall: tc,
        children,
        // Persisted hooks aren't currently attributed to a sub-agent boundary,
        // so we pass an empty array - matching how older history loads behave.
        hooks: liveHooks.filter((h) => h.toolName === AGENT_TOOL_NAME),
      });
      continue;
    }

    // Non-Agent tool: coalesce into the current tool-group.
    pendingGroup.push(tc);
  }
  flushGroup();

  const contentCache = _memoCache.get(narrationSegments) ?? new Map<string, NarrativeItem[]>();
  contentCache.set(msgTrimmed, items);
  _memoCache.set(narrationSegments, contentCache);
  return items;
}
