import type { PermissionDecision } from "@mcode/contracts";
import type { Message, ToolCall, HookExecution } from "@/transport/types";
import type { ThoughtSegment } from "./narrative/types";

/** Compile-time exhaustive check; throws at runtime for unhandled discriminants. */
function assertNever(value: never): never {
  throw new Error(`Unhandled item type: ${(value as { type: string }).type}`);
}

/** Estimated collapsed height (px) for a streaming card virtual item. */
export const STREAMING_CARD_COLLAPSED_HEIGHT = 56;

/** Represents an item rendered in the virtualized chat list: messages, tool indicators, or streaming text. */
export type ChatVirtualItem =
  | { key: string; type: "message"; message: Message }
  | { key: string; type: "active-tools"; toolCalls: readonly ToolCall[] }
  | {
      key: string;
      type: "indicator";
      startTime: number | undefined;
      activeToolCalls: readonly ToolCall[];
    }
  | { key: string; type: "streaming"; text: string }
  | {
      key: string;
      type: "turn-changes";
      messageId: string;
      filesChanged: string[];
      isLatestTurn: boolean;
    }
  | {
      key: string;
      type: "permission-request";
      requestId: string;
      toolName: string;
      input: unknown;
      title?: string;
      settled: boolean;
      decision?: PermissionDecision;
    }
  | {
      key: string;
      type: "hook-activity";
      hooks: readonly HookExecution[];
    }
  | {
      key: string;
      type: "narrative-flow";
      toolCalls: readonly ToolCall[];
      hooks: readonly HookExecution[];
      thoughtSegments: readonly ThoughtSegment[];
      streamingText: string;
      isAgentRunning: boolean;
      startTime: number | undefined;
    };

/**
 * Build the stable segment: messages with optional turn-change summaries.
 * This only changes when messages or persistedFilesChanged change (infrequent).
 */
export function buildStableItems(
  messages: readonly Message[],
  persistedFilesChanged?: Record<string, string[]>,
  latestTurnWithChanges?: string | null,
): ChatVirtualItem[] {
  const items: ChatVirtualItem[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    items.push({ key: msg.id, type: "message", message: msg });

    // File change summary appears after the assistant message
    if (msg.role === "assistant") {
      const files = persistedFilesChanged?.[msg.id];
      if (files && files.length > 0) {
        items.push({
          key: `turn-changes-${msg.id}`,
          type: "turn-changes",
          messageId: msg.id,
          filesChanged: files,
          isLatestTurn: msg.id === latestTurnWithChanges,
        });
      }
    }
  }
  return items;
}

/**
 * Build the volatile segment: permission requests and a single narrative-flow item
 * that consolidates tool calls, hooks, thought segments, streaming text, and indicator.
 * This changes on every tool call event but doesn't depend on messages.
 */
export function buildVolatileItems(
  toolCalls: readonly ToolCall[],
  isAgentRunning: boolean,
  agentStartTime: number | undefined,
  streamingText: string | undefined,
  permissions?: readonly {
    requestId: string;
    toolName: string;
    input?: unknown;
    title?: string;
    settled: boolean;
    decision?: PermissionDecision;
  }[],
  hooks?: readonly HookExecution[],
  thoughtSegments?: readonly ThoughtSegment[],
): ChatVirtualItem[] {
  const items: ChatVirtualItem[] = [];

  // Emit the narrative flow item when agent is running or has tool calls.
  // This replaces the separate "active-tools", "hook-activity", "indicator",
  // and "streaming" items with a single unified item.
  if (isAgentRunning || toolCalls.length > 0) {
    items.push({
      key: "narrative-flow",
      type: "narrative-flow",
      toolCalls,
      hooks: hooks ?? [],
      thoughtSegments: thoughtSegments ?? [],
      streamingText: streamingText ?? "",
      isAgentRunning,
      startTime: agentStartTime,
    });
  }

  // Show all permission requests (settled and unsettled) so the user gets
  // visual confirmation of their allow/deny decision. Settled cards collapse
  // to a single-line badge. The full permissionsByThread entry is cleared
  // when the agent turn ends, so settled cards never trail below the agent's
  // persisted message.
  if (permissions && permissions.length > 0) {
    for (const p of permissions) {
      items.push({
        key: `permission-${p.requestId}`,
        type: "permission-request" as const,
        requestId: p.requestId,
        toolName: p.toolName,
        input: p.input,
        title: p.title,
        settled: p.settled,
        decision: p.decision,
      });
    }
  }

  return items;
}

/**
 * Combine stable and volatile segments into the final virtual item array.
 * When tool calls exist, the narrative-flow item is placed before the last
 * assistant message while permission-request items remain after it.
 */
export function buildVirtualItems(
  stableItems: readonly ChatVirtualItem[],
  volatileItems: readonly ChatVirtualItem[],
  hasToolCalls: boolean,
): ChatVirtualItem[] {
  if (!hasToolCalls || volatileItems.length === 0) {
    return [...stableItems, ...volatileItems];
  }

  // Split volatile items: narrative-flow goes before the last assistant
  // message; permission requests go after it.

  // Find the last assistant message, skipping any trailing turn-changes items
  let lastAssistantIdx = stableItems.length - 1;
  while (lastAssistantIdx >= 0) {
    const item = stableItems[lastAssistantIdx];
    if (item.type === "turn-changes") {
      lastAssistantIdx--;
      continue;
    }
    break;
  }

  const lastItem = stableItems[lastAssistantIdx];
  if (lastItem?.type === "message" && lastItem.message.role === "assistant") {
    const narrativeIdx = volatileItems.findIndex((i) => i.type === "narrative-flow");
    const narrativeItems = narrativeIdx !== -1 ? [volatileItems[narrativeIdx]] : [];
    const tailItems = volatileItems.filter((v) => v.type !== "narrative-flow");
    return [
      ...stableItems.slice(0, lastAssistantIdx),
      ...narrativeItems,
      ...stableItems.slice(lastAssistantIdx),
      ...tailItems,
    ];
  }

  return [...stableItems, ...volatileItems];
}

const LIST_ITEM_RE = /^[-*]\s|^\d+\.\s/;
const LINE_HEIGHT = 22;
const CHARS_PER_LINE = 65;
const TABLE_ROW_HEIGHT = 44;
const CODE_BLOCK_PADDING = 32;
const HEADING_EXTRA = 16;
const LIST_ITEM_HEIGHT = 28;

/**
 * Estimate rendered height from markdown content.
 * Accounts for tables, code blocks, headings, and lists that render
 * much taller than their raw character count suggests.
 */
function estimateMarkdownHeight(content: string): number {
  let height = 0;
  let inCodeBlock = false;
  let start = 0;

  while (start <= content.length) {
    let end = content.indexOf("\n", start);
    if (end === -1) end = content.length;
    const line = content.substring(start, end);
    const trimmed = line.trimStart();

    if (trimmed.startsWith("```")) {
      height += CODE_BLOCK_PADDING / 2;
      inCodeBlock = !inCodeBlock;
      start = end + 1;
      continue;
    }

    if (inCodeBlock) {
      height += LINE_HEIGHT;
      start = end + 1;
      continue;
    }

    // Table rows (| col | col |) and separator rows (|---|---|)
    if (trimmed.startsWith("|")) {
      height += trimmed.includes("---") ? 4 : TABLE_ROW_HEIGHT;
      start = end + 1;
      continue;
    }

    // Headings
    if (trimmed.startsWith("#")) {
      height += LINE_HEIGHT + HEADING_EXTRA;
      start = end + 1;
      continue;
    }

    // List items
    if (LIST_ITEM_RE.test(trimmed)) {
      const wrappedLines = Math.max(1, Math.ceil(trimmed.length / CHARS_PER_LINE));
      height += LIST_ITEM_HEIGHT + (wrappedLines - 1) * LINE_HEIGHT;
      start = end + 1;
      continue;
    }

    // Empty line = paragraph break
    if (trimmed.length === 0) {
      height += 12;
      start = end + 1;
      continue;
    }

    // Regular text, may wrap
    const wrappedLines = Math.max(1, Math.ceil(trimmed.length / CHARS_PER_LINE));
    height += wrappedLines * LINE_HEIGHT;
    start = end + 1;
  }

  return Math.max(LINE_HEIGHT, height);
}

/** Estimate pixel height for a virtual item before `measureElement` fires. */
export function estimateItemHeight(item: ChatVirtualItem): number {
  switch (item.type) {
    case "message": {
      const { message } = item;
      if (message.role === "system") return 40;
      const contentHeight = estimateMarkdownHeight(message.content);
      if (message.role === "user") return 52 + contentHeight;
      return 80 + contentHeight;
    }
    case "active-tools":
      return Math.min(item.toolCalls.length * 48, 400);
    case "indicator":
      return 48;
    case "streaming":
      return STREAMING_CARD_COLLAPSED_HEIGHT;
    case "turn-changes": {
      // Collapsed: ~44px. Expanded: 44px header + 32px per file row (capped at 50) + overflow link.
      const visibleFiles = Math.min(item.filesChanged.length, 50);
      const overflowRow = item.filesChanged.length > 50 ? 28 : 0;
      return item.isLatestTurn ? 44 + visibleFiles * 32 + overflowRow : 44;
    }
    case "permission-request":
      return item.settled ? 36 : 120;
    case "hook-activity":
      // Header (28px) + one row (28px) per hook, capped at 300px
      return Math.min(28 + item.hooks.length * 28, 300);
    case "narrative-flow": {
      const segCount = item.thoughtSegments.length;
      const toolCount = item.toolCalls.length;
      const hookCount = item.hooks.length;
      return Math.min(segCount * 60 + toolCount * 32 + hookCount * 28 + 48, 600);
    }
    default:
      return assertNever(item);
  }
}
