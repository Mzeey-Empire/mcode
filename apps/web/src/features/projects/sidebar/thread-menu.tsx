import { useEffect, useState, type ReactElement } from "react";
import { GitMerge } from "lucide-react";
import { create } from "zustand";
import { effectiveAutoCompleteOnMerge } from "@mcode/contracts/models/thread";
import type { ContextMenuItem, SwitchMenuItem } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settingsStore";
import { rpcFailureMessage } from "@/transport/rpc-failure-message";
import { useWorkspaceStore } from "../state/workspaceStore";

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
}

const DIVIDER: ContextMenuItem = { label: "", onClick: () => {}, divider: true };

/**
 * The one list of thread menu rows. The right-click menu and the options dropdown both render
 * it, so the two cannot drift apart.
 */
export function threadMenuItems(target: ThreadMenuTarget, autoComplete: SwitchMenuItem | null, actions: ThreadMenuActions): ContextMenuItem[] {
  return [
    { label: "Rename", onClick: () => actions.onRename(target) },
    { label: "Copy Path", onClick: () => navigator.clipboard.writeText(target.worktreePath ?? target.workspacePath) },
    { label: "Copy Thread ID", onClick: () => navigator.clipboard.writeText(target.threadId) },
    DIVIDER,
    ...(autoComplete ? [autoComplete, DIVIDER] : []),
    { label: "Delete", destructive: true, onClick: () => actions.onDelete(target) },
  ];
}

/** The thread menu's "Close when PRs merge" switch, or null when the thread is gone. */
export function useAutoCompleteSwitch(threadId: string | null): SwitchMenuItem | null {
  const thread = useWorkspaceStore((s) => (threadId === null ? undefined : s.threads.find((candidate) => candidate.id === threadId)));
  const globalValue = useSettingsStore((s) => s.settings.thread.completion.completeOnPrMerge);
  const setOverride = useWorkspaceStore((s) => s.setAutoCompleteOverride);
  const [failure, setFailure] = useState<{ threadId: string; message: string } | null>(null);
  if (!thread) return null;
  return {
    kind: "switch",
    label: "Close when PRs merge",
    icon: <GitMerge />,
    checked: effectiveAutoCompleteOnMerge(thread, globalValue),
    disabledReason: thread.pull_requests.length === 0 ? "No linked PRs" : null,
    description: failure?.threadId === thread.id ? failure.message : undefined,
    onCheckedChange: (next) => {
      setFailure(null);
      setOverride(thread.id, next).catch((error: unknown) => {
        setFailure({ threadId: thread.id, message: rpcFailureMessage(error) });
      });
    },
  };
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

/** A thread's options menu, anchored to its trigger so it follows the row as the list scrolls. */
export function ThreadOptionsMenu({ target, actions, trigger }: { target: ThreadMenuTarget; actions: ThreadMenuActions; trigger: ReactElement }) {
  const [open, setOpen] = useState(false);
  useHoldThreadMenuOpen(open);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger render={trigger} />
      {open ? <ThreadOptionsMenuContent target={target} actions={actions} /> : null}
    </DropdownMenu>
  );
}

// Mounted only while open, so closed rows never subscribe to the thread for the switch.
function ThreadOptionsMenuContent({ target, actions }: { target: ThreadMenuTarget; actions: ThreadMenuActions }) {
  const autoComplete = useAutoCompleteSwitch(target.threadId);
  return (
    <DropdownMenuContent align="end" sideOffset={4} className="min-w-40">
      {threadMenuItems(target, autoComplete, actions).map((item, index) => {
        if (item.kind === "switch") return <SwitchItem key={index} item={item} />;
        if (item.divider) return <DropdownMenuSeparator key={index} />;
        return <DropdownMenuItem key={index} label={item.label} icon={item.icon} destructive={item.destructive} onClick={item.onClick} />;
      })}
    </DropdownMenuContent>
  );
}

// The checkbox item has no disabled reason or description, so this is a plain item that keeps
// the menu open and reports itself as a checkbox.
function SwitchItem({ item }: { item: SwitchMenuItem }) {
  const disabled = Boolean(item.disabledReason);
  return (
    <DropdownMenuItem
      label={item.label}
      icon={item.icon}
      description={item.description}
      disabledReason={item.disabledReason}
      role="menuitemcheckbox"
      aria-checked={item.checked}
      closeOnClick={false}
      onClick={() => item.onCheckedChange(!item.checked)}
      trailing={<Switch checked={item.checked} disabled={disabled} readOnly aria-hidden tabIndex={-1} className="pointer-events-none" />}
    />
  );
}
