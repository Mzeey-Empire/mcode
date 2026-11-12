/**
 * One process run, expressed as plain data so it can run on the
 * calling thread or cross into the process worker unchanged.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
/** Buffered UTF-8 output from a short-lived process. */
export interface ProcessStartResult {
  readonly stdout: string;
  readonly stderr: string;
}

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

/** Everything needed to start one process. */
export interface ProcessStartRequest {
  readonly command: string;
  readonly shell?: boolean;
  readonly maxBuffer?: number;
  /** Arguments after the command. */
  readonly args: readonly string[];
  /** Working directory for the process. */
  readonly cwd?: string;
  /** Complete process environment; inherits the running thread's when absent. */
  readonly env?: NodeJS.ProcessEnv;
  /** Kill the process after this many milliseconds. */
  readonly timeout: number;
  /** When observed, false drops stdout from the result after handing each chunk to the observer. */
  readonly retainStdout?: boolean;
  /** Written to stdin, which is then closed. */
  readonly input?: string;
}

/** Receives process output while the process runs. */
export interface ProcessOutputObserver {
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
  readonly onStdinError?: (message: string) => void;
}

/** An interactive process owned by the thread that starts it. */
export interface ProcessStartSession {
  write(text: string): void;
  stop(): void;
  readonly exited: Promise<void>;
}

/** Starts an interactive process without closing stdin after the first write. */
export type ProcessStartOpener = (
  request: ProcessStartRequest, observer: ProcessOutputObserver,
) => ProcessStartSession;

/** Hosts a session on the calling thread, including process-tree termination. */
export const openProcessStart: ProcessStartOpener = (request, observer) => {
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  let ended = false;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout>;
  const finish = () => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    resolveExit();
  };
  let child: NodeChildProcess.ChildProcessWithoutNullStreams;
  const stop = () => {
    if (ended || stopping) return;
    stopping = true;
    // With shell:true, killing cmd.exe alone would orphan the actual process.
    if (hostRuntime.platform === "win32" && child.pid !== undefined) {
      NodeChildProcess.execFile("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true }, finish);
    } else {
      child.kill("SIGKILL");
    }
  };
  const session: ProcessStartSession = {
    write: (text) => { if (!ended && !stopping) child.stdin.write(text); },
    stop,
    exited,
  };
  try {
    child = NodeChildProcess.spawn(request.command, [...request.args], {
      windowsHide: true, shell: request.shell, env: request.env, cwd: request.cwd,
    });
  } catch {
    finish();
    return session;
  }
  child.stdin.on("error", (error: Error) => observer.onStdinError?.(error.message));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => observer.onStdout?.(chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => observer.onStderr?.(chunk));
  child.once("error", finish);
  child.once("close", () => { if (!stopping || hostRuntime.platform !== "win32") finish(); });
  timer = setTimeout(stop, request.timeout);
  return session;
};

/**
 * Starts one process and resolves its output, or rejects with execFile's failure fields.
 * With an observer, output streams to it as it arrives instead of only buffering.
 */
export type ProcessStartRunner = (request: ProcessStartRequest, observer?: ProcessOutputObserver) => Promise<ProcessStartResult>;

/** The execFile failure fields git callers read, as structured-clone-safe data. */
export interface ProcessStartFailure {
  readonly message: string;
  readonly code?: number | string | null;
  readonly signal?: string | null;
  readonly killed?: boolean;
  readonly cmd?: string;
  readonly stdout?: string;
  readonly stderr?: string;
}

/** Runs a process on the calling thread. Process creation blocks this thread until the OS returns. */
export const runProcessStart: ProcessStartRunner = (request, observer) =>
  observer || request.input !== undefined
    ? runObservedProcessStart(request, observer ?? {})
    : runBufferedProcessStart(request);

async function runBufferedProcessStart(request: ProcessStartRequest): Promise<ProcessStartResult> {
  const result = await execFile(request.command, [...request.args], {
    timeout: request.timeout,
    windowsHide: true,
    ...(request.shell !== undefined ? { shell: request.shell } : {}),
    encoding: "utf8",
    ...(request.maxBuffer !== undefined ? { maxBuffer: request.maxBuffer } : {}),
    ...(request.env ? { env: request.env } : {}),
    ...(request.cwd ? { cwd: request.cwd } : {}),
  });
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout),
    stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr),
  };
}

/** Runs a process with streamed output while preserving the buffered result and execFile's error fields. */
function runObservedProcessStart(request: ProcessStartRequest, observer: ProcessOutputObserver): Promise<ProcessStartResult> {
  const { timeout } = request;
  return new Promise<ProcessStartResult>((resolve, reject) => {
    const child = NodeChildProcess.spawn(request.command, [...request.args], {
      windowsHide: true,
      ...(request.shell !== undefined ? { shell: request.shell } : {}),
      ...(request.env ? { env: request.env } : {}),
      ...(request.cwd ? { cwd: request.cwd } : {}),
    });
    let stdout = "";
    let stderr = "";
    const stdoutDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    const finish = (result: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      result();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const text = stdoutDecoder.decode(chunk, { stream: true });
      if (request.retainStdout !== false) stdout += text;
      observer.onStdout?.(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      observer.onStderr?.(text);
    });
    if (request.input !== undefined) {
      // The process may exit before reading all of its input. Its exit code reports that; the broken pipe is not a second failure.
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") finish(() => reject(error));
      });
      child.stdin.end(request.input);
    }
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => finish(() => {
      const tail = stdoutDecoder.decode();
      if (request.retainStdout !== false) stdout += tail;
      if (tail) observer.onStdout?.(tail);
      if (timedOut) {
        reject(Object.assign(new Error(`Process timed out after ${timeout} ms`), {
          code: null,
          signal,
          stdout,
          stderr,
          killed: true,
        }));
        return;
      }
      if (code !== 0) {
        reject(Object.assign(new Error(`Process exited with code ${code ?? "unknown"}`), {
          code,
          signal,
          stdout,
          stderr,
        }));
        return;
      }
      resolve({ stdout, stderr });
    }));
  });
}

/** Copies the fields of an execFile rejection that survive a worker boundary. */
export function describeProcessStartFailure(error: unknown): ProcessStartFailure {
  if (!(error instanceof Error)) return { message: String(error) };
  const fields = error as Error & Partial<Omit<ProcessStartFailure, "message">>;
  return {
    message: error.message,
    code: fields.code,
    signal: fields.signal,
    killed: fields.killed,
    cmd: fields.cmd,
    stdout: fields.stdout,
    stderr: fields.stderr,
  };
}

/** Rebuilds the Error shape execFile rejects with, so callers see the same failure on either thread. */
export function restoreProcessStartFailure(failure: ProcessStartFailure): Error {
  const { message, ...fields } = failure;
  return Object.assign(new Error(message), fields);
}
