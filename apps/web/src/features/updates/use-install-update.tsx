import { useRef, useState, type ReactElement } from "react";
import { useUpdateStore } from "@/stores/updateStore";
import { InstallUpdateDialog } from "./InstallUpdateDialog";

/** The desktop app bridge that owns update installation. */
export type DesktopAppBridge = NonNullable<Window["desktopBridge"]>["app"];

/** What {@link useInstallUpdate} hands to an install control. */
export interface InstallUpdateControl {
  /** Ask the desktop to install; a call while one is pending is ignored. */
  install(): Promise<void>;
  /** True from the click until the desktop answers. */
  installing: boolean;
  /** The running-agents confirmation, or null when nothing needs confirming. */
  dialog: ReactElement | null;
}

/**
 * The one install path for every update control. The desktop decides whether
 * agents are running; this hook only shows its confirmation and relays the
 * user's answer, so no control can install past running agents.
 * `app` is undefined outside the desktop shell, where install does nothing.
 */
export function useInstallUpdate(app: DesktopAppBridge | undefined): InstallUpdateControl {
  const pendingVersion = useUpdateStore((s) => s.pendingVersion);
  const [runningAgents, setRunningAgents] = useState<number | null | undefined>(undefined);
  const [installing, setInstalling] = useState(false);
  // State lags a render behind, so a second click in the same tick would slip past `installing`.
  const installLock = useRef(false);

  const request = async (confirmed: boolean): Promise<void> => {
    if (!app || installLock.current) return;
    installLock.current = true;
    setInstalling(true);
    try {
      const result = await app.installUpdate(confirmed ? { confirmed: true } : undefined).catch((error: unknown) => {
        console.error("[updates] installUpdate failed", error);
        return null;
      });
      if (result?.kind === "started") return;
      if (result?.kind === "agents-running") return setRunningAgents(result.runningAgents);
      if (result === null) return showInstallRequestFailure();
      await showDesktopUpdateStatus(app);
    } finally {
      installLock.current = false;
      setInstalling(false);
    }
  };

  const dialog =
    app && runningAgents !== undefined ? (
      <InstallUpdateDialog
        version={pendingVersion ?? ""}
        runningAgents={runningAgents}
        onCancel={() => setRunningAgents(undefined)}
        onRestartNow={() => {
          setRunningAgents(undefined);
          void request(true);
        }}
        onInstallWhenIdle={() => {
          setRunningAgents(undefined);
          app.installWhenIdle().catch((error: unknown) => console.error("[updates] installWhenIdle failed", error));
        }}
      />
    ) : null;

  return { install: () => request(false), installing, dialog };
}

/** Show the status the desktop published for a refused or failed install, which a missed push would otherwise hide. */
async function showDesktopUpdateStatus(app: DesktopAppBridge): Promise<void> {
  try {
    useUpdateStore.getState().setStatus(await app.getUpdateStatus());
  } catch (error) {
    console.error("[updates] getUpdateStatus failed", error);
    showInstallRequestFailure();
  }
}

/** A failed request leaves no published status to show, so the control would otherwise still offer Install. */
function showInstallRequestFailure(): void {
  useUpdateStore.getState().setStatus({ state: "error", message: "Update installation failed: the desktop app did not answer", failedOperation: "install" });
}
