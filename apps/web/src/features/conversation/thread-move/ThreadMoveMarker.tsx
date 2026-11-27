import type { ReactNode } from "react";
import { FolderInput } from "lucide-react";

import type { Message } from "@mcode/contracts/models/message";

type ThreadMove = NonNullable<Message["threadMove"]>;

type MovedIntoProject = Exclude<ThreadMove, { readonly target: "new-project" }>;

function targetLabel(threadMove: MovedIntoProject): string {
  switch (threadMove.target) {
    case "local":
      return "Local";
    case "existing-worktree":
      return `Existing worktree on ${threadMove.branch}`;
    case "new-worktree":
      if (threadMove.source.kind === "pr") return `New worktree from #${threadMove.source.pullRequestNumber}`;
      return `New worktree from ${threadMove.source.startFromOrigin ? "origin/" : ""}${threadMove.source.branch}`;
    default:
      throw new Error(`Unhandled thread move target: ${threadMove satisfies never}`);
  }
}

/** One centred marker line: a rule, the move icon with its words, a rule. */
function MarkerLine({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-2" role="note" aria-label={label}>
      <div className="h-px flex-1 bg-border" aria-hidden="true" />
      <div className="flex min-w-0 items-center gap-1 whitespace-nowrap text-xs text-muted">
        <FolderInput size={12} className="shrink-0" aria-hidden="true" />
        {children}
      </div>
      <div className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}

function MovedMarker({ threadMove }: { readonly threadMove: MovedIntoProject }) {
  const label = targetLabel(threadMove);
  return (
    <MarkerLine label={`Moved to ${threadMove.projectName} · ${label}`}>
      <span className="shrink-0">Moved to</span>{" "}
      {/* A project name or a branch can outgrow a narrow timeline, so both give way and "Moved to" stays. */}
      <span className="min-w-0 overflow-hidden font-medium text-ink text-fade">{threadMove.projectName}</span>{" "}
      <span className="min-w-0 overflow-hidden text-fade">· {label}</span>
    </MarkerLine>
  );
}

/**
 * Timeline marker for a No project thread that moved into a project, or whose folder became one. A new project
 * says only that it was created: the thread did not go anywhere, so there is no place to name after the project.
 */
export function ThreadMoveMarker({ threadMove }: { readonly threadMove: ThreadMove }) {
  if (threadMove.target !== "new-project") return <MovedMarker threadMove={threadMove} />;
  return (
    <MarkerLine label={`Created project ${threadMove.projectName}`}>
      <span className="shrink-0">Created project</span>{" "}
      <span className="min-w-0 overflow-hidden font-medium text-ink text-fade">{threadMove.projectName}</span>
    </MarkerLine>
  );
}
