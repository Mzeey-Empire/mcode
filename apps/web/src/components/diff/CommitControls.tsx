import { GitCommitHorizontal } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { useReviewState } from "@/hooks/useReviewState";
import { useDiffStore } from "@/stores/diffStore";
import { CommitSheet } from "./CommitSheet";

export interface CommitControlsProps {
  readonly workspaceId: string;
  readonly threadId: string | null;
  /** Review's scope id (thread, else workspace). */
  readonly scopeId: string;
  readonly activePath: string | null;
}

/**
 * The floating Commit button and the sheet it opens, anchored to the diff's bottom-right.
 * The button shows while the checkout has uncommitted changes, in any view, and stays
 * while the sheet is open so a finished commit cannot pull the sheet's outcome away.
 */
export function CommitControls({ workspaceId, threadId, scopeId, activePath }: CommitControlsProps) {
  const { isDirty } = useReviewState(workspaceId, threadId);
  const open = useDiffStore((store) => store.commitSheetScopeId === scopeId);
  const setCommitSheetScopeId = useDiffStore((store) => store.setCommitSheetScopeId);
  if (!isDirty && !open) return null;
  return (
    <div className="pointer-events-none absolute right-4 bottom-4 z-(--layer-sticky) flex max-w-[calc(100%-2rem)] flex-col items-end gap-3">
      {open ? (
        <CommitSheet
          workspaceId={workspaceId}
          threadId={threadId}
          scopeId={scopeId}
          activePath={activePath}
          onClose={() => setCommitSheetScopeId(null)}
          className="pointer-events-auto"
        />
      ) : null}
      <IconButton
        shape="round"
        floating
        aria-label="Commit"
        pressed={open}
        onClick={() => setCommitSheetScopeId(open ? null : scopeId)}
        className="pointer-events-auto"
      >
        <GitCommitHorizontal />
      </IconButton>
    </div>
  );
}
