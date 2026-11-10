/**
 * One git process run, expressed as plain data so it can run on the
 * calling thread or cross into the git process worker unchanged.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import type { GitExecResult } from "./types.js";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

/** Everything needed to start one git process. */
export interface GitProcessRequest {
  /** Arguments after `git`. */
  readonly args: readonly string[];
  /** Working directory for the process. */
  readonly cwd?: string;
  /** Complete process environment; inherits the running thread's when absent. */
  readonly env?: NodeJS.ProcessEnv;
  /** Kill git after this many milliseconds. */
  readonly timeout: number;
  /** When observed, false drops stdout from the result after handing each chunk to the observer. */
  readonly retainStdout?: boolean;
  /** Written to stdin, which is then closed. */
  readonly input?: string;
}

/** Receives git output while the process runs. */
export interface GitOutputObserver {
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
}

/**
 * Starts one git process and resolves its output, or rejects with execFile's failure fields.
 * With an observer, output streams to it as it arrives instead of only buffering.
 */
export type GitProcessRunner = (request: GitProcessRequest, observer?: GitOutputObserver) => Promise<GitExecResult>;

/** The execFile failure fields git callers read, as structured-clone-safe data. */
export interface GitProcessFailure {
  readonly message: string;
  readonly code?: number | string | null;
  readonly signal?: string | null;
  readonly killed?: boolean;
  readonly cmd?: string;
  readonly stdout?: string;
  readonly stderr?: string;
}

/** Runs git on the calling thread. Process creation blocks this thread until the OS returns. */
export const runGitProcess: GitProcessRunner = (request, observer) =>
  observer || request.input !== undefined
    ? runObservedGitProcess(request, observer ?? {})
    : runBufferedGitProcess(request);

async function runBufferedGitProcess(request: GitProcessRequest): Promise<GitExecResult> {
  const result = await execFile("git", [...request.args], {
    timeout: request.timeout,
    windowsHide: true,
    encoding: "utf8",
    ...(request.env ? { env: request.env } : {}),
    ...(request.cwd ? { cwd: request.cwd } : {}),
  });
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout),
    stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr),
  };
}

/** Runs git with streamed output while preserving the buffered result and execFile's error fields. */
function runObservedGitProcess(request: GitProcessRequest, observer: GitOutputObserver): Promise<GitExecResult> {
  const { timeout } = request;
  return new Promise<GitExecResult>((resolve, reject) => {
    const child = NodeChildProcess.spawn("git", [...request.args], {
      windowsHide: true,
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
      // Git may exit before reading all of its input. Its exit code reports that; the broken pipe is not a second failure.
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
        reject(Object.assign(new Error(`Git command timed out after ${timeout} ms`), {
          code: null,
          signal,
          stdout,
          stderr,
          killed: true,
        }));
        return;
      }
      if (code !== 0) {
        reject(Object.assign(new Error(`Git exited with code ${code ?? "unknown"}`), {
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
export function describeGitProcessFailure(error: unknown): GitProcessFailure {
  if (!(error instanceof Error)) return { message: String(error) };
  const fields = error as Error & Partial<Omit<GitProcessFailure, "message">>;
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
export function restoreGitProcessFailure(failure: GitProcessFailure): Error {
  const { message, ...fields } = failure;
  return Object.assign(new Error(message), fields);
}
