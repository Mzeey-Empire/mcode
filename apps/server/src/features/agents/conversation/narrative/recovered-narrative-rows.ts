import type { ParentNarrativeRecoveryItem } from "@mcode/contracts";
import type { CreateToolCallRecordInput } from "../../tools/persistence/tool-call-record-store.js";
import type { CreateThoughtSegmentInput } from "./persistence/thought-segment-store.js";
import type { CreateHookExecutionInput } from "../../events/persistence/hook-execution-store.js";
type RecoveredToolCallItem = Extract<ParentNarrativeRecoveryItem, { kind: "toolCall" }>;

/** Pure row projection shared by main recovery commands and worker transactions. */
export interface RecoveredNarrativeRows { tools: CreateToolCallRecordInput[]; thoughts: CreateThoughtSegmentInput[]; hooks: CreateHookExecutionInput[]; }
class RecoveredNarrativeProjection {
rows(
    messageId: string,
    items: readonly ParentNarrativeRecoveryItem[],
  ): RecoveredNarrativeRows {
    const tools: CreateToolCallRecordInput[] = [];
    const thoughts: CreateThoughtSegmentInput[] = [];
    const hooks: CreateHookExecutionInput[] = [];
    for (const item of items) {
      if (item.kind === "toolCall") tools.push(this.recoveredToolCall(messageId, item));
      if (item.kind === "narrationSegment") thoughts.push(this.recoveredThought(messageId, item));
      if (item.kind === "hook") hooks.push(this.recoveredHook(messageId, item));
    }
    return { tools, thoughts, hooks };
  }

private recoveredToolCall(
    messageId: string,
    item: RecoveredToolCallItem,
  ): CreateToolCallRecordInput {
    return {
      ...this.recoveredToolCallIdentity(messageId, item),
      ...this.recoveredToolCallPresentation(item),
      ...this.recoveredToolCallOutput(item),
      ...this.recoveredToolCallState(item),
    };
  }

private recoveredToolCallIdentity(messageId: string, item: RecoveredToolCallItem) {
    const record = item.record;
    return {
      toolCallId: record.id,
      messageId,
      toolName: record.tool_name,
      displayName: this.optionalRecoveryValue(record.display_name),
      providerAgentKey: this.optionalRecoveryValue(record.provider_agent_key),
      subagentIdentityKey: this.optionalRecoveryValue(record.subagent_identity_key),
      subagentProviderName: this.optionalRecoveryValue(record.subagent_provider_name),
      parentToolCallId: this.optionalRecoveryValue(record.parent_tool_call_id),
    };
  }

private recoveredToolCallPresentation(item: RecoveredToolCallItem) {
    const record = item.record;
    return {
      subagentPrompt: this.optionalRecoveryValue(record.subagent_prompt),
      subagentType: this.optionalRecoveryValue(record.subagent_type),
      subagentAgentId: this.optionalRecoveryValue(record.subagent_agent_id),
      subagentDurationMs: this.optionalRecoveryValue(record.subagent_duration_ms),
      model: this.optionalRecoveryValue(record.model),
      reasoningEffort: this.optionalRecoveryValue(record.reasoning_effort),
    };
  }

private recoveredToolCallOutput(item: RecoveredToolCallItem) {
    const record = item.record;
    const optionalOutput = this.recoveredOptionalToolCallOutput(record);
    return {
      inputSummary: record.input_summary,
      outputSummary: record.output_summary,
      ...optionalOutput,
    };
  }

private recoveredOptionalToolCallOutput(item: RecoveredToolCallItem["record"]) {
    const output: Partial<CreateToolCallRecordInput> = {};
    if (item.output_truncated) output.outputTruncated = true;
    if (item.output_total_bytes != null) output.outputTotalBytes = item.output_total_bytes;
    if (item.output_artifact_path) output.outputArtifactPath = item.output_artifact_path;
    if (item.exit_code != null) output.exitCode = item.exit_code;
    return output;
  }

private recoveredToolCallState(item: RecoveredToolCallItem) {
    const record = item.record;
    return {
      status: record.status,
      startedAt: record.started_at,
      completedAt: this.optionalRecoveryValue(record.completed_at),
      sortOrder: record.sort_order,
    };
  }

private optionalRecoveryValue<T>(value: T | null | undefined): T | undefined {
    return value ?? undefined;
  }

private recoveredThought(
    messageId: string,
    item: Extract<ParentNarrativeRecoveryItem, { kind: "narrationSegment" }>,
  ): CreateThoughtSegmentInput {
    return {
      id: item.record.id,
      messageId,
      text: item.record.text,
      startedAt: item.record.started_at,
      endedAt: item.record.ended_at,
      sortOrder: item.record.sort_order,
      ...(item.record.is_final_response ? { isFinalResponse: item.record.is_final_response } : {}),
    };
  }

private recoveredHook(
    messageId: string,
    item: Extract<ParentNarrativeRecoveryItem, { kind: "hook" }>,
  ): CreateHookExecutionInput {
    return {
      id: item.record.id,
      messageId,
      hookName: item.record.hook_name,
      toolName: item.record.tool_name,
      phase: item.record.phase,
      payload: item.record.payload,
      durationMs: item.record.duration_ms,
      didBlock: item.record.did_block,
      startedAt: item.record.started_at,
      endedAt: item.record.ended_at,
      sortOrder: item.record.sort_order,
    };
  }
}

/** Convert receipt-backed recovery evidence without reading or writing SQLite. */
export function recoveredNarrativeRows(messageId: string, items: readonly ParentNarrativeRecoveryItem[]): RecoveredNarrativeRows {
 return new RecoveredNarrativeProjection().rows(messageId, items);
}
