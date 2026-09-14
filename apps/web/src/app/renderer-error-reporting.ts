import type { RendererCrashReport } from "../transport/desktop-bridge";

function reportRendererError(report: RendererCrashReport): void {
  try {
    void window.desktopBridge?.reportRendererCrash?.(report).catch(() => undefined);
  } catch {
    // Diagnostics must never throw inside an error handler.
  }
}

/**
 * Sends uncaught exceptions and unhandled promise rejections to the desktop
 * logger through the renderer crash channel. React boundary errors are caught
 * upstream and do not reach window.onerror, so these reports do not duplicate
 * AppErrorBoundary reports.
 */
export function initRendererErrorReporting(): void {
  window.addEventListener("error", (event) => {
    reportRendererError({
      errorName: event.error instanceof Error ? event.error.name : "Error",
      errorMessage: event.message || undefined,
      errorStack: event.error instanceof Error ? event.error.stack : undefined,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    reportRendererError({
      errorName: reason instanceof Error ? reason.name : "Error",
      errorMessage: reason instanceof Error ? reason.message : String(reason),
      errorStack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}
