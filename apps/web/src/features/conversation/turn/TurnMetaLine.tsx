import { workFoldLabel } from "./WorkFold";

/** Props for {@link TurnMetaLine}. */
export interface TurnMetaLineProps {
  /** Top-level tool calls in the turn. Sub-agents count as steps too. */
  steps: number;
  /** Top-level Agent tool calls in the turn. */
  subagents: number;
  /** Elapsed work for a provider continuation with no tool steps. */
  durationMs?: number;
}

/** Formats "7 steps · 1 sub-agent", omitting zero counts. */
export function turnMetaLabel({ steps, subagents, durationMs }: TurnMetaLineProps): string {
  const labels: string[] = [];
  if (durationMs !== undefined) labels.push(workFoldLabel("completed", durationMs));
  if (steps > 0 || durationMs !== undefined) labels.push(`${steps} ${steps === 1 ? "step" : "steps"}`);
  if (subagents > 0) labels.push(`${subagents} ${subagents === 1 ? "sub-agent" : "sub-agents"}`);
  return labels.join(" · ");
}

/** Closes a settled turn with its counts, plus elapsed work for a tool-free continuation. */
export function TurnMetaLine(props: TurnMetaLineProps) {
  const label = turnMetaLabel(props);
  if (!label) return null;
  return (
    <div className="flex h-6 items-center gap-3" data-testid="turn-meta-line">
      <span className="shrink-0 font-mono text-caption text-muted">{label}</span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}
