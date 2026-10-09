import { useCallback, useEffect, useState } from "react";
import type { ThreadStartup } from "@mcode/contracts";
import { useTerminalStore } from "@/features/terminal";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { useDiffStore } from "@/stores/diffStore";
import { useToastStore } from "@/stores/toastStore";
import { getTransport } from "@/transport";
import { useThreadStartupStore } from "./state/thread-startup-store";

const TERMINAL_STATES: ReadonlySet<ThreadStartup["state"]> = new Set(["completed", "failed", "cancelled", "interrupted"]);
const SCRIPT_RETRY_MS = 1_000;

/**
 * Reads the setup script for the 04b header and the setup row argument.
 *
 * The startup record carries no script text, so this reads the automatic setup gate
 * once per setup step state change. The step turns running before the setup attempt
 * records its script, so a running step re-reads every second until the script arrives.
 */
export function useStartupSetupScript(startup: ThreadStartup | undefined): string | undefined {
  const threadId = startup?.threadId;
  const setupState = startup?.steps.find((step) => step.phase === "setup")?.state;
  const [loaded, setLoaded] = useState<{ readonly threadId: string; readonly script: string | null } | null>(null);
  useEffect(() => {
    if (!threadId || !setupState || setupState === "pending") return;
    let current = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const read = () => getTransport().getAutomaticSetup(threadId).then(
      (snapshot) => {
        if (!current) return;
        const script = snapshot.attempt?.snapshot?.script ?? null;
        setLoaded({ threadId, script });
        if (script === null && setupState === "running") retry = setTimeout(read, SCRIPT_RETRY_MS);
      },
      // The script only labels the row and header; without it the trail still shows every state.
      () => undefined,
    );
    void read();
    return () => {
      current = false;
      clearTimeout(retry);
    };
  }, [threadId, setupState]);
  return loaded && loaded.threadId === threadId ? loaded.script ?? undefined : undefined;
}

/**
 * Cancels a live startup until composer Stop and Esc take over cancellation.
 *
 * Returns no callback once the startup has ended or cancellation is already requested.
 */
export function useStartupCancel(startup: ThreadStartup | undefined, startupId: string | undefined): (() => void) | undefined {
  const [requested, setRequested] = useState<string | null>(null);
  const id = startup?.startupId ?? startupId;
  const cancel = useCallback(() => {
    if (!id) return;
    setRequested(id);
    getTransport().cancelThreadStartup(id).then(
      (next) => useThreadStartupStore.getState().apply(next),
      (error: unknown) => {
        setRequested(null);
        useToastStore.getState().show({
          kind: "failed",
          title: "Could not cancel startup",
          meta: error instanceof Error ? error.message : undefined,
        });
      },
    );
  }, [id]);
  if (!id || requested === id) return undefined;
  if (startup && (TERMINAL_STATES.has(startup.state) || startup.cancellation === "requested")) return undefined;
  return cancel;
}

/** Opens the automatic setup terminal for a thread in its right panel. */
export async function openStartupSetupTerminal(workspaceId: string, threadId: string): Promise<void> {
  try {
    const { ptyId, shell } = await getTransport().openAutomaticSetupTerminal(threadId);
    // The rail tab only attaches to a visible panel, so reveal it before adding the tab.
    showRightPanelAdaptive(workspaceId, threadId);
    useTerminalStore.getState().addTerminal(threadId, ptyId, shell);
    useDiffStore.getState().addRightPanelTerminalTab(workspaceId, threadId, ptyId);
  } catch (error) {
    useToastStore.getState().show({
      kind: "failed",
      title: "Could not open setup terminal",
      meta: error instanceof Error ? error.message : undefined,
    });
  }
}

/** Opens Project settings on the environment tab, where the setup script is edited. */
export function editStartupSetupScript(workspaceId: string, threadId: string): void {
  showRightPanelAdaptive(workspaceId, threadId);
  useDiffStore.getState().setRightPanelTab(workspaceId, threadId, "environment");
}
