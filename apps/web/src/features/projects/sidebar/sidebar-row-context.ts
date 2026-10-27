import type { ChecksStatus } from "@mcode/contracts/github";
import type { Thread, Workspace } from "@/transport/types";

/** An inline thread rename in progress. */
export interface InlineEditState {
  readonly threadId: string;
  readonly title: string;
  readonly originalTitle: string;
}

/** The provider facts a row reads to flag a thread it can no longer run. */
export interface SidebarProviderAvailability {
  readonly id: string;
  readonly enabled: boolean;
  readonly cli: { readonly status: string };
}

/**
 * Shared render inputs and handlers for every sidebar row. The shell keeps each handler stable
 * across thread pushes, so a status change re-renders only the row it names.
 */
export interface SidebarRowContext {
  readonly checksById: Readonly<Record<string, ChecksStatus>>;
  readonly inlineEdit: InlineEditState | null;
  readonly worktreesLoadedFor: string | null;
  readonly validWorktreePaths: ReadonlySet<string>;
  readonly availableProviders: readonly SidebarProviderAvailability[];
  onToggleProject(workspaceId: string, section: "recent" | "older"): void;
  onToggleShowMore(workspaceId: string): void;
  onCreateThread(workspaceId: string): void;
  onDeleteProject(workspaceId: string): void;
  onRenameProject(workspace: Workspace): void;
  onInlineEditChange(title: string): void;
  onInlineEditCommit(): void;
  onInlineEditCancel(): void;
  onThreadClick(workspaceId: string, threadId: string): void;
  onThreadDoubleClick(threadId: string): void;
  onSelectThread(workspaceId: string, threadId: string): void;
  onThreadContextMenu(event: React.MouseEvent, thread: Thread, workspacePath: string): void;
  onCompleteThread(threadId: string): Promise<void>;
  onReopenThread(threadId: string): Promise<void>;
  onRetryThreadCleanup(threadId: string): Promise<void>;
  onOpenDraft(workspaceId: string, draftId: string): void;
  onDiscardDraft(draftId: string): void;
  onDraftContextMenu(event: React.MouseEvent, draftId: string): void;
}
