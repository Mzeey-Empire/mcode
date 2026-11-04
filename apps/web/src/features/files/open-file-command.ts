import { showTab } from "@/lib/summon-tab";
import { useFilesTabsStore } from "./filesTabsStore";

/**
 * Shows the Files tool for the active scope, then opens and activates the
 * workspace-relative `path` there. Used by file mention tokens in the transcript.
 */
export function openFileInFiles(path: string): void {
  const scope = showTab("files");
  if (!scope) return;
  useFilesTabsStore.getState().openFile(scope.threadId ?? scope.workspaceId, path, { activate: true });
}
