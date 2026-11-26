import { FolderInput } from "lucide-react";

import type { Message } from "@mcode/contracts/models/message";

type ThreadMove = NonNullable<Message["threadMove"]>;

/** Timeline marker for a No project thread that moved into a project. */
export function ThreadMoveMarker({ threadMove }: { readonly threadMove: ThreadMove }) {
  return (
    <div className="flex items-center gap-3 py-2" role="note" aria-label={`Moved to ${threadMove.projectName} · Local`}>
      <div className="h-px flex-1 bg-border" aria-hidden="true" />
      <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted">
        <FolderInput size={12} aria-hidden="true" />
        <span>
          Moved to <span className="font-medium text-ink">{threadMove.projectName}</span> · Local
        </span>
      </div>
      <div className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}
