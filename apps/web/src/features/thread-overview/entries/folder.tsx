import { CopyButton } from "@/components/ui/copy-button";
import { IconButton } from "@/components/ui/button";
import { OVERVIEW_ROW_CLASS, OverviewRowIcon } from "@/features/thread-overview/overview-row";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { FILE_EXPLORER_ID } from "@/lib/resolveDefaultOpenInApp";
import { cn } from "@/lib/utils";
import { useToastStore } from "@/stores/toastStore";
import { getTransport } from "@/transport";
import { Folder, FolderOpen } from "lucide-react";

function openFolder(path: string): void {
  getTransport().openIn(FILE_EXPLORER_ID, path).catch((error: unknown) => {
    useToastStore.getState().show({
      kind: "failed",
      title: "Could not open the folder",
      meta: error instanceof Error ? error.message : String(error),
    });
  });
}

function FolderEntry() {
  const { dirPath } = useOverviewContext();
  if (!dirPath) return null;
  return (
    <div data-testid="thread-overview-folder" className={cn(OVERVIEW_ROW_CLASS, "flex items-center pr-1")}>
      <OverviewRowIcon><Folder /></OverviewRowIcon>
      <span className="shrink-0 font-medium">Folder</span>
      <span data-testid="thread-overview-folder-path" className="min-w-0 flex-1 text-fade font-mono text-caption text-muted">{dirPath}</span>
      <CopyButton text={dirPath} label="Copy folder path" className="shrink-0" />
      <IconButton aria-label="Open folder" className="shrink-0" onClick={() => openFolder(dirPath)}>
        <FolderOpen aria-hidden />
      </IconButton>
    </div>
  );
}

/** Shows the No project thread's working folder with copy and open actions. */
export function FolderEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <FolderEntry /> : null;
}
