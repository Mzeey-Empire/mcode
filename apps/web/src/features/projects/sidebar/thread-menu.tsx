import { useEffect, useMemo, useState, type ComponentProps, type ReactElement } from "react";
import { create } from "zustand";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ActionMenuItem } from "@/components/ui/context-menu";
import { isDetachedCheckout } from "@/lib/checkout-label";
import { useThreadRowState } from "@/features/thread-attention/thread-row-presentation";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import { useSettingsStore } from "@/stores/settingsStore";
import { isThreadExecuting, useThreadStore } from "@/stores/threadStore";
import { rpcFailureMessage } from "@/transport/rpc-failure-message";
import type { Thread } from "@/transport/types";
import { useWorkspaceStore } from "../state/workspaceStore";
import { closeBlockedReason, lifecycleActionBlocked, useCompletionStore } from "./completion-store";
import { useRowLifecycleStore } from "./row-lifecycle-store";

/** The thread a menu acts on, read when the menu renders. */
export interface ThreadMenuTarget {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly workspacePath: string;
  readonly worktreePath: string | null;
}

/** What the thread menu's actions call back into. */
export interface ThreadMenuActions {
  onRename(target: ThreadMenuTarget): void;
  onDelete(target: ThreadMenuTarget): void;
  onOpenProjectSettings(target: ThreadMenuTarget, workspaceId: string): void;
  /** The thread whose title is being edited in place; Close thread is refused for it. */
  readonly renamingThreadId: string | null;
}

/** Where the right-click menu opens, and the row it was opened on. */
export interface ThreadMenuPoint {
  readonly x: number;
  readonly y: number;
  readonly anchor: Element;
}

const useThreadMenuStore = create<{ readonly openMenus: number }>(() => ({ openMenus: 0 }));

/**
 * Counts this menu as open while `open` holds. A count rather than a flag, so one menu closing
 * after another opened never reports both closed.
 */
export function useHoldThreadMenuOpen(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    useThreadMenuStore.setState((s) => ({ openMenus: s.openMenus + 1 }));
    return () => useThreadMenuStore.setState((s) => ({ openMenus: s.openMenus - 1 }));
  }, [open]);
}

/** Whether any thread menu, right-click or options, is open. */
export function useAnyThreadMenuOpen(): boolean {
  return useThreadMenuStore((s) => s.openMenus > 0);
}

/** Non-reactive read of {@link useAnyThreadMenuOpen} for event handlers. */
export function isAnyThreadMenuOpen(): boolean {
  return useThreadMenuStore.getState().openMenus > 0;
}

/** Props for {@link ThreadOptionsMenu}. */
export interface ThreadOptionsMenuProps {
  target: ThreadMenuTarget;
  actions: ThreadMenuActions;
  trigger: ReactElement;
  /** Rows a surface adds before the shared thread rows, such as the chat header's Fork thread. */
  leadingItems?: readonly ActionMenuItem[];
  align?: "start" | "end";
}

/** A thread's options menu, anchored to its trigger so it follows the row as the list scrolls. */
export function ThreadOptionsMenu({ target, actions, trigger, leadingItems = NO_ITEMS, align = "end" }: ThreadOptionsMenuProps) {
  const [open, setOpen] = useState(false);
  useHoldThreadMenuOpen(open);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger render={trigger} />
      {open ? <ThreadMenuContent target={target} actions={actions} leadingItems={leadingItems} align={align} /> : null}
    </DropdownMenu>
  );
}

/** The right-click thread menu. It renders the same rows as {@link ThreadOptionsMenu}, at the pointer. */
export function ThreadContextMenu({ target, point, actions, onClose }: { target: ThreadMenuTarget; point: ThreadMenuPoint; actions: ThreadMenuActions; onClose: () => void }) {
  useHoldThreadMenuOpen(true);
  useCloseOnAnchorScroll(point.anchor, onClose);
  const anchor = useMemo(() => pointAnchor(point), [point]);
  return (
    <DropdownMenu
      open
      onOpenChange={(open, details) => {
        // Base UI reports a triggerless root as a sibling of its own submenu and asks it to close
        // when the submenu opens. A root menu has no siblings, so that request is ignored.
        if (!open && details.reason !== "sibling-open") onClose();
      }}
    >
      <ThreadMenuContent target={target} actions={actions} anchor={anchor} />
    </DropdownMenu>
  );
}

function pointAnchor({ x, y }: ThreadMenuPoint) {
  return { getBoundingClientRect: () => new DOMRect(x, y, 0, 0) };
}

/**
 * A menu opened at a pointer cannot follow its row, so scrolling the list that holds the row
 * closes it. Scroll does not bubble, so a capture listener is the only way to hear every
 * scroller; other scrollers, such as a streaming transcript, must not close the menu.
 */
function useCloseOnAnchorScroll(anchor: Element, onClose: () => void): void {
  useEffect(() => {
    const handleScroll = (event: Event) => {
      if (event.target instanceof Node && event.target.contains(anchor)) onClose();
    };
    document.addEventListener("scroll", handleScroll, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", handleScroll, { capture: true });
  }, [anchor, onClose]);
}

type ContentPlacement = Pick<ComponentProps<typeof DropdownMenuContent>, "align" | "anchor">;

const NO_ITEMS: readonly ActionMenuItem[] = [];

function ThreadMenuContent({ target, actions, leadingItems = NO_ITEMS, ...placement }: { target: ThreadMenuTarget; actions: ThreadMenuActions; leadingItems?: readonly ActionMenuItem[] } & ContentPlacement) {
  const thread = useWorkspaceStore((s) => s.threads.find((candidate) => candidate.id === target.threadId));
  if (!thread) return null;
  return (
    <DropdownMenuContent sideOffset={4} className="min-w-40" {...placement}>
      {leadingItems.map((item, index) =>
        item.divider ? <DropdownMenuSeparator key={index} /> : <DropdownMenuItem key={index} label={item.label} icon={item.icon} destructive={item.destructive} disabledReason={item.disabledReason} onClick={item.onClick} />,
      )}
      <CloseThreadItem thread={thread} renaming={actions.renamingThreadId === thread.id} />
      <DropdownMenuSeparator />
      <DropdownMenuItem label="Rename thread" onClick={() => actions.onRename(target)} />
      <AutoCloseSubmenu thread={thread} />
      <DropdownMenuSeparator />
      <CopySubmenu target={target} thread={thread} />
      <DropdownMenuItem label="Project settings" onClick={() => actions.onOpenProjectSettings(target, thread.workspace_id)} />
      <DropdownMenuSeparator />
      <DropdownMenuItem label="Delete" destructive onClick={() => actions.onDelete(target)} />
    </DropdownMenuContent>
  );
}

function CloseThreadItem({ thread, renaming }: { thread: WorkspaceThread; renaming: boolean }) {
  const running = useThreadStore((s) => isThreadExecuting(thread.id, s));
  const startupPending = useWorkspaceStore((s) => s.pendingStartupByThreadId[thread.id] !== undefined);
  const lifecyclePending = useRowLifecycleStore((s) => s.pendingLifecycle.has(thread.id));
  const closing = useCompletionStore((s) => s.entries.has(thread.id));
  const rowState = useThreadRowState(thread.id, thread.clientPreparing === true, thread.clientError != null);
  const awaitingApproval = rowState.kind === "needs-you" && rowState.label === "Approval required";
  return (
    <DropdownMenuItem
      label="Close thread"
      disabledReason={closeBlockedReason(thread, { running, awaitingApproval, startupPending, lifecyclePending, renaming, closing })}
      onClick={() => closeThread(thread.id)}
    />
  );
}

function closeThread(threadId: string): void {
  if (isThreadExecuting(threadId) || lifecycleActionBlocked(threadId)) return;
  useCompletionStore.getState().complete(threadId);
}

const AUTO_CLOSE_CHOICES = [
  { label: "Close when PRs merge", value: true },
  { label: "Keep open", value: false },
] as const;

function AutoCloseSubmenu({ thread }: { thread: Thread }) {
  const globalValue = useSettingsStore((s) => s.settings.thread.completion.completeOnPrMerge);
  const setOverride = useWorkspaceStore((s) => s.setAutoCompleteOverride);
  const [failure, setFailure] = useState<string | null>(null);
  const current = thread.auto_complete_on_merge;
  const choose = (value: boolean | null) => {
    setFailure(null);
    setOverride(thread.id, value).catch((error: unknown) => setFailure(rpcFailureMessage(error)));
  };
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger label="Auto-close behavior" />
      <DropdownMenuSubContent className="min-w-40">
        <DropdownMenuItem
          label="Use setting"
          trailing={<span className="text-muted">{globalValue ? "On" : "Off"}</span>}
          checked={current === null}
          closeOnClick={false}
          onClick={() => choose(null)}
        />
        <DropdownMenuSeparator />
        {AUTO_CLOSE_CHOICES.map((choice) => (
          <DropdownMenuItem key={choice.label} label={choice.label} checked={current === choice.value} closeOnClick={false} onClick={() => choose(choice.value)} />
        ))}
        {failure ? <p role="alert" className="max-w-56 px-3 py-1 text-caption text-error">{failure}</p> : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function CopySubmenu({ target, thread }: { target: ThreadMenuTarget; thread: Thread }) {
  const branch = isDetachedCheckout(thread) ? null : thread.branch;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger label="Copy" />
      <DropdownMenuSubContent className="min-w-32">
        <DropdownMenuItem label="Path" onClick={() => void navigator.clipboard.writeText(target.worktreePath ?? target.workspacePath)} />
        <DropdownMenuItem
          label="Branch"
          disabledReason={branch === null ? "No branch" : null}
          onClick={() => { if (branch !== null) void navigator.clipboard.writeText(branch); }}
        />
        <DropdownMenuItem label="Thread ID" onClick={() => void navigator.clipboard.writeText(target.threadId)} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
