import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";

/** Commit sink that the frontend performance runner installs on `window`. */
export interface ReactPerformanceSink {
  recordCommit(commit: {
    readonly profilerId: string;
    readonly actualDurationMs: number;
    readonly baseDurationMs: number;
    readonly phase: "mount" | "update" | "nested-update";
    readonly startTimeMs: number;
    readonly commitTimeMs: number;
  }): void;
  recordRowRender(rowId: string): void;
  /** Counts a named performance event. */
  recordCounter?(name: string): void;
}

declare global {
  interface Window {
    __mcodeReactPerformanceSink?: ReactPerformanceSink;
  }
}

/** True only in the React profiling build that `bun run perf:frontend --mode profiling` produces. */
export const reactProfilingEnabled = import.meta.env.VITE_MCODE_PERFORMANCE_MODE === "profiling";

const recordCommit: ProfilerOnRenderCallback = (
  profilerId,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime,
) => {
  window.__mcodeReactPerformanceSink?.recordCommit({
    profilerId,
    actualDurationMs: actualDuration,
    baseDurationMs: baseDuration,
    phase,
    startTimeMs: startTime,
    commitTimeMs: commitTime,
  });
};

/** Records React commits for one named surface in profiling builds and renders children unchanged otherwise. */
export function ReactPerformanceProfiler({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  if (!reactProfilingEnabled) return children;
  return (
    <Profiler id={id} onRender={recordCommit}>
      {children}
    </Profiler>
  );
}
