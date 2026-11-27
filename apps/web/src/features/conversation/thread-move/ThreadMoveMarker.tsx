import { FolderInput } from "lucide-react";

import type { Message } from "@mcode/contracts/models/message";

type ThreadMove = NonNullable<Message["threadMove"]>;

function targetLabel(threadMove: ThreadMove): string {
  switch (threadMove.target) {
    case "local":
      return "Local";
    case "existing-worktree":
      return `Existing worktree on ${threadMove.branch}`;
    case "new-worktree":
      if (threadMove.source.kind === "pr") return `New worktree from #${threadMove.source.pullRequestNumber}`;
      return `New worktree from ${threadMove.source.startFromOrigin ? "origin/" : ""}${threadMove.source.branch}`;
    case "new-project":
      return "New project";
    default:
      throw new Error(`Unhandled thread move target: ${threadMove satisfies never}`);
  }
}

/** Timeline marker for a No project thread that moved into a project. */
export function ThreadMoveMarker({ threadMove }: { readonly threadMove: ThreadMove }) {
  const label = targetLabel(threadMove);
  return (
    <div className="flex items-center gap-3 py-2" role="note" aria-label={`Moved to ${threadMove.projectName} · ${label}`}>
      <div className="h-px flex-1 bg-border" aria-hidden="true" />
      <div className="flex min-w-0 items-center gap-1 whitespace-nowrap text-xs text-muted">
        <FolderInput size={12} className="shrink-0" aria-hidden="true" />
        <span className="shrink-0">Moved to</span>{" "}
        {/* A project name or a branch can outgrow a narrow timeline, so both give way and "Moved to" stays. */}
        <span className="min-w-0 overflow-hidden font-medium text-ink text-fade">{threadMove.projectName}</span>{" "}
        <span className="min-w-0 overflow-hidden text-fade">· {label}</span>
      </div>
      <div className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}
