import type { SubagentRosterEntry } from "@mcode/contracts";
import { formatReasoningLabel, resolveModelDisplayLabel } from "@/lib/format-model-label";

/** The entry's agent, model, and effort labeled the way the composer labels them, leaving out what was not reported. */
export function subagentKind(entry: Pick<SubagentRosterEntry, "subagentType" | "model" | "reasoningEffort">): string {
  const run = [
    entry.model && resolveModelDisplayLabel(entry.model),
    entry.reasoningEffort && formatReasoningLabel(entry.reasoningEffort),
  ].filter(Boolean).join(" ");
  return [entry.subagentType, run].filter(Boolean).join(" · ");
}
