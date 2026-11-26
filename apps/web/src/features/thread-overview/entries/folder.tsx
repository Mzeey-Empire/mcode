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
      {/* The path stays out of view; Copy and Open cover the people who need it. */}
      <span className="flex-1 font-medium">Folder</span>
      <CopyButton text={dirPath} label="Copy folder path" />
      <IconButton aria-label="Open folder" onClick={() => openFolder(dirPath)}>
        <FolderOpen aria-hidden />
      </IconButton>
    </div>
  );
}

/** Gives the No project thread's working folder copy and open actions. */
export function FolderEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <FolderEntry /> : null;
}
