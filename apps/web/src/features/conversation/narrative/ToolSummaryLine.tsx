import { useId, useState } from "react";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import {
  TOOL_ICONS,
  TOOL_LABELS,
  TOOL_OUTCOME_VERBS,
  DEFAULT_ICON,
  buildToolSummaryText,
  resolveToolName,
  isShellTool,
} from "@/components/chat/tool-renderers/constants";
import type { ToolCall } from "@/transport/types";
import type { ToolGroup } from "./types";
import { extractToolInputDetail } from "./tool-detail";
import { isCancelledCall } from "./narrative-builder-helpers";
import { ToolOutputTruncationNotice } from "./ToolOutputTruncationNotice";
import { ShellToolCallRow } from "./ShellToolCallRow";
import { NarrativeToolRow, NarrativeToolRowDetail, useRowExpansion, type RowExpansion } from "./NarrativeToolRow";
import {
  BrowserActivitySummary,
  isBrowserNarrativeCall,
} from "./BrowserActivityRow";

interface ToolSummaryLineProps {
  /** Keeps expansion in the owning viewport when children are separate virtual rows. */
  virtualExpansion?: RowExpansion;
  /** The group of consecutive tool calls to summarize. */
  group: ToolGroup;
}

type ToolCallOutcome = "completed" | "failed" | "cancelled";

function toolCallOutcome(toolCall: ToolCall): ToolCallOutcome {
  if (toolCall.isError) return "failed";
  if (isCancelledCall(toolCall)) return "cancelled";
  return "completed";
}

function toolCallLabel(toolCall: ToolCall, outcome: ToolCallOutcome): string {
  const canonicalName = resolveToolName(toolCall.toolName);
  if (outcome === "completed") return TOOL_LABELS[canonicalName] ?? toolCall.toolName;
  return `${TOOL_OUTCOME_VERBS[canonicalName] ?? toolCall.toolName} ${outcome}`;
}

function ApprovalReviewRow({ toolCall }: { toolCall: ToolCall }) {
  const outcome = toolCallOutcome(toolCall);
  const label = !toolCall.isComplete ? "Reviewing" : outcome === "failed" ? "Review failed" : "Reviewed";
  return (
    <NarrativeToolRow icon={DEFAULT_ICON} label={label}>
      {toolCall.output ? <NarrativeToolRowDetail kind="file">{toolCall.output}</NarrativeToolRowDetail> : null}
    </NarrativeToolRow>
  );
}

/** A failed call's output is the only thing worth disclosing for a non-shell row. */
function FailedToolCallOutput({ toolCall, panelId }: { toolCall: ToolCall; panelId: string }) {
  return (
    <section
      id={panelId}
      aria-label="Tool output"
      className="mt-1 flex min-w-0 max-w-full flex-col gap-1 overflow-hidden rounded-lg border border-border/60 bg-hover/25 px-3 py-2"
    >
      <ToolOutputTruncationNotice toolCall={toolCall} />
      <pre className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-ink/75">
        {toolCall.output}
      </pre>
    </section>
  );
}

function GenericToolCallRow({ toolCall, expansion }: { toolCall: ToolCall; expansion?: RowExpansion }) {
  const { open, onToggle } = useRowExpansion(expansion);
  const panelId = useId();
  const outcome = toolCallOutcome(toolCall);
  const Icon = TOOL_ICONS[resolveToolName(toolCall.toolName)] ?? DEFAULT_ICON;
  const detail = extractToolInputDetail(toolCall);
  const hasFailureOutput = outcome === "failed" && Boolean(toolCall.output);

  return (
    <div className="min-w-0 max-w-full">
      <NarrativeToolRow
        icon={Icon}
        label={toolCallLabel(toolCall, outcome)}
        disclosure={hasFailureOutput
          ? { open, onToggle, controlsId: open ? panelId : undefined }
          : undefined}
      >
        <NarrativeToolRowDetail kind="file">{detail}</NarrativeToolRowDetail>
      </NarrativeToolRow>
      {hasFailureOutput && open ? <FailedToolCallOutput toolCall={toolCall} panelId={panelId} /> : null}
    </div>
  );
}

/** Renders one tool call as its own collapsed row. */
export function ToolCallRow({ toolCall, expansion }: { toolCall: ToolCall; expansion?: RowExpansion }) {
  if (toolCall.toolName === "Approval review") return <ApprovalReviewRow toolCall={toolCall} />;
  if (isShellTool(toolCall.toolName)) return <ShellToolCallRow toolCall={toolCall} expansion={expansion} />;
  return <GenericToolCallRow toolCall={toolCall} expansion={expansion} />;
}

/**
 * Whether a group renders as its lone call's own row. Such a group discloses
 * that call's output in place, so it never lists children as separate rows.
 */
export function rendersAsSingleCallRow(calls: readonly ToolCall[]): boolean {
  return calls.length === 1 && !calls.some(isBrowserNarrativeCall);
}

/** Renders one completed tool call inside a semantic list. */
export function ToolCallDetailRow({ toolCall }: { toolCall: ToolCall }) {
  return (
    <li className="min-w-0 max-w-full">
      <ToolCallRow toolCall={toolCall} />
    </li>
  );
}

/** The summary fades in a narrow column, but the failure counts always stay readable. */
function GroupSummaryLabel({ calls }: { calls: readonly ToolCall[] }) {
  const failed = calls.filter((call) => toolCallOutcome(call) === "failed").length;
  const cancelled = calls.filter((call) => toolCallOutcome(call) === "cancelled").length;
  const outcomes = [
    failed > 0 ? `${failed} failed` : null,
    cancelled > 0 ? `${cancelled} cancelled` : null,
  ].filter(Boolean);
  return (
    <>
      <span className="text-fade">{buildToolSummaryText(calls)}</span>
      {outcomes.length > 0 ? <span className="shrink-0 whitespace-pre">{` · ${outcomes.join(" · ")}`}</span> : null}
    </>
  );
}

function ToolGroupRow({ calls, open, onToggle, listsChildren }: {
  calls: readonly ToolCall[];
  open: boolean;
  onToggle: () => void;
  /** False when the owning viewport renders the children as its own rows. */
  listsChildren: boolean;
}) {
  const firstCall = calls[0];
  const LeadingIcon = firstCall ? (TOOL_ICONS[resolveToolName(firstCall.toolName)] ?? DEFAULT_ICON) : DEFAULT_ICON;
  return (
    <>
      <NarrativeToolRow icon={LeadingIcon} label={<GroupSummaryLabel calls={calls} />} disclosure={{ open, onToggle }} />
      {open && listsChildren ? (
        <AnimatedCollapsible open>
          <ul className="mt-1 min-w-0 max-w-full space-y-1 pb-2 pl-6">
            {calls.map((call) => <ToolCallDetailRow key={call.id} toolCall={call} />)}
          </ul>
        </AnimatedCollapsible>
      ) : null}
    </>
  );
}

/**
 * Renders a group of consecutive tool calls as one collapsed row.
 *
 * A lone call is its own row, so a single edit reads "Edited file" and a lone
 * command keeps its transcript. Several calls collapse into a summary such as
 * "Read 3 files · 1 failed" that expands into one row per call.
 */
export function ToolSummaryLine({ group, virtualExpansion }: ToolSummaryLineProps) {
  const [localOpen, setOpen] = useState(false);
  const { calls } = group;

  if (calls.some(isBrowserNarrativeCall)) {
    return (
      <BrowserActivitySummary
        calls={calls}
        virtualExpansion={virtualExpansion}
        renderOtherCall={(call) => <ToolCallDetailRow key={call.id} toolCall={call} />}
      />
    );
  }

  const [firstCall] = calls;
  return (
    <div
      className="min-w-0 max-w-full"
      data-first-tool-call-id={firstCall?.id}
      data-last-tool-call-id={calls.at(-1)?.id}
    >
      {rendersAsSingleCallRow(calls) && firstCall ? (
        <ToolCallRow toolCall={firstCall} expansion={virtualExpansion} />
      ) : (
        <ToolGroupRow
          calls={calls}
          open={virtualExpansion?.open ?? localOpen}
          onToggle={virtualExpansion?.onToggle ?? (() => setOpen((previous) => !previous))}
          listsChildren={!virtualExpansion}
        />
      )}
    </div>
  );
}
