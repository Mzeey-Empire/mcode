import { showTab } from "@/lib/summon-tab";
import { useFilesTabsStore } from "./filesTabsStore";

/**
 * Handler for `files.findInFile` (mod+f while focus is in the Files tool): flags the scope so the
 * find bar opens, and pulls focus back to its field when the bar is already open.
 */
export function openFindInFile(): void {
  const scope = showTab("files");
  if (!scope) return;
  useFilesTabsStore.getState().setFindOpen(scope.threadId ?? scope.workspaceId, true);
  const field = document.querySelector<HTMLInputElement>("[data-find-input]");
  field?.focus();
  field?.select();
}
