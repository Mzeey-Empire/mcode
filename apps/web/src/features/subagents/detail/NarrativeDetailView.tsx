import { ArrowLeft, CheckCircle2, CircleDashed, XCircle } from "lucide-react";
import { formatSubagentDisplayName } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SubagentIdentityGlyph } from "@/components/ui/SubagentIdentityGlyph";
import { resolveModelDisplayLabel } from "@/lib/format-model-label";
import { formatSubagentIdentity } from "../identity/format-subagent-identity";
import { narrativeRowStatus } from "../roster/narrative-subagents";
import type { ProjectedSubagentRow, SubagentDetailActivity } from "../roster/subagent-projection";

function narrativeConfiguration(row: ProjectedSubagentRow): string {
  return [
    row.detail.model ? resolveModelDisplayLabel(row.detail.model) : undefined,
    row.detail.reasoningEffort,
  ].filter((value): value is string => value !== undefined && value.length > 0).join(" · ");
}

function ActivityStatusIcon({ activity }: { readonly activity: SubagentDetailActivity }) {
  if (activity.isError) {
    return <XCircle size={13} aria-hidden className="shrink-0 text-destructive" />;
  }
  if (!activity.isComplete) {
    return <CircleDashed size={13} aria-hidden className="shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />;
  }
  return <CheckCircle2 size={13} aria-hidden className="shrink-0 text-muted-foreground" />;
}

function NarrativeActivityRow({ activity }: { readonly activity: SubagentDetailActivity }) {
  return (
    <li
      data-testid="narrative-subagent-activity"
      className="flex min-w-0 items-baseline gap-2 px-4 py-1"
      style={{ paddingLeft: `${16 + activity.depth * 14}px` }}
    >
      <ActivityStatusIcon activity={activity} />
      <span className="shrink-0 text-xs font-medium text-foreground/80">{activity.label}</span>
      {activity.detail && activity.detail !== activity.label && (
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{activity.detail}</span>
      )}
    </li>
  );
}

/**
 * Detail view for in-thread subagents that have no canonical child thread.
 * Renders the projected activity subtree instead of a child MessageList.
 */
export function NarrativeDetailView({
  row,
  paletteSeed,
  onBack,
}: {
  readonly row: ProjectedSubagentRow;
  readonly paletteSeed: string;
  readonly onBack: () => void;
}) {
  const identity = formatSubagentIdentity(row.identity);
  const title = row.task ? formatSubagentDisplayName(row.task) : identity;
  const configuration = narrativeConfiguration(row);
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={`${identity} subagent details`}>
      <header className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-3">
        <Button type="button" variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to subagents" className="shrink-0">
          <ArrowLeft size={15} aria-hidden />
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <SubagentIdentityGlyph
            identity={identity}
            hasExplicitIdentity={row.hasExplicitIdentity}
            paletteSeed={paletteSeed}
            className="size-6"
            size={15}
          />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{title}</h2>
            {row.task && <p className="truncate text-xs text-muted-foreground">{identity}</p>}
          </div>
          <span role="status" className="sr-only">
            {narrativeRowStatus(row)}
          </span>
          {configuration && <span className="shrink-0 font-mono text-xs text-muted-foreground">{configuration}</span>}
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        {row.detail.output && (
          <p className="whitespace-pre-wrap px-4 py-3 text-xs text-foreground/85">{row.detail.output}</p>
        )}
        {row.detail.activity.length > 0 && (
          <ul className="py-2" aria-label="Subagent activity">
            {row.detail.activity.map((activity) => (
              <NarrativeActivityRow key={activity.id} activity={activity} />
            ))}
          </ul>
        )}
        {row.detail.activityTruncated && (
          <p className="px-4 pb-3 text-xs text-muted-foreground">Earlier activity is truncated.</p>
        )}
      </ScrollArea>
    </section>
  );
}
