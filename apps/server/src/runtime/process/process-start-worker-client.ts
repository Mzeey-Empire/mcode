/**
 * Runs short-lived processes, buffered or streamed, on one dedicated worker thread.
 *
 * Process creation is synchronous inside `child_process.execFile`. On Windows,
 * git and startup probes can hold the server event loop for hundreds of
 * milliseconds. Starting them on a worker keeps that cost off the thread
 * that answers requests.
 */

import { serverModuleUrl } from "../environment/server-module-url.js";
import {
  restoreProcessStartFailure,
  type ProcessOutputObserver,
  type ProcessStartFailure,
  type ProcessStartRequest,
  type ProcessStartRunner,
} from "./process-start.js";
import type { ProcessStartResult } from "./process-start.js";

/** Which output streams the caller observes; observer callbacks cannot cross the worker boundary. */
export interface ProcessStartObservedStreams {
  readonly stdout: boolean;
  readonly stderr: boolean;
}

/** Main thread to process worker. */
export interface ProcessStartWorkerInbound {
  readonly id: number;
  readonly request: ProcessStartRequest;
  /** Present when the run streams output back as `output` messages before its result. */
  readonly observe?: ProcessStartObservedStreams;
}

/** Process worker to main thread. */
export type ProcessStartWorkerOutbound =
  | { readonly id: number; readonly output: "stdout" | "stderr"; readonly chunk: string }
  | { readonly id: number; readonly ok: true; readonly result: ProcessStartResult }
  | { readonly id: number; readonly ok: false; readonly failure: ProcessStartFailure };

interface PendingRun {
  readonly observer: ProcessOutputObserver | undefined;
  readonly resolve: (result: ProcessStartResult) => void;
  readonly reject: (error: Error) => void;
}

/** Creates the worker thread that starts processes. */
export type ProcessStartWorkerFactory = () => Worker;

/** Owns one lazily started process worker and routes each run's reply to its caller. */
export class ProcessStartWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRun>();

  constructor(private readonly createWorker: ProcessStartWorkerFactory = createProcessStartWorker) {}

  /** Runs one process on the worker thread. */
  readonly run: ProcessStartRunner = (request, observer) => {
    const worker = this.worker ?? this.start();
    const id = this.nextId++;
    // The worker's process.env is a copy taken when it started; send the
    // server's current environment so later PATH or credential changes apply.
    const message: ProcessStartWorkerInbound = {
      id,
      request: { ...request, env: request.env ?? { ...process.env } },
      ...(observer ? { observe: { stdout: Boolean(observer.onStdout), stderr: Boolean(observer.onStderr) } } : {}),
    };
    return new Promise<ProcessStartResult>((resolve, reject) => {
      this.pending.set(id, { observer, resolve, reject });
      worker.postMessage(message);
    });
  };

  private start(): Worker {
    const worker = this.createWorker();
    // An idle process worker must not keep a stopping server alive. Bun's Worker
    // has unref; the DOM Worker type the server compiles against omits it.
    if ("unref" in worker && typeof worker.unref === "function") worker.unref();
    worker.addEventListener("message", (event: MessageEvent<ProcessStartWorkerOutbound>) => this.settle(event.data));
    worker.addEventListener("error", (event) => this.fail(worker, new Error(`Process worker failed: ${event.message}`)));
    worker.addEventListener("close", () => this.fail(worker, new Error("Process worker exited")));
    this.worker = worker;
    return worker;
  }

  private settle(reply: ProcessStartWorkerOutbound): void {
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
    else run.reject(restoreProcessStartFailure(reply.failure));
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

let sharedClient: ProcessStartWorkerClient | undefined;

/** The one process worker every main-thread executor shares, so the server holds a single extra thread. */
export function sharedProcessStartWorkerClient(): ProcessStartWorkerClient {
  sharedClient ??= new ProcessStartWorkerClient();
  return sharedClient;
}

/** Starts the process worker from source or from the bundled server. */
export function createProcessStartWorker(): Worker {
  const moduleUrl = serverModuleUrl(import.meta.url);
  const filename = moduleUrl.endsWith(".cjs") ? "./process-start.worker.cjs" : "./process-start.worker.ts";
  const options = { type: "module", smol: true } satisfies WorkerOptions & { smol: boolean };
  return new Worker(new URL(filename, moduleUrl), options);
}
