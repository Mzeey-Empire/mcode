import { showTab } from "@/lib/summon-tab";
import { useFilesTabsStore } from "./filesTabsStore";

/**
 * Handler for `files.goToFile` (mod+p): opens the Files tool if needed, then
 * asks it to open the Go to file popover. The request is a store counter so
 * the popover opens even when Files mounts in response to this same call.
 */
export function openGoToFile(): void {
  const scope = showTab("files");
  if (!scope) return;
  useFilesTabsStore.getState().setGoToFileOpen(scope.threadId ?? scope.workspaceId, true);
}
