import type { ApprovalReceiptRecord } from "@mcode/contracts";
import type { HookExecutionRecord, ThoughtSegmentRecord, ToolCallRecord } from "@/transport/types";
import {
  preparePersistedNarrative,
  projectPersistedNarrativeItems,
  type PersistedNarrativeInputs,
} from "./persisted-narrative-timeline";
import type { NarrativeItem } from "./types";

export type { PersistedNarrativeInputs } from "./persisted-narrative-timeline";
export {
  persistedHookDetailLines,
  recordToApprovalReceipt,
  recordToHookExecution,
  recordToToolCall,
} from "./persisted-narrative-timeline";

type ContentCache = Map<string, NarrativeItem[]>;
type ApprovalsCache = WeakMap<readonly ApprovalReceiptRecord[], ContentCache>;
type HooksCache = WeakMap<readonly HookExecutionRecord[], ApprovalsCache>;
type ToolsCache = WeakMap<readonly ToolCallRecord[], HooksCache>;

const memoCache = new WeakMap<readonly ThoughtSegmentRecord[], ToolsCache>();
/** Shared key so messages without receipts still hit the identity memo. */
const NO_APPROVALS: readonly ApprovalReceiptRecord[] = [];

/** Reconstructs static timeline rows from persisted narrative records. */
export function buildPersistedNarrativeItems(
  inputs: PersistedNarrativeInputs,
): NarrativeItem[] {
  const approvals = inputs.approvals ?? NO_APPROVALS;
  if (hasNoRecords(inputs, approvals)) return [];

  const messageContent = (inputs.messageContent ?? "").trim();
  const cached = readMemoizedItems(inputs, approvals, messageContent);
  if (cached) return cached;

  const items = projectPersistedNarrativeItems(preparePersistedNarrative(inputs));
  writeMemoizedItems(inputs, approvals, messageContent, items);
  return items;
}

function hasNoRecords(inputs: PersistedNarrativeInputs, approvals: readonly ApprovalReceiptRecord[]): boolean {
  return [inputs.tools, inputs.thoughts, inputs.hooks, approvals].every((records) => records.length === 0);
}

function readMemoizedItems(
  inputs: PersistedNarrativeInputs,
  approvals: readonly ApprovalReceiptRecord[],
  messageContent: string,
): NarrativeItem[] | undefined {
  return memoCache.get(inputs.thoughts)?.get(inputs.tools)?.get(inputs.hooks)?.get(approvals)?.get(messageContent);
}

function writeMemoizedItems(
  inputs: PersistedNarrativeInputs,
  approvals: readonly ApprovalReceiptRecord[],
  messageContent: string,
  items: NarrativeItem[],
): void {
  const toolsCache: ToolsCache = memoCache.get(inputs.thoughts) ?? new WeakMap();
  const hooksCache: HooksCache = toolsCache.get(inputs.tools) ?? new WeakMap();
  const approvalsCache: ApprovalsCache = hooksCache.get(inputs.hooks) ?? new WeakMap();
  const contentCache: ContentCache = approvalsCache.get(approvals) ?? new Map();
  contentCache.set(messageContent, items);
  approvalsCache.set(approvals, contentCache);
  hooksCache.set(inputs.hooks, approvalsCache);
  toolsCache.set(inputs.tools, hooksCache);
  memoCache.set(inputs.thoughts, toolsCache);
}
