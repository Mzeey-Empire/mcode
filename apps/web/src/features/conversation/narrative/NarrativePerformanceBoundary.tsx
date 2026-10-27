import type { ReactNode } from "react";
import { ReactPerformanceProfiler, reactProfilingEnabled } from "@/performance/ReactPerformanceProfiler";

/** Records React commit data for the narrative surface in profiling builds. */
export function NarrativePerformanceBoundary({ children }: { readonly children: ReactNode }) {
  return <ReactPerformanceProfiler id="narrative">{children}</ReactPerformanceProfiler>;
}

/** Records one narrative row render without changing its DOM structure. */
export function NarrativePerformanceRow({
  children,
  rowId,
}: {
  readonly children: ReactNode;
  readonly rowId: string;
}) {
  if (reactProfilingEnabled) window.__mcodeReactPerformanceSink?.recordRowRender(rowId);
  return <>{children}</>;
}

/** Returns a row identifier only when the React profiling build is active. */
export function narrativePerformanceRowId(rowId: string): string | undefined {
  return reactProfilingEnabled ? rowId : undefined;
}
