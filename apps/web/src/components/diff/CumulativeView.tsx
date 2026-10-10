import type { ReviewComparison } from "@mcode/contracts";
import { FileList } from "./FileList";

/** Props for CumulativeView. */
interface CumulativeViewProps {
  threadId: string;
  comparison: ReviewComparison;
  cacheVersion: string | number;
  refreshing: boolean;
  onRefresh: () => void;
}

/** Deduplicated file list across all snapshots for the "All" cumulative view. */
export function CumulativeView({ threadId, comparison, cacheVersion, refreshing, onRefresh }: CumulativeViewProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <FileList
        files={comparison.files}
        source="cumulative"
        id={threadId}
        threadId={threadId}
        cacheVersion={cacheVersion}
        refreshable
        refreshing={refreshing}
        onRefresh={onRefresh}
        jumpViewKey="cumulative"
      />
    </div>
  );
}
