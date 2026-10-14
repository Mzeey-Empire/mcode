import type { ReviewComparison } from "@mcode/contracts";
import type { FileRevertSource } from "./file-revert-source";
import { FileList } from "./FileList";

/** Props for CumulativeView. */
interface CumulativeViewProps {
  threadId: string;
  comparison: ReviewComparison;
  cacheVersion: string | number;
  /** Whether the comparison was read with whitespace changes hidden. */
  ignoreWhitespace: boolean;
  /** Since you looked passes its seen baseline; All turns omits it. */
  afterSequence?: number;
  /** Where a file header can revert from. Absent in Since you looked, which has no turn range. */
  revert?: FileRevertSource | null;
}

/**
 * Deduplicated file list across snapshots: every turn for All turns, or the
 * turns settled after `afterSequence` for Since you looked.
 */
export function CumulativeView({ threadId, comparison, cacheVersion, ignoreWhitespace, afterSequence, revert }: CumulativeViewProps) {
  const sinceLooked = afterSequence !== undefined;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <FileList
        files={comparison.files}
        source={sinceLooked ? "since-looked" : "cumulative"}
        id={sinceLooked ? String(afterSequence) : threadId}
        threadId={threadId}
        cacheVersion={cacheVersion}
        ignoreWhitespace={ignoreWhitespace}
        jumpViewKey={sinceLooked ? "since-looked" : "cumulative"}
        revert={revert}
      />
    </div>
  );
}
