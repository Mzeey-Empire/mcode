import { createContext, useContext, useState } from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { ThreadPullRequest } from "@mcode/contracts/models/thread-pull-request";
import { MENU_LIST_CLASS } from "@/components/ui/menu-row";
import { POPOVER_FADE_CLASS, POPOVER_SURFACE_CLASS } from "@/components/ui/overlay-surface";
import { openGitHubUrl } from "@/features/preview/navigation/open-url-in-preview";
import { getPullRequestStateVisual } from "@/lib/pr-status";
import { cn } from "@/lib/utils";
import { useHoldThreadMenuOpen } from "./thread-menu";

/** What a chip hands the shared PR list when it becomes the active trigger. */
export interface PullRequestListPayload {
  readonly threadId: string;
  /** The thread's PRs, highest-ranked first. */
  readonly ranked: readonly ThreadPullRequest[];
}

/** The handle that binds every row's chip to the list's one shared PR menu. */
export type PullRequestListHandle = MenuPrimitive.Handle<PullRequestListPayload>;

/** Creates a {@link PullRequestListHandle}. Keep one per list for the life of its chips. */
export const createPullRequestListHandle = (): PullRequestListHandle => MenuPrimitive.createHandle<PullRequestListPayload>();

/** The list's PR menu handle. Null outside a list, where the chip shows without a menu. */
export const PullRequestListHandleContext = createContext<PullRequestListHandle | null>(null);

function stopRowEvent(event: React.SyntheticEvent): void {
  event.stopPropagation();
}

function StateIcon({ pr }: { pr: ThreadPullRequest }) {
  const { Icon, color } = getPullRequestStateVisual(pr.state);
  return <Icon size={12} aria-hidden className={cn("shrink-0", color)} />;
}

const CHIP_CLASS = "flex h-5 font-mono shrink-0 items-center gap-1 rounded-md px-1 text-caption tabular-nums text-muted outline-none transition-colors hover:bg-selected/60 hover:text-ink focus-visible:ring-2 focus-visible:ring-focus/70 data-popup-open:bg-selected/60 hover:underline underline-offset-2";

function openPullRequest(pr: ThreadPullRequest, threadId: string, event: React.MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
  if (pr.url) openGitHubUrl(pr.url, threadId, event);
}

function chipLabel(ranked: readonly ThreadPullRequest[], primary: ThreadPullRequest): string {
  return ranked.length > 1 ? `${ranked.length} pull requests` : `PR #${primary.number}, ${primary.state}`;
}

/**
 * The row's PR chip: the top-ranked PR's state icon, then its number, or `+N` with the total when
 * several are linked. Pointing at it or activating it opens the shared list of every PR.
 */
export function PullRequestChip({ threadId, ranked }: { threadId: string; ranked: readonly ThreadPullRequest[] }) {
  const handle = useContext(PullRequestListHandleContext);
  const [primary] = ranked;
  if (!primary) return null;
  const props = {
    "aria-label": chipLabel(ranked, primary),
    "data-testid": `thread-pr-indicator-${threadId}`,
    onPointerDown: stopRowEvent,
    onKeyDown: stopRowEvent,
    onClick: stopRowEvent,
    onDoubleClick: stopRowEvent,
    className: CHIP_CLASS,
  };
  const label = <><StateIcon pr={primary} />{ranked.length > 1 ? `+${ranked.length}` : primary.number}</>;
  if (!handle) return <span role="img" {...props}>{label}</span>;
  return (
    <MenuPrimitive.Trigger handle={handle} payload={{ threadId, ranked }} openOnHover delay={150} {...props}>
      {label}
    </MenuPrimitive.Trigger>
  );
}

/** The width of the widest `#number` in a list, so every title in it starts on one x. */
export function pullRequestNumberWidth(ranked: readonly ThreadPullRequest[]): string {
  const digits = Math.max(0, ...ranked.map((pr) => String(pr.number).length));
  return `${digits + 1}ch`;
}

/** One PR line: state icon, `#number` in ink, then the title fading at the edge. Shared with the hover card. */
export function PullRequestLine({ pr, numberWidth }: { pr: ThreadPullRequest; numberWidth: string }) {
  return (
    <>
      <StateIcon pr={pr} />
      <span style={{ minWidth: numberWidth }} className="shrink-0 font-mono tabular-nums text-ink">#{pr.number}</span>
      <span className="text-fade min-w-0 flex-1 text-muted">{pr.title ?? ""}</span>
    </>
  );
}

/** The classes of one 24px PR line, in the chip's list and in the hover card alike. */
export const PULL_REQUEST_LINE_CLASS = "flex h-6 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-caption outline-none data-highlighted:bg-selected hover:bg-selected focus-visible:bg-selected";

function PullRequestMenuItem({ pr, threadId, numberWidth }: { pr: ThreadPullRequest; threadId: string; numberWidth: string }) {
  if (!pr.url) {
    return <MenuPrimitive.Item disabled className={cn(PULL_REQUEST_LINE_CLASS, "data-disabled:cursor-default")}><PullRequestLine pr={pr} numberWidth={numberWidth} /></MenuPrimitive.Item>;
  }
  return (
    <MenuPrimitive.LinkItem href={pr.url} closeOnClick onClick={(event) => openPullRequest(pr, threadId, event)} className={PULL_REQUEST_LINE_CLASS}>
      <PullRequestLine pr={pr} numberWidth={numberWidth} />
    </MenuPrimitive.LinkItem>
  );
}

/**
 * The one PR list the sidebar renders. Chips only mount a trigger bound to `handle`, so a row
 * never mounts a menu root. Base UI's hover menu keeps a safe triangle between chip and list,
 * and while the list is open the thread card stays shut so crossing the row does not swap them.
 */
export function PullRequestListMenu({ handle }: { handle: PullRequestListHandle }) {
  const [open, setOpen] = useState(false);
  useHoldThreadMenuOpen(open);
  return (
    <MenuPrimitive.Root handle={handle} modal={false} onOpenChange={setOpen}>
      {({ payload }) => <PullRequestListPopup payload={payload} />}
    </MenuPrimitive.Root>
  );
}

function PullRequestListPopup({ payload }: { payload: PullRequestListPayload | undefined }) {
  if (!payload) return null;
  const numberWidth = pullRequestNumberWidth(payload.ranked);
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner side="right" align="start" sideOffset={8} className="pointer-events-none isolate z-(--layer-modal) data-anchor-hidden:invisible">
        <MenuPrimitive.Popup
          className={cn("pointer-events-auto w-72 max-h-(--available-height) overflow-y-auto", MENU_LIST_CLASS, POPOVER_SURFACE_CLASS, POPOVER_FADE_CLASS)}
        >
          {payload.ranked.map((pr) => <PullRequestMenuItem key={pr.number} pr={pr} threadId={payload.threadId} numberWidth={numberWidth} />)}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}
