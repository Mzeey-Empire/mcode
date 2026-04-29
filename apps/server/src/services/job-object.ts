/**
 * Windows Job Object wrapper for grouping child processes under the server.
 *
 * On Windows: creates a kernel Job Object with KILL_ON_JOB_CLOSE so every
 * descendant process dies atomically when the server exits (graceful or
 * crash). Job membership inherits through normal CreateProcess semantics;
 * `assign()` exists for spawns that opt out of inheritance (notably
 * node-pty/ConPTY).
 *
 * On non-Windows: every method is a no-op. Unix already has process groups
 * and the existing process-kill.ts handles that path.
 */
export class JobObject {
  public readonly isWindowsJob: boolean;
  private initialized = false;

  constructor() {
    this.isWindowsJob = process.platform === "win32";
    if (this.isWindowsJob) {
      this.initWindows();
    }
  }

  /** Attach a process to the job. No-op on non-Windows or if the job failed to init. */
  assign(pid: number): void {
    if (!this.initialized) return;
    this.assignWindows(pid);
  }

  /** Close the job handle, terminating all assigned processes (Windows). */
  close(): void {
    if (!this.initialized) return;
    this.closeWindows();
  }

  // Windows-only fields and methods (defined in Task 2).
  private initWindows(): void {
    // Task 2: set this.initialized = true only on successful CreateJobObjectW
  }
  private assignWindows(_pid: number): void {
    // Implemented in Task 2.
  }
  private closeWindows(): void {
    // Implemented in Task 2.
  }
}
