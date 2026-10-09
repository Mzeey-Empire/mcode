/** Props for {@link TurnMetaLine}. */
export interface TurnMetaLineProps {
  /** Top-level tool calls in the turn. Sub-agents count as steps too. */
  steps: number;
  /** Top-level Agent tool calls in the turn. */
  subagents: number;
}

/** Formats "7 steps · 1 sub-agent", omitting zero counts. */
export function turnMetaLabel({ steps, subagents }: TurnMetaLineProps): string {
  const labels: string[] = [];
  if (steps > 0) labels.push(`${steps} ${steps === 1 ? "step" : "steps"}`);
  if (subagents > 0) labels.push(`${subagents} ${subagents === 1 ? "sub-agent" : "sub-agents"}`);
  return labels.join(" · ");
}

/** Closes a settled turn with its step counts and a rule. It carries no time, model, or cost. */
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
