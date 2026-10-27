import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ProjectIcon } from "@/features/projects/icons/ProjectIcon";
import { useWorkspaceStore } from "../state/workspaceStore";
import { selectThreadIndex } from "../state/thread-index";
import { useCompletionStore } from "./completion-store";
import { useSidebarUiStore } from "./sidebar-ui-store";

/** How long the Undo line stays once it shows. */
export const UNDO_LINE_MS = 6000;

interface CompletionUndoLineProps {
  /** Selects a thread the way a row click does. */
  readonly onOpen: (workspaceId: string, threadId: string) => void;
  /** Threads whose copies are still flying; the line waits for its thread to land. */
  readonly flying?: ReadonlySet<string>;
}

/**
 * The line under the scope bar after this client completes a thread: project tile, title and
 * Undo. The title opens Completed with the thread selected. It hides after {@link UNDO_LINE_MS}.
 */
export function CompletionUndoLine({ onOpen, flying }: CompletionUndoLineProps) {
  const threadId = useCompletionStore((state) => state.undoLineThreadId);
  const thread = useWorkspaceStore((state) => (threadId === null ? undefined : selectThreadIndex(state.threads).get(threadId)));
  const workspaceName = useWorkspaceStore((state) => state.workspaces.find((workspace) => workspace.id === thread?.workspace_id)?.name ?? "");
  const visible = thread !== undefined && thread.user_completed_at !== null && !(threadId !== null && flying?.has(threadId));

  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => useCompletionStore.getState().hideUndoLine(), UNDO_LINE_MS);
    return () => window.clearTimeout(timer);
  }, [visible, threadId]);

  if (!visible) return null;
  const open = () => {
    useCompletionStore.getState().hideUndoLine();
    useSidebarUiStore.getState().setScope("completed");
    onOpen(thread.workspace_id, thread.id);
  };
  return (
    <div data-testid="completion-undo-line" className="mx-1.5 flex h-7 shrink-0 items-center gap-2 pl-2.5 pr-1 text-caption text-muted">
      <ProjectIcon workspaceId={thread.workspace_id} name={workspaceName} size={14} className="shrink-0" />
      <button type="button" onClick={open} className="text-fade min-w-0 flex-1 text-left text-ink hover:underline hover:underline-offset-2">
        {thread.title}
      </button>
      <Button variant="ghost" size="compact" className="h-6 shrink-0 px-2" onClick={() => useCompletionStore.getState().undoFromLine()}>
        Undo
      </Button>
    </div>
  );
}
