import { useCallback } from "react";
import { useScopeRoot } from "@/features/files/useFileActions";
import { useOpenInApps } from "@/hooks/useOpenInApps";
import { resolveDefaultOpenInApp } from "@/lib/resolveDefaultOpenInApp";
import type { OpenInApp } from "@/transport/types";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToastStore } from "@/stores/toastStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { getTransport } from "@/transport";

function reportFailure(title: string) {
  return (error: unknown) =>
    useToastStore.getState().show({ kind: "failed", title, meta: error instanceof Error ? error.message : String(error) });
}

/**
 * The detected editor "Open in editor" should launch, or null when none is installed.
 * The thread's Open-in choice can be any app (even an external terminal), so the shared
 * default is only honoured when it is an editor.
 */
export function resolveEditorId(
  threadOverride: string | null,
  globalDefault: string | null,
  apps: readonly OpenInApp[],
): string | null {
  const preferred = apps.find((app) => app.id === resolveDefaultOpenInApp(threadOverride, globalDefault, apps));
  if (preferred?.kind === "editor" && preferred.detected) return preferred.id;
  return apps.find((app) => app.kind === "editor" && app.detected)?.id ?? null;
}

interface FolderActions {
  /** The shell's folder, falling back to the scope's checkout while the server has not reported one. */
  readonly path: string | null;
  readonly openInEditor: () => void;
  readonly editorReason: string | null;
  readonly openInFileManager: () => void;
  readonly openInExternalTerminal: () => void;
  readonly externalTerminalReason: string | null;
}

/** Open-in actions for one shell's working folder. */
export function useFolderActions(workspaceId: string, threadId: string | null, cwd: string | null): FolderActions {
  const scopeRoot = useScopeRoot(workspaceId, threadId);
  const path = cwd ?? scopeRoot;
  const apps = useOpenInApps();
  const threadOverride = useWorkspaceStore((state) =>
    threadId ? state.threads.find((thread) => thread.id === threadId)?.default_open_in_app ?? null : null,
  );
  const globalDefault = useSettingsStore((state) => state.settings.externalApps.defaultEditor || null);
  const editorId = resolveEditorId(threadOverride, globalDefault, apps);
  const fileManagerId = apps.find((app) => app.kind === "fileManager")?.id ?? null;
  const externalTerminalId = apps.find((app) => app.kind === "terminal" && app.detected)?.id ?? null;

  const openWith = useCallback(
    (appId: string | null, failureTitle: string) => {
      if (!path || !appId) return;
      getTransport().openIn(appId, path).catch(reportFailure(failureTitle));
    },
    [path],
  );
  return {
    path,
    openInEditor: useCallback(() => openWith(editorId, "Couldn't open editor"), [openWith, editorId]),
    openInFileManager: useCallback(() => openWith(fileManagerId, "Couldn't open file manager"), [openWith, fileManagerId]),
    openInExternalTerminal: useCallback(
      () => openWith(externalTerminalId, "Couldn't open terminal"),
      [openWith, externalTerminalId],
    ),
    editorReason: editorId ? null : "No editor found",
    externalTerminalReason: externalTerminalId ? null : "No external terminal found",
  };
}
