/**
 * One buffered git process run, expressed as plain data so it can run on the
 * calling thread or cross into the git process worker unchanged.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import type { GitExecResult } from "./types.js";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

/** Everything needed to start one buffered git process. */
export interface GitProcessRequest {
  /** Arguments after `git`. */
  readonly args: readonly string[];
  /** Working directory for the process. */
  readonly cwd?: string;
  /** Complete process environment; inherits the running thread's when absent. */
  readonly env?: NodeJS.ProcessEnv;
  /** Kill git after this many milliseconds. */
  readonly timeout: number;
}

/** Starts one buffered git process and resolves its output, or rejects with execFile's failure fields. */
export type GitProcessRunner = (request: GitProcessRequest) => Promise<GitExecResult>;

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
export const runGitProcess: GitProcessRunner = async (request) => {
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
};

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
