import { projectBrowserNarrativeResult } from "@mcode/contracts/models/browser-narrative";
import type { ToolCall } from "@/transport/types";
import { isCancelledCall } from "./narrative-builder-helpers";

/** How one finished tool call ended. */
export type ToolCallOutcome = "completed" | "failed" | "cancelled" | "denied";

/** Classifies a tool call's outcome; an error wins over a cancellation. */
export function toolCallOutcome(toolCall: ToolCall): ToolCallOutcome {
  if (toolCall.status === "denied") return "denied";
  if (toolCall.isError) return "failed";
  if (isCancelledCall(toolCall)) return "cancelled";
  return hasFailedBrowserResult(toolCall) ? "failed" : "completed";
}

/**
 * Browser tools can report a failure inside a successful tool result. An
 * interrupted result stays uncounted because the user taking control is not a failure.
 */
function hasFailedBrowserResult(toolCall: ToolCall): boolean {
  if (!toolCall.output) return false;
  const result = projectBrowserNarrativeResult(toolCall.toolName, toolCall.output, toolCall.isError);
  return result?.outcome === "failed";
}

/** A group summary that fades in a narrow column while its failure counts always stay readable. */
export function GroupSummaryLabel({ text, calls }: { text: string; calls: readonly ToolCall[] }) {
  const failed = calls.filter((call) => toolCallOutcome(call) === "failed").length;
  const cancelled = calls.filter((call) => toolCallOutcome(call) === "cancelled").length;
  const denied = calls.filter((call) => toolCallOutcome(call) === "denied").length;
  const outcomes = [
    failed > 0 ? `${failed} failed` : null,
    cancelled > 0 ? `${cancelled} cancelled` : null,
    denied > 0 ? `${denied} denied` : null,
  ].filter(Boolean);
  return (
    <>
      <span className="text-fade">{text}</span>
      {outcomes.length > 0 ? <span className="shrink-0 whitespace-pre">{` · ${outcomes.join(" · ")}`}</span> : null}
    </>
  );
}
