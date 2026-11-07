/**
 * Runs git processes, buffered or streamed, on one dedicated worker thread.
 *
 * Process creation is synchronous inside `child_process.execFile`: on Windows
 * each git start held the server's event loop for 3-100+ ms, and a thread
 * switch starts dozens of them, so unrelated requests such as the opened
 * thread's transcript waited behind them. Starting the processes on a worker
 * keeps that cost off the thread that answers requests.
 */

import { serverModuleUrl } from "../../../../runtime/environment/server-module-url.js";
import {
  restoreGitProcessFailure,
  type GitOutputObserver,
  type GitProcessFailure,
  type GitProcessRequest,
  type GitProcessRunner,
} from "./git-process.js";
import type { GitExecResult } from "./types.js";

/** Which output streams the caller observes; observer callbacks cannot cross the worker boundary. */
export interface GitProcessObservedStreams {
  readonly stdout: boolean;
  readonly stderr: boolean;
}

/** Main thread to git process worker. */
export interface GitProcessWorkerInbound {
  readonly id: number;
  readonly request: GitProcessRequest;
  /** Present when the run streams output back as `output` messages before its result. */
  readonly observe?: GitProcessObservedStreams;
}

/** Git process worker to main thread. */
export type GitProcessWorkerOutbound =
  | { readonly id: number; readonly output: "stdout" | "stderr"; readonly chunk: string }
  | { readonly id: number; readonly ok: true; readonly result: GitExecResult }
  | { readonly id: number; readonly ok: false; readonly failure: GitProcessFailure };

interface PendingRun {
  readonly observer: GitOutputObserver | undefined;
  readonly resolve: (result: GitExecResult) => void;
  readonly reject: (error: Error) => void;
}

/** Creates the worker thread that starts git processes. */
export type GitProcessWorkerFactory = () => Worker;

/** Owns one lazily started git process worker and routes each run's reply to its caller. */
export class GitProcessWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRun>();

  constructor(private readonly createWorker: GitProcessWorkerFactory = createGitProcessWorker) {}

  /** Runs one git process on the worker thread. */
  readonly run: GitProcessRunner = (request, observer) => {
    const worker = this.worker ?? this.start();
    const id = this.nextId++;
    // The worker's process.env is a copy taken when it started; send the
    // server's current environment so later PATH or credential changes apply.
    const message: GitProcessWorkerInbound = {
      id,
      request: { ...request, env: request.env ?? { ...process.env } },
      ...(observer ? { observe: { stdout: Boolean(observer.onStdout), stderr: Boolean(observer.onStderr) } } : {}),
    };
    return new Promise<GitExecResult>((resolve, reject) => {
      this.pending.set(id, { observer, resolve, reject });
      worker.postMessage(message);
    });
  };

  private start(): Worker {
    const worker = this.createWorker();
    // An idle git worker must not keep a stopping server alive. Bun's Worker
    // has unref; the DOM Worker type the server compiles against omits it.
    if ("unref" in worker && typeof worker.unref === "function") worker.unref();
    worker.addEventListener("message", (event: MessageEvent<GitProcessWorkerOutbound>) => this.settle(event.data));
    worker.addEventListener("error", (event) => this.fail(worker, new Error(`Git process worker failed: ${event.message}`)));
    worker.addEventListener("close", () => this.fail(worker, new Error("Git process worker exited")));
    this.worker = worker;
    return worker;
  }

  private settle(reply: GitProcessWorkerOutbound): void {
    const run = this.pending.get(reply.id);
    if (!run) return;
    // Worker messages arrive in send order, so every chunk precedes its run's result.
    if ("output" in reply) {
      if (reply.output === "stdout") run.observer?.onStdout?.(reply.chunk);
      else run.observer?.onStderr?.(reply.chunk);
      return;
    }
    this.pending.delete(reply.id);
    if (reply.ok) run.resolve(reply.result);
    else run.reject(restoreGitProcessFailure(reply.failure));
  }

  /** Rejects every run the lost worker owned; the next run starts a fresh worker. */
  private fail(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    worker.terminate();
    const runs = [...this.pending.values()];
    this.pending.clear();
    for (const run of runs) run.reject(error);
  }
}

let sharedClient: GitProcessWorkerClient | undefined;

/** The one git process worker every main-thread executor shares, so the server holds a single extra thread. */
export function sharedGitProcessWorkerClient(): GitProcessWorkerClient {
  sharedClient ??= new GitProcessWorkerClient();
  return sharedClient;
}

/** Starts the git process worker from source or from the bundled server. */
export function createGitProcessWorker(): Worker {
  const moduleUrl = serverModuleUrl(import.meta.url);
  const filename = moduleUrl.endsWith(".cjs") ? "./git-process.worker.cjs" : "./git-process.worker.ts";
  const options = { type: "module", smol: true } satisfies WorkerOptions & { smol: boolean };
  return new Worker(new URL(filename, moduleUrl), options);
}
