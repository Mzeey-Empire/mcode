import { useCallback } from "react";
import { getTransport } from "@/transport";
import { useOpenInApps } from "@/hooks/useOpenInApps";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToastStore } from "@/stores/toastStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { resolveDefaultOpenInApp } from "@/lib/resolveDefaultOpenInApp";
import { resolveThreadDirPath } from "@/lib/worktree";
import { dirname, joinPaths } from "@/lib/path";

/** Absolute directory the scope reads from: the thread's checkout or the workspace root. */
export function useScopeRoot(workspaceId: string, threadId: string | null): string | null {
  return useWorkspaceStore((state) => {
    const workspacePath = state.workspaces.find((workspace) => workspace.id === workspaceId)?.path ?? null;
    if (!threadId) return workspacePath;
    const thread = state.threads.find((candidate) => candidate.id === threadId);
    return thread ? resolveThreadDirPath(thread, workspacePath) : workspacePath;
  });
}

function reportFailure(title: string) {
  return (error: unknown) =>
    useToastStore.getState().show({ kind: "failed", title, meta: error instanceof Error ? error.message : String(error) });
}

/** Actions the Files More menu and file states offer for a relative path. */
export interface FileActions {
  readonly canResolve: boolean;
  readonly openInEditor: (path: string, line?: number) => void;
  readonly reveal: (path: string) => void;
  readonly copyAbsolutePath: (path: string) => void;
}

/** Open in editor, Reveal, and Copy path for files in one scope. */
export function useFileActions(workspaceId: string, threadId: string | null): FileActions {
  const root = useScopeRoot(workspaceId, threadId);
  const apps = useOpenInApps();
  const threadOverride = useWorkspaceStore((state) =>
    threadId ? state.threads.find((thread) => thread.id === threadId)?.default_open_in_app ?? null : null,
  );
  const globalDefault = useSettingsStore((state) => state.settings.externalApps.defaultEditor || null);
  const editorId = resolveDefaultOpenInApp(threadOverride, globalDefault, apps);
  const fileManagerId = apps.find((app) => app.kind === "fileManager")?.id ?? null;

  const openInEditor = useCallback(
    (path: string, line?: number) => {
      if (!root) return;
      getTransport().openIn(editorId, joinPaths(root, path), line).catch(reportFailure("Couldn't open file"));
    },
    [editorId, root],
  );
  const reveal = useCallback(
    (path: string) => {
      if (!root || !fileManagerId) return;
      getTransport().openIn(fileManagerId, dirname(joinPaths(root, path))).catch(reportFailure("Couldn't open file manager"));
    },
    [fileManagerId, root],
  );
  const copyAbsolutePath = useCallback(
    (path: string) => {
      if (!root) return;
      navigator.clipboard.writeText(joinPaths(root, path)).catch(reportFailure("Couldn't copy path"));
    },
    [root],
  );
  return { canResolve: root !== null, openInEditor, reveal, copyAbsolutePath };
}
