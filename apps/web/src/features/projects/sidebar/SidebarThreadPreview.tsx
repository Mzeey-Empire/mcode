import { createContext, useCallback, useEffect, useRef } from "react";
import { GitBranch } from "lucide-react";
import { Tooltip, TooltipContent, type TooltipChangeDetails, type TooltipHandle } from "@/components/ui/tooltip";
import { ProjectIcon } from "@/features/projects/icons/ProjectIcon";
import { resolveThreadCheckoutLabel } from "@/lib/checkout-label";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import type { PreviewScrollGuard } from "./preview-scroll-guard";

/** What a thread row hands the shared preview tooltip when it becomes the active trigger. */
export interface ThreadPreviewPayload {
  readonly thread: WorkspaceThread;
  readonly workspaceName: string;
}

/** The list's preview handle. Null outside a list, where rows render without a preview. */
export const ThreadPreviewHandleContext = createContext<TooltipHandle<ThreadPreviewPayload> | null>(null);

/**
 * The one thread preview the sidebar list renders. Rows only mount a trigger bound to `handle`, so
 * mounting a row never mounts a tooltip root.
 */
export function ThreadPreviewTooltip({ handle, guard }: { handle: TooltipHandle<ThreadPreviewPayload>; guard: PreviewScrollGuard }) {
  const untrackRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => untrackRef.current?.(), []);
  const onOpenChange = useCallback((open: boolean, details: TooltipChangeDetails) => {
    if (open && !guard.allowsOpen(details.reason)) {
      details.cancel();
      return;
    }
    untrackRef.current?.();
    untrackRef.current = open && details.reason === "trigger-hover" ? guard.trackHoverOpen(() => handle.close()) : undefined;
  }, [guard, handle]);
  return (
    <Tooltip handle={handle} onOpenChange={onOpenChange}>
      {({ payload }) => payload ? (
        <TooltipContent side="right" align="start" sideOffset={8} className="max-w-none p-3">
          <SidebarThreadPreview workspaceName={payload.workspaceName} thread={payload.thread} />
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
}

function SidebarThreadPreview({
  workspaceName,
  thread,
}: {
  workspaceName: string;
  thread: WorkspaceThread;
}) {
  const checkoutLabel = resolveThreadCheckoutLabel(thread);

  return (
    <div
      data-testid={`thread-preview-${thread.id}`}
      className="w-64 space-y-2 text-ink"
    >
      <div className="min-w-0 font-medium text-xs leading-5">
        {thread.title}
      </div>
      <div className="grid gap-1.5">
        <div className="text-xs text-muted">
          Updated {formatLifecycleDate(thread.updated_at)}
        </div>
        {thread.user_completed_at !== null ? (
          <>
            <div className="text-xs text-muted">
              Completed {formatLifecycleDate(thread.user_completed_at)}
            </div>
            {thread.cleanup_state === "blocked" ? (
              <div className="text-xs text-destructive" role="status">
                Cleanup blocked: {thread.cleanup_reason ?? "User action is required."}
              </div>
            ) : thread.cleanup_state === "queued" ? (
              <div className="text-xs text-muted" role="status">
                Cleanup queued
              </div>
            ) : thread.cleanup_state === "retrying" ? (
              <div className="text-xs text-muted" role="status">
                Retrying cleanup
              </div>
            ) : (
              <div className="text-xs text-muted">
                {thread.scheduled_deletion_at
                  ? `Deletes ${formatLifecycleDate(thread.scheduled_deletion_at)}`
                  : "Automatic deletion disabled"}
              </div>
            )}
          </>
        ) : null}
        <div
          aria-label={`Project, ${workspaceName}`}
          className="flex min-w-0 items-center gap-2"
        >
          <ProjectIcon workspaceId={thread.workspace_id} name={workspaceName} size={14} />
          <span className="text-fade text-xs">{workspaceName}</span>
        </div>
        <div
          aria-label={`Branch, ${checkoutLabel}`}
          className="flex min-w-0 items-center gap-2"
        >
          <GitBranch size={13} aria-hidden className="shrink-0 opacity-75" />
          <span className="text-fade font-mono text-xs">{checkoutLabel}</span>
        </div>
      </div>
    </div>
  );
}

function formatLifecycleDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}
