import type { ReviewComparison } from "@mcode/contracts";
import { FileList } from "./FileList";

/** Props for CumulativeView. */
interface CumulativeViewProps {
  threadId: string;
  comparison: ReviewComparison;
  cacheVersion: string | number;
  /** Since you looked passes its seen baseline; All turns omits it. */
  afterSequence?: number;
}

/**
 * Deduplicated file list across snapshots: every turn for All turns, or the
 * turns settled after `afterSequence` for Since you looked.
 */
export function CumulativeView({ threadId, comparison, cacheVersion, afterSequence }: CumulativeViewProps) {
  const sinceLooked = afterSequence !== undefined;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <FileList
        files={comparison.files}
        source={sinceLooked ? "since-looked" : "cumulative"}
        id={sinceLooked ? String(afterSequence) : threadId}
        threadId={threadId}
        cacheVersion={cacheVersion}
        jumpViewKey={sinceLooked ? "since-looked" : "cumulative"}
      />
    </div>
  );
}
