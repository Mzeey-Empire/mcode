import type { ReviewComparison } from "@mcode/contracts";
import type { DiffSource } from "@/stores/diffStore";
import { FileList } from "./FileList";

/** The threadless git working-tree views the Review tab renders against the workspace root. */
export type GitView = "unstaged" | "staged" | "commit" | "branch";

/** Props for GitDiffView. */
interface GitDiffViewProps {
  comparison: ReviewComparison;
  source: DiffSource;
  id: string;
  cacheVersion: string | number;
  threadId: string;
  /** Whether the comparison was read with whitespace changes hidden. */
  ignoreWhitespace: boolean;
}

/** Render the diff projection of a git comparison with files, resolved by the parent Review lifecycle. */
export function GitDiffView({ comparison, source, id, cacheVersion, threadId, ignoreWhitespace }: GitDiffViewProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <FileList
        files={comparison.files}
        source={source}
        id={id}
        threadId={threadId}
        cacheVersion={cacheVersion}
        ignoreWhitespace={ignoreWhitespace}
        defaultFilesExpanded
      />
    </div>
  );
}
