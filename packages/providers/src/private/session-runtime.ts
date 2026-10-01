import * as NodeChildProcess from "node:child_process";
import type { ProviderProcessPort } from "../host-ports.js";

const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1_000;
const EVICTION_INTERVAL_MS = 60 * 1_000;
const GRACEFUL_STOP_TIMEOUT_MS = 5_000;

/** Arguments supplied to one private protocol adapter spawn. */
export interface SpawnArgs {
  sessionId: string;
  threadId: string;
  cwd: string;
  permissionMode: string;
  resumeFrom?: string;
  env: Record<string, string>;
}

/** Result of one private protocol adapter spawn. */
export interface SpawnResult<TState> {
  state: TState;
  pids: number[];
}

/** Private protocol operations used by the shared Provider session runtime. */
export interface ProtocolAdapter<TState> {
  spawn(args: SpawnArgs): Promise<SpawnResult<TState>>;
  isBusy(state: TState): boolean;
  interrupt(state: TState): Promise<void> | void;
  close(state: TState): Promise<void> | void;
  isStale(state: TState, args: { cwd: string; permissionMode: string }): boolean;
}

interface SessionRuntimeJobPort {
  readonly isWindowsJob: boolean;
  assign(pid: number): boolean;
  setDescription(pid: number, description: string): void;
}

interface SessionRuntimeEnvironmentPort {
  getEnv(): Record<string, string>;
}

interface SessionRuntimeLoggerPort {
  debug(message: string, context: Record<string, unknown>): void;
  info(message: string, context: Record<string, unknown>): void;
  warn(message: string, context: Record<string, unknown>): void;
}

interface PoolEntry<TState> {
  state: TState;
  pids: number[];
  lastUsedAt: number;
}

class SpawnRetirementFailure extends Error {
  constructor(cause: unknown) {
    super("Provider session retirement failed during spawn", { cause });
  }
}

/** Owns the lifecycle for one Provider's persistent sessions. */
export class SessionRuntime<TState> {
  private readonly sessions = new Map<string, PoolEntry<TState>>();
  private readonly pendingSpawns = new Map<string, Promise<TState>>();
  private readonly stopsDuringSpawn = new Set<string>();
  private readonly teardowns = new Map<string, Promise<void>>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;
  private readonly idleTtlMs: number;
  private shuttingDown = false;

  constructor(
    private readonly adapter: ProtocolAdapter<TState>,
    private readonly deps: {
      jobObject: SessionRuntimeJobPort;
      processes?: ProviderProcessPort;
      envService: SessionRuntimeEnvironmentPort;
      idleTtlMs?: number;
      logger?: SessionRuntimeLoggerPort;
    },
  ) {
    this.idleTtlMs = deps.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  }

  /** Gets a live session and creates it lazily when it is absent or stale. */
  async acquire(args: {
    sessionId: string;
    threadId: string;
    cwd: string;
    permissionMode: string;
    resumeFrom?: string;
    signal?: AbortSignal;
  }): Promise<TState> {
    args.signal?.throwIfAborted();
    if (this.shuttingDown) throw new Error("Provider session runtime is shutting down");
    this.ensureEvictionTimer();
    const teardown = this.teardowns.get(args.sessionId);
    if (teardown) {
      // Providers can hold exclusive resources (state DBs, sockets) that a
      // spawn would race while the previous incarnation is still closing.
      await waitForAcquisition(teardown, args.signal);
      if (this.shuttingDown) throw new Error("Provider session runtime is shutting down");
    }
    const existing = this.sessions.get(args.sessionId);
    if (existing) {
      if (this.adapter.isStale(existing.state, args)) {
        await waitForAcquisition(this.stop(args.sessionId), args.signal);
        if (this.shuttingDown) throw new Error("Provider session runtime is shutting down");
      }
      else {
        existing.lastUsedAt = Date.now();
        return existing.state;
      }
    }
    args.signal?.throwIfAborted();
    const pending = this.pendingSpawns.get(args.sessionId);
    if (pending) {
      await waitForAcquisition(pending, args.signal);
      return this.acquire(args);
    }
    const spawn = this.spawn(args).finally(() => {
      if (this.pendingSpawns.get(args.sessionId) === spawn) this.pendingSpawns.delete(args.sessionId);
    });
    this.pendingSpawns.set(args.sessionId, spawn);
    return waitForAcquisition(spawn, args.signal);
  }

  /** Returns the live state for one session. */
  get(sessionId: string): TState | undefined {
    return this.sessions.get(sessionId)?.state;
  }

  /** Records recent use so idle eviction preserves an active session. */
  recordUsage(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.lastUsedAt = Date.now();
  }

  /** Returns the number of live sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** Returns one bounded snapshot of live session states. */
  states(): TState[] {
    return [...this.sessions.values()].map((entry) => entry.state);
  }

  /** Evicts unprotected non-busy sessions under memory pressure. */
  async evictNonBusy(reason: string, isSessionProtected: (sessionId: string) => boolean = () => false): Promise<{ before: number; after: number; evicted: string[] }> {
    const before = this.sessions.size;
    const evicted: string[] = [];
    const sessions = Array.from(this.sessions);
    for (const [sessionId, entry] of sessions) {
      if (this.sessions.get(sessionId) !== entry || isSessionProtected(sessionId) || this.adapter.isBusy(entry.state)) continue;
      evicted.push(sessionId);
      this.deps.logger?.info("SessionRuntime evicting non-busy session", { sessionId, reason });
      await this.stop(sessionId);
    }
    return { before, after: this.sessions.size, evicted };
  }

  /** Stops one session and closes a spawn that completes after the stop request. */
  async stop(sessionId: string): Promise<void> {
    const existing = this.teardowns.get(sessionId);
    if (existing) return existing;
    // Recorded before the work begins so a racing acquire waits instead of
    // spawning alongside teardown or joining a spawn that is being stopped.
    const work = Promise.resolve().then(() => this.performStop(sessionId));
    this.teardowns.set(sessionId, work);
    await work;
    if (this.teardowns.get(sessionId) === work) this.teardowns.delete(sessionId);
  }

  private async performStop(sessionId: string): Promise<void> {
    const pending = this.pendingSpawns.get(sessionId);
    if (pending) {
      this.stopsDuringSpawn.add(sessionId);
      try { await pending; }
      catch (error) { if (error instanceof SpawnRetirementFailure) throw error.cause; }
      finally { this.stopsDuringSpawn.delete(sessionId); }
    }
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    await this.closeEntry(sessionId, entry);
  }

  /** Stops all sessions and rejects later acquisitions. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    // A session leaves the pool before native close finishes, so pool entries alone miss active teardowns.
    const teardowns = [...this.teardowns.values()];
    const sessionIds = new Set([...this.pendingSpawns.keys(), ...this.sessions.keys()]);
    const results = await Promise.allSettled([...teardowns, ...[...sessionIds].map((sessionId) => this.stop(sessionId))]);
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "Provider session shutdown failed");
  }

  private async spawn(args: {
    sessionId: string;
    threadId: string;
    cwd: string;
    permissionMode: string;
    resumeFrom?: string;
  }): Promise<TState> {
    const env = this.deps.envService.getEnv();
    const result = await this.adapter.spawn({ ...args, env });
    if (this.shuttingDown || this.stopsDuringSpawn.has(args.sessionId)) {
      try { await this.closeEntry(args.sessionId, { ...result, lastUsedAt: Date.now() }); }
      catch (error) { throw new SpawnRetirementFailure(error); }
      throw new Error(`Provider session stopped during spawn: ${args.sessionId}`);
    }
    if (this.deps.processes) {
      for (const pid of result.pids) {
        this.deps.processes.attach(pid, `mcode session ${args.sessionId}`);
      }
    } else if (this.deps.jobObject.isWindowsJob) {
      for (const pid of result.pids) {
        this.deps.jobObject.assign(pid);
        this.deps.jobObject.setDescription(pid, `mcode session ${args.sessionId}`);
      }
    }
    this.sessions.set(args.sessionId, { ...result, lastUsedAt: Date.now() });
    return result.state;
  }

  private ensureEvictionTimer(): void {
    if (this.evictionTimer) return;
    this.evictionTimer = setInterval(() => {
      void this.evictIdle().catch((error: unknown) => {
        this.deps.logger?.warn("SessionRuntime idle eviction failed", { error: errorMessage(error) });
      });
    }, EVICTION_INTERVAL_MS);
    this.evictionTimer.unref?.();
  }

  private async evictIdle(): Promise<void> {
    const now = Date.now();
    const sessions = Array.from(this.sessions);
    for (const [sessionId, entry] of sessions) {
      if (this.sessions.get(sessionId) === entry && now - entry.lastUsedAt > this.idleTtlMs && !this.adapter.isBusy(entry.state)) {
        this.deps.logger?.info("SessionRuntime evicting idle session", { sessionId });
        await this.stop(sessionId);
      }
    }
  }

  private async closeEntry(sessionId: string, entry: PoolEntry<TState>): Promise<void> {
    const interrupt = Promise.resolve().then(() => this.adapter.interrupt(entry.state)).catch((error: unknown) => {
      this.deps.logger?.warn("SessionRuntime interrupt failed", { sessionId, error: errorMessage(error) });
    });
    if (!await settlesWithin(interrupt, GRACEFUL_STOP_TIMEOUT_MS)) {
      this.deps.logger?.info("SessionRuntime interrupt grace expired; closing session", { sessionId });
    }
    const close = Promise.resolve().then(() => this.adapter.close(entry.state)).catch((error: unknown) => {
      this.deps.logger?.warn("SessionRuntime close failed", { sessionId, error: errorMessage(error) });
      throw error;
    });
    if (!await settlesWithin(close.then(() => undefined, () => undefined), GRACEFUL_STOP_TIMEOUT_MS)) {
      this.deps.logger?.info("SessionRuntime close grace expired; terminating owned processes", { sessionId });
    }
    const results = await Promise.allSettled([close, this.hardKill(entry.pids)]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  private async hardKill(pids: number[]): Promise<void> {
    if (this.deps.processes) {
      const results = await Promise.allSettled(pids.map((pid) => this.deps.processes!.terminateTree(pid)));
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length > 0) throw new AggregateError(failures, "Provider process retirement failed");
      return;
    }
    await Promise.all(pids.map((pid) => new Promise<void>((resolve) => {
      if (this.deps.jobObject.isWindowsJob) {
        NodeChildProcess.execFile("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true }, (error) => {
          if (error) this.deps.logger?.debug("taskkill failed (process may have exited)", { pid, error: errorMessage(error) });
          resolve();
        });
        return;
      }
      try {
        process.kill(pid);
      } catch (error) {
        this.deps.logger?.debug("process.kill failed (process may have exited)", { pid, error: errorMessage(error) });
      }
      resolve();
    })));
  }
}

async function settlesWithin(operation: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try { return await Promise.race([operation.then(() => true), deadline]); }
  finally { clearTimeout(timer); }
}

async function waitForAcquisition<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    const result = await Promise.race([operation, cancelled]);
    signal.throwIfAborted();
    return result;
  } finally { signal.removeEventListener("abort", abort); }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
