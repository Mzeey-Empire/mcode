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
import { createRequire } from "node:module";
import { logger } from "@mcode/shared";

const _require = createRequire(import.meta.url);

const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
// JOBOBJECT_EXTENDED_LIMIT_INFORMATION sizes:
// x64/arm64 = 144 bytes, x86 = 112 bytes.
// LimitFlags is at offset 16 in BasicLimitInformation (which is at offset 0).
const EXTENDED_LIMIT_SIZE = process.arch === "ia32" ? 112 : 144;

interface WindowsState {
  jobHandle: unknown; // opaque koffi handle
  CloseHandle: (h: unknown) => number;
  AssignProcessToJobObject: (job: unknown, proc: unknown) => number;
  OpenProcess: (access: number, inherit: number, pid: number) => unknown;
}

/**
 * Groups child processes under a Windows Job Object so they die atomically
 * when the server exits. No-op on non-Windows platforms (Unix process groups
 * already provide equivalent semantics via process-kill.ts).
 */
export class JobObject {
  /**
   * True when running on Windows. Reflects platform detection only;
   * actual job-handle readiness is tracked by the private `initialized`
   * field (false when koffi/native init fails).
   */
  public readonly isWindowsJob: boolean;
  private initialized = false;
  private windowsState: WindowsState | null = null;

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

  private initWindows(): void {
    try {
      // Dynamic require so non-Windows builds never load the native binary.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const koffi = _require("koffi") as any;
      const kernel32 = koffi.load("kernel32.dll");

      const CreateJobObjectW = kernel32.func("void* __stdcall CreateJobObjectW(void*, str16)");
      const AssignProcessToJobObject = kernel32.func("int __stdcall AssignProcessToJobObject(void*, void*)");
      const OpenProcess = kernel32.func("void* __stdcall OpenProcess(uint32, int, uint32)");
      const CloseHandle = kernel32.func("int __stdcall CloseHandle(void*)");
      const SetInformationJobObject = kernel32.func("int __stdcall SetInformationJobObject(void*, int, void*, uint32)");

      const jobHandle = CreateJobObjectW(null, null);
      if (!jobHandle) {
        throw new Error("CreateJobObjectW returned NULL");
      }

      // Zero a buffer of the right size and set LimitFlags = KILL_ON_JOB_CLOSE at offset 16.
      const buffer = Buffer.alloc(EXTENDED_LIMIT_SIZE);
      buffer.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);

      const setOk = SetInformationJobObject(
        jobHandle,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        buffer,
        EXTENDED_LIMIT_SIZE,
      );
      if (!setOk) {
        CloseHandle(jobHandle);
        throw new Error("SetInformationJobObject failed");
      }

      this.windowsState = { jobHandle, CloseHandle, AssignProcessToJobObject, OpenProcess };
      this.initialized = true;
      logger.info("JobObject initialized");
    } catch (err) {
      logger.warn("JobObject: Windows init failed, falling back to no-op", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private assignWindows(pid: number): void {
    const s = this.windowsState!;
    let procHandle: unknown = null;
    try {
      procHandle = s.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
      if (!procHandle) {
        // Process may already be dead, or we lack access. Best-effort.
        return;
      }
      const ok = s.AssignProcessToJobObject(s.jobHandle, procHandle);
      if (!ok) {
        logger.debug("JobObject: AssignProcessToJobObject failed", { pid });
      }
    } catch (err) {
      logger.debug("JobObject: assign threw", {
        pid,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (procHandle) {
        try { s.CloseHandle(procHandle); } catch { /* ignore */ }
      }
    }
  }

  private closeWindows(): void {
    const s = this.windowsState!;
    this.initialized = false;
    this.windowsState = null;
    try {
      s.CloseHandle(s.jobHandle);
    } catch (err) {
      logger.debug("JobObject: close threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
