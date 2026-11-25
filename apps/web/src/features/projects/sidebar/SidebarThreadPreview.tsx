import { createContext, useCallback, useDeferredValue, useEffect, useRef } from "react";
import { Archive, Laptop } from "lucide-react";
import { WorktreeModeIcon } from "@/components/icons/WorktreeModeIcon";
import { rankPullRequests, type ThreadPullRequest } from "@mcode/contracts/models/thread-pull-request";
import { ProviderIcon } from "@/components/ui/provider-icon";
import { openGitHubUrl } from "@/features/preview/navigation/open-url-in-preview";
import { resolveModelDisplayLabel } from "@/lib/format-model-label";
import { isPrable } from "@/lib/is-prable";
import { Tooltip, TooltipContent, type TooltipChangeDetails, type TooltipHandle } from "@/components/ui/tooltip";
import { ProjectIcon } from "@/features/projects/icons/ProjectIcon";
import { resolveThreadCheckoutLabel } from "@/lib/checkout-label";
import { cn } from "@/lib/utils";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import type { PreviewScrollGuard } from "./preview-scroll-guard";
import { isAnyThreadMenuOpen, useAnyThreadMenuOpen } from "./thread-menu";
import { PULL_REQUEST_LINE_CLASS, PullRequestLine, pullRequestNumberWidth } from "./PullRequestChip";

/** What a thread row hands the shared preview tooltip when it becomes the active trigger. */
export interface ThreadPreviewPayload {
  readonly thread: WorkspaceThread;
  readonly workspaceName: string;
  /** The thread lives in a hidden No project workspace, so the card shows no branch. */
  readonly noProject: boolean;
}

/** The DOM id of the open thread card, so the row it describes can point to it with `aria-describedby`. */
export const THREAD_PREVIEW_ID = "sidebar-thread-preview";

/** The list's preview handle. Null outside a list, where rows render without a preview. */
export const ThreadPreviewHandleContext = createContext<TooltipHandle<ThreadPreviewPayload> | null>(null);

/**
 * The one thread preview the sidebar list renders. Rows only mount a trigger bound to `handle`, so
 * mounting a row never mounts a tooltip root. It stays shut while any thread menu is open.
 */
export function ThreadPreviewTooltip({ handle, guard }: { handle: TooltipHandle<ThreadPreviewPayload>; guard: PreviewScrollGuard }) {
  const untrackRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => untrackRef.current?.(), []);
  // A preview drawn over an open thread menu hides the menu's rows, so a menu shuts the preview.
  const menuOpen = useAnyThreadMenuOpen();
  // A hover refused only because a menu was open. The PR list closes on a delay longer than the
  // card's, so the pointer can already rest on another row by then, and Base UI never retries it.
  const deferredRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (menuOpen) {
      handle.close();
      return;
    }
    const trigger = deferredRef.current;
    deferredRef.current = null;
    if (trigger?.isConnected && trigger.id && guard.allowsOpen("trigger-hover")) handle.open(trigger.id);
  }, [menuOpen, handle, guard]);
  const onOpenChange = useCallback((open: boolean, details: TooltipChangeDetails) => {
    if (open && refusesOpen(details, guard, deferredRef)) {
      details.cancel();
      return;
    }
    untrackRef.current?.();
    untrackRef.current = open && isHoverOpen(details.reason) ? guard.trackHoverOpen(() => handle.close()) : undefined;
  }, [guard, handle]);
  return (
    <Tooltip handle={handle} onOpenChange={onOpenChange}>
      {({ payload }) => payload ? <ThreadPreviewContent payload={payload} /> : null}
    </Tooltip>
  );
}

/** Whether an open must be refused. A hover refused only for an open menu is kept for when the menu closes. */
function refusesOpen(details: TooltipChangeDetails, guard: PreviewScrollGuard, deferredRef: { current: HTMLElement | null }): boolean {
  if (!guard.allowsOpen(details.reason)) return true;
  if (!isAnyThreadMenuOpen()) return false;
  if (details.reason === "trigger-hover") deferHoverOpen(deferredRef, details.trigger);
  return true;
}

// The only imperative open is the deferred hover, so a scroll closes it like any hover open.
function isHoverOpen(reason: string): boolean {
  return reason === "trigger-hover" || reason === "imperative-action";
}

/** Remembers `trigger` until the pointer leaves it, so only a row still under the pointer opens later. */
function deferHoverOpen(deferredRef: { current: HTMLElement | null }, trigger: Element | undefined): void {
  if (!(trigger instanceof HTMLElement)) return;
  deferredRef.current = trigger;
  trigger.addEventListener("mouseleave", () => {
    if (deferredRef.current === trigger) deferredRef.current = null;
  }, { once: true });
}

/**
 * With a preview open, Base UI switches the payload synchronously inside the next row's
 * mouseenter, before that row's hover highlight can paint. Deferring the body keeps that event
 * to moving the anchor, so the highlight paints first and the new body renders after. Until the
 * body catches up the popup is empty and invisible, so it never shows one row's details beside
 * another. A push for the same thread keeps the body visible, so an open preview of a running
 * thread doesn't blank on every update.
 */
function ThreadPreviewContent({ payload }: { payload: ThreadPreviewPayload }) {
  const shown = useDeferredValue<ThreadPreviewPayload | null>(payload, null);
  const body = shown?.thread.id === payload.thread.id ? shown : null;
  return (
    <TooltipContent
      interactive
      id={THREAD_PREVIEW_ID}
      side="right"
      align="start"
      sideOffset={8}
      className={cn("w-80 max-w-[calc(100vw-16px)] max-h-(--available-height) items-stretch p-3", !body && "invisible")}
    >
      {body ? <SidebarThreadPreview workspaceName={body.workspaceName} noProject={body.noProject} thread={body.thread} /> : null}
    </TooltipContent>
  );
}

function SidebarThreadPreview({ workspaceName, noProject, thread }: { workspaceName: string; noProject: boolean; thread: WorkspaceThread }) {
  const ranked = isPrable(thread) ? rankPullRequests(thread.pull_requests) : [];
  return (
    <div data-testid={`thread-preview-${thread.id}`} className="-mx-2 flex min-h-0 flex-col gap-2 overflow-x-hidden overflow-y-auto px-2 text-ink">
      <div className="min-w-0 shrink-0 text-label font-semibold [overflow-wrap:anywhere]">{thread.title}</div>
      <div className="grid shrink-0 gap-1.5 text-xs text-muted">
        <PreviewFact label={`Project, ${workspaceName}`} icon={<ProjectIcon workspaceId={thread.workspace_id} name={workspaceName} size={14} noProject={noProject} />}>
          {workspaceName}
        </PreviewFact>
        {noProject ? null : <ThreadPreviewBranch thread={thread} />}
        <ThreadPreviewModel thread={thread} />
        {thread.user_completed_at !== null ? <ClosedThreadLifecycle thread={thread} completedAt={thread.user_completed_at} /> : null}
      </div>
      {ranked.length > 0 ? <ThreadPreviewPullRequests threadId={thread.id} ranked={ranked} /> : null}
    </div>
  );
}

function PreviewFact({ label, icon, mono, children }: { label: string; icon: React.ReactNode; mono?: boolean; children: React.ReactNode }) {
  return (
    <div aria-label={label} className="flex min-w-0 items-center gap-2">
      <span className="flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
      <span className={cn("min-w-0 [overflow-wrap:anywhere]", mono && "font-mono")}>{children}</span>
    </div>
  );
}

function ThreadPreviewBranch({ thread }: { thread: WorkspaceThread }) {
  const checkoutLabel = resolveThreadCheckoutLabel(thread);
  return (
    // The same checkout glyph the row leads its branch line with, so card and row read alike.
    <PreviewFact label={`Branch, ${checkoutLabel}`} mono icon={thread.mode === "worktree" ? <WorktreeModeIcon size={12} aria-hidden /> : <Laptop size={12} aria-hidden />}>
      {checkoutLabel}
    </PreviewFact>
  );
}

function ThreadPreviewModel({ thread }: { thread: WorkspaceThread }) {
  if (!thread.model) return null;
  const label = resolveModelDisplayLabel(thread.model);
  return (
    <PreviewFact label={`Model, ${label}`} icon={<ProviderIcon provider={thread.provider} size={14} />}>
      {label}
    </PreviewFact>
  );
}

function ClosedThreadLifecycle({ thread, completedAt }: { thread: WorkspaceThread; completedAt: string }) {
  const closed = `Closed ${formatLifecycleDate(completedAt)}`;
  const cleanup = closedThreadCleanupText(thread);
  return (
    <PreviewFact label={`${closed} · ${cleanup}`} icon={<Archive size={14} aria-hidden />}>
      {closed} · <span className={cn(thread.cleanup_state === "blocked" && "text-destructive")}>{cleanup}</span>
    </PreviewFact>
  );
}

function closedThreadCleanupText(thread: WorkspaceThread): string {
  if (thread.cleanup_state === "blocked") return `cleanup blocked: ${thread.cleanup_reason ?? "user action is required."}`;
  if (thread.cleanup_state === "queued") return "cleanup queued";
  if (thread.cleanup_state === "retrying") return "retrying cleanup";
  return thread.scheduled_deletion_at ? `deletes ${formatLifecycleDate(thread.scheduled_deletion_at)}` : "automatic deletion disabled";
}

function ThreadPreviewPullRequests({ threadId, ranked }: { threadId: string; ranked: readonly ThreadPullRequest[] }) {
  const numberWidth = pullRequestNumberWidth(ranked);
  return (
    <div className="-mx-2 flex min-h-0 shrink flex-col border-t border-border pt-2">
      <div className="scroll-fade-y">
      {ranked.map((pr) => pr.url
        ? (
          <a key={pr.number} href={pr.url} onClick={(event) => openPreviewPullRequest(pr, threadId, event)} className={PULL_REQUEST_LINE_CLASS}>
            <PullRequestLine pr={pr} numberWidth={numberWidth} />
          </a>
        )
        : <div key={pr.number} className={PULL_REQUEST_LINE_CLASS}><PullRequestLine pr={pr} numberWidth={numberWidth} /></div>)}
      </div>
    </div>
  );
}

function openPreviewPullRequest(pr: ThreadPullRequest, threadId: string, event: React.MouseEvent): void {
  event.preventDefault();
  if (pr.url) openGitHubUrl(pr.url, threadId, event);
}

function formatLifecycleDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}
