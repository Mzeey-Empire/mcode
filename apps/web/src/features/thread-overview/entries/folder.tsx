import { CopyButton } from "@/components/ui/copy-button";
import { OVERVIEW_ROW_CLASS, OverviewRowIcon } from "@/features/thread-overview/overview-row";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { cn } from "@/lib/utils";
import { Folder } from "lucide-react";
import { Fragment } from "react";

/** Lets a path wrap after each separator; hyphens already allow a break, so words stay whole. */
function withSeparatorBreaks(path: string) {
  return path.split(/(?<=[\\/])/).map((segment, index) => <Fragment key={index}>{segment}<wbr /></Fragment>);
}

function FolderEntry() {
  const { dirPath } = useOverviewContext();
  if (!dirPath) return null;
  // The header's Open in button already opens this folder, so the row only copies its path.
  return (
    <div data-testid="thread-overview-folder" className={cn(OVERVIEW_ROW_CLASS, "flex items-center pr-1")}>
      {/* The row does nothing on click, so its icon stays steady under the pointer. */}
      <OverviewRowIcon className="group-hover:text-muted"><Folder /></OverviewRowIcon>
      <span className="flex-1 font-medium">Folder</span>
      <CopyButton
        text={dirPath}
        label="Copy folder path"
        // The tall path tooltip has no room above the card and flips below, so Copied is pinned there too.
        tooltipSide="bottom"
        tooltip={
          <span className="flex flex-col gap-0.5">
            <span>Copy folder path</span>
            {/* The readable folder name is at the path's end, so the path wraps rather than fades. */}
            <span className="font-mono text-muted [overflow-wrap:anywhere]">{withSeparatorBreaks(dirPath)}</span>
          </span>
        }
      />
    </div>
  );
}

/** Gives the No project thread's working folder a copy action that shows its path on hover. */
export function FolderEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <FolderEntry /> : null;
}
