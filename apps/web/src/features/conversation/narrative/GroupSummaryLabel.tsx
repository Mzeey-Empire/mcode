import type { ToolCall } from "@/transport/types";
import { isCancelledCall } from "./narrative-builder-helpers";

/** How one finished tool call ended. */
export type ToolCallOutcome = "completed" | "failed" | "cancelled";

/** Classifies a tool call's outcome; an error wins over a cancellation. */
export function toolCallOutcome(toolCall: ToolCall): ToolCallOutcome {
  if (toolCall.isError) return "failed";
  if (isCancelledCall(toolCall)) return "cancelled";
  return "completed";
}

/** A group summary that fades in a narrow column while its failure counts always stay readable. */
export function GroupSummaryLabel({ text, calls }: { text: string; calls: readonly ToolCall[] }) {
  const failed = calls.filter((call) => toolCallOutcome(call) === "failed").length;
  const cancelled = calls.filter((call) => toolCallOutcome(call) === "cancelled").length;
  const outcomes = [
    failed > 0 ? `${failed} failed` : null,
    cancelled > 0 ? `${cancelled} cancelled` : null,
  ].filter(Boolean);
  return (
    <>
      <span className="text-fade">{text}</span>
      {outcomes.length > 0 ? <span className="shrink-0 whitespace-pre">{` · ${outcomes.join(" · ")}`}</span> : null}
    </>
  );
}
