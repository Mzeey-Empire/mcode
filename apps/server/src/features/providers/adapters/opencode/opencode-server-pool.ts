import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import { logger } from "@mcode/shared";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { WindowsProcessScopeFactory, type WindowsProcessScopeResult } from "../../../../runtime/process/containment/windows-process-scope.js";

/** Isolation boundary: never share a server across working directories. */
export type OpenCodePoolKey = Readonly<{ binaryPath: string; cwd: string; hostname: string }>;

/** Stable text form of a pool key for map lookups. */
export function openCodePoolKeyText(key: OpenCodePoolKey): string {
  return `${key.binaryPath}\u0000${key.cwd}\u0000${key.hostname}`;
}

/** One pooled `serve` child with its reference count and liveness. */
export interface OpenCodePoolEntry {
  key: OpenCodePoolKey;
  port: number;
  baseUrl: string;
  pid: number | null;
  refs: number;
  lastUsedAt: number;
  ready: boolean;
}

/** Minimal child-process surface the pool needs for exit watching and kills. */
export interface OpenCodePoolProcess {
  pid?: number;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  off(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
  off(event: "error", listener: (error: Error) => void): void;
  kill(signal?: number | NodeJS.Signals): boolean;
}

/** Injectable pool seams: spawning, health, termination, ports, and time. */
export interface OpenCodeProcessScope {
  readonly ready: boolean;
  assign(pid: number): WindowsProcessScopeResult;
  reconcile(pid: number): Promise<WindowsProcessScopeResult>;
  terminate(exitCode?: number): WindowsProcessScopeResult;
  waitForEmpty(timeoutMs: number): Promise<WindowsProcessScopeResult>;
  close(): void;
}

export interface OpenCodePoolDeps {
  spawn(binaryPath: string, args: string[], cwd: string, env: Record<string, string>): OpenCodePoolProcess;
  waitForHealth(baseUrl: string, timeoutMs: number, signal: AbortSignal): Promise<void>;
  terminateTree(pid: number): Promise<void>;
  findFreePort(hostname: string): Promise<number>;
  now(): number;
  env(): Record<string, string>;
  createScope?(): OpenCodeProcessScope | null;
  waitForPortClosed?(hostname: string, port: number): Promise<void>;
}

interface OwnedServer {
  readonly entry: OpenCodePoolEntry;
  readonly child: OpenCodePoolProcess;
  readonly scope: OpenCodeProcessScope | null;
}

/** Idle time after the last release before an unreferenced server is closed. */
export const OPENCODE_POOL_IDLE_TTL_MS = 5 * 60 * 1_000;
/** Longest wait for a fresh serve to answer health before startup fails. */
export const OPENCODE_POOL_READY_TIMEOUT_MS = 20_000;
const OPENCODE_POOL_CLOSE_TIMEOUT_MS = 5_000;

async function defaultWaitForPortClosed(hostname: string, port: number): Promise<void> {
  const host = hostname === "0.0.0.0" ? "127.0.0.1" : hostname;
  const deadline = Date.now() + OPENCODE_POOL_CLOSE_TIMEOUT_MS;
  do {
    const closed = await new Promise<boolean>((resolve, reject) => {
      const socket = NodeNet.createConnection({ host, port });
      socket.setTimeout(250);
      socket.once("connect", () => { socket.destroy(); resolve(false); });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        socket.destroy();
        if (error.code === "ECONNREFUSED") resolve(true);
        else reject(error);
      });
      socket.once("timeout", () => {
        socket.destroy();
        reject(new Error(`Timed out checking OpenCode serve port ${port}`));
      });
    });
    if (closed) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`OpenCode serve port ${port} remained open after termination`);
}

async function defaultWaitForHealth(baseUrl: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = 100;
  for (;;) {
    if (signal.aborted) throw new Error("OpenCode serve startup aborted");
    try {
      const res = await fetch(`${baseUrl}/global/health`, { signal });
      if (res.ok) return;
    } catch {
      if (signal.aborted) throw new Error("OpenCode serve startup aborted");
      // Not ready yet; keep polling below the deadline.
    }
    if (Date.now() >= deadline) throw new Error(`OpenCode serve did not become ready at ${baseUrl}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("OpenCode serve startup aborted"));
      }, { once: true });
    });
    delay = Math.min(delay * 2, 1_000);
  }
}

async function defaultFindFreePort(hostname: string): Promise<number> {
  const host = hostname === "0.0.0.0" ? "127.0.0.1" : hostname;
  return new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * Pools one `opencode serve` child per binary, working directory, and
 * hostname. Tracks reference counts, closes idle entries after the TTL,
 * watches for unexpected exits, and proves process-tree termination on close.
 */
export class OpenCodeServerPool {
  private readonly servers = new Map<string, OwnedServer>();
  private readonly pending = new Map<string, Promise<OpenCodePoolEntry>>();
  private readonly starting = new Map<string, AbortController>();
  private readonly closing = new Map<string, Promise<void>>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(private readonly deps: OpenCodePoolDeps) {}

  static withDefaults(deps: Pick<OpenCodePoolDeps, "terminateTree"> & { platform: string } & Partial<Omit<OpenCodePoolDeps, "terminateTree">>): OpenCodeServerPool {
    const { platform, ...rest } = deps;
    return new OpenCodeServerPool({
      spawn: (binaryPath, args, cwd, env) => NodeChildProcess.spawn(binaryPath, args, {
        cwd,
        env: { ...env },
        stdio: "ignore",
        windowsHide: true,
        // On Windows the executable is a `.cmd` shim; only a shell resolves it.
        ...(platform === "win32" ? { shell: true } : {}),
      }),
      waitForHealth: defaultWaitForHealth,
      findFreePort: defaultFindFreePort,
      createScope: platform === "win32"
        ? () => new WindowsProcessScopeFactory({ platform: "win32", architecture: hostRuntime.architecture }).create()
        : () => null,
      waitForPortClosed: defaultWaitForPortClosed,
      now: () => Date.now(),
      env: () => ({ ...process.env }) as Record<string, string>,
      ...rest,
    });
  }

  get size(): number {
    return this.servers.size;
  }

  entryFor(key: OpenCodePoolKey): OpenCodePoolEntry | undefined {
    return this.servers.get(openCodePoolKeyText(key))?.entry;
  }

  /** Acquire (or spawn) the server for one working directory. Shares across threads. */
  async acquire(key: OpenCodePoolKey): Promise<OpenCodePoolEntry> {
    if (this.stopping) throw new Error("OpenCode serve pool is shutting down");
    this.ensureEvictionTimer();
    const text = openCodePoolKeyText(key);
    for (;;) {
      if (this.stopping) throw new Error("OpenCode serve pool is shutting down");
      const closing = this.closing.get(text);
      if (closing) {
        await closing;
        continue;
      }
      const inFlight = this.pending.get(text);
      if (inFlight) {
        await this.waitForStart(text, inFlight);
        continue;
      }
      const existing = this.servers.get(text)?.entry;
      if (existing) {
        existing.refs += 1;
        existing.lastUsedAt = this.deps.now();
        return existing;
      }
      const started = this.start(key);
      this.pending.set(text, started);
      await this.waitForStart(text, started);
    }
  }

  private async waitForStart(text: string, started: Promise<OpenCodePoolEntry>): Promise<void> {
    try {
      await started;
    } finally {
      if (this.pending.get(text) === started) this.pending.delete(text);
    }
  }

  /** Release one reference; the entry stays warm until the TTL or shutdown. */
  release(key: OpenCodePoolKey): void {
    const text = openCodePoolKeyText(key);
    const entry = this.servers.get(text)?.entry;
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    entry.lastUsedAt = this.deps.now();
  }

  /** Close one entry with proven tree termination, regardless of ref count. */
  async close(key: OpenCodePoolKey): Promise<void> {
    const text = openCodePoolKeyText(key);
    const existing = this.closing.get(text);
    if (existing) return existing;
    const closing = this.closeServer(text);
    this.closing.set(text, closing);
    try {
      await closing;
    } finally {
      this.closing.delete(text);
    }
  }

  private async closeServer(text: string): Promise<void> {
    const pending = this.pending.get(text);
    if (pending) await Promise.allSettled([pending]);
    const server = this.servers.get(text);
    if (!server) return;
    await this.terminateEntry(server);
    this.servers.delete(text);
  }

  /** Close idle (refs at zero past TTL) entries with proven termination. */
  async closeIdle(now = this.deps.now(), ttlMs = OPENCODE_POOL_IDLE_TTL_MS): Promise<string[]> {
    const closed: string[] = [];
    for (const [text, { entry }] of this.servers) {
      if (entry.refs > 0) continue;
      if (now - entry.lastUsedAt <= ttlMs) continue;
      await this.close(entry.key);
      closed.push(text);
    }
    return closed;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    for (const controller of this.starting.values()) controller.abort();
    this.shutdownPromise = this.finishShutdown().catch((error: unknown) => {
      this.shutdownPromise = null;
      throw error;
    });
    return this.shutdownPromise;
  }

  private async finishShutdown(): Promise<void> {
    await Promise.allSettled(this.pending.values());
    const closures = await Promise.allSettled([...this.servers.values()].map(({ entry }) => this.close(entry.key)));
    const failures = closures.filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, "OpenCode serve pool shutdown failed");
  }

  private async start(key: OpenCodePoolKey): Promise<OpenCodePoolEntry> {
    const port = await this.deps.findFreePort(key.hostname);
    if (this.stopping) throw new Error("OpenCode serve pool is shutting down");
    const baseUrl = `http://${key.hostname}:${port}`;
    const scope = this.createScope();
    const child = this.spawnChild(key, port, scope);
    logger.info("OpenCode serve spawn", { binaryPath: key.binaryPath, cwd: key.cwd, port });
    const text = openCodePoolKeyText(key);
    const entry: OpenCodePoolEntry = {
      key, port, baseUrl, pid: child.pid ?? null, refs: 0, lastUsedAt: this.deps.now(), ready: false,
    };
    const server: OwnedServer = { entry, child, scope };
    this.servers.set(text, server);
    const controller = new AbortController();
    this.starting.set(text, controller);
    const spawnFailure: { error: Error | null } = { error: null };
    const onSpawnError = (error: Error) => { spawnFailure.error = error; };
    child.on("error", onSpawnError);
    const onExit = () => {
      // The shell can exit before its server. Keep ownership until cleanup is proven.
      if (entry.ready && entry.refs === 0) {
        void this.close(key).catch((error: unknown) => logger.error("OpenCode serve exit cleanup failed", {
          port, error: error instanceof Error ? error.message : String(error),
        }));
      }
    };
    child.on("exit", onExit);
    const guard = setTimeout(() => controller.abort(), OPENCODE_POOL_READY_TIMEOUT_MS + 5_000);
    try {
      await this.establishScope(server);
      if (spawnFailure.error) throw new Error(`OpenCode serve failed to start: ${spawnFailure.error.message}`);
      await this.awaitServeReady(child, baseUrl, controller.signal);
    } catch (error) {
      child.off("exit", onExit);
      await this.cleanupFailedStart(text, server, error);
      throw error;
    } finally {
      clearTimeout(guard);
      this.starting.delete(text);
      child.off("error", onSpawnError);
    }
    if (this.stopping) {
      await this.terminateEntry(server);
      this.servers.delete(text);
      throw new Error("OpenCode serve pool is shutting down");
    }
    entry.ready = true;
    entry.lastUsedAt = this.deps.now();
    return entry;
  }

  private createScope(): OpenCodeProcessScope | null {
    const scope = this.deps.createScope?.() ?? null;
    if (scope && !scope.ready) {
      scope.close();
      throw new Error("OpenCode serve process scope unavailable");
    }
    return scope;
  }

  private spawnChild(key: OpenCodePoolKey, port: number, scope: OpenCodeProcessScope | null): OpenCodePoolProcess {
    try {
      return this.deps.spawn(key.binaryPath, ["serve", "--port", String(port), "--hostname", key.hostname], key.cwd, this.deps.env());
    } catch (error) {
      scope?.close();
      throw error;
    }
  }

  private async establishScope({ entry, scope }: OwnedServer): Promise<void> {
    if (!scope) return;
    if (entry.pid == null) throw new Error("OpenCode serve process PID unavailable");
    const assigned = scope.assign(entry.pid);
    if (!assigned.ok) throw new Error(`OpenCode serve process scope assignment failed: ${assigned.error}`);
    const reconciled = await scope.reconcile(entry.pid);
    if (!reconciled.ok) throw new Error(`OpenCode serve process scope reconciliation failed: ${reconciled.error}`);
  }

  private async cleanupFailedStart(text: string, server: OwnedServer, startupError: unknown): Promise<void> {
    try {
      await this.terminateEntry(server);
      this.servers.delete(text);
    } catch (cleanupError) {
      throw new AggregateError([startupError, cleanupError], "OpenCode serve startup and cleanup failed");
    }
  }

  /**
   * Wait for the serve health endpoint while also watching the child for an
   * early `error` (e.g. missing binary). Without the `error` listener a spawn
   * failure throws an unhandled event that crashes the server process.
   */
  private awaitServeReady(
    child: OpenCodePoolProcess,
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(new Error(`OpenCode serve failed to start: ${error.message}`));
      };
      child.on("error", onError);
      this.deps.waitForHealth(baseUrl, OPENCODE_POOL_READY_TIMEOUT_MS, signal).then(
        () => {
          child.off("error", onError);
          resolve();
        },
        (error: unknown) => {
          child.off("error", onError);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private async terminateEntry({ entry, child, scope }: OwnedServer): Promise<void> {
    if (scope) {
      await this.terminateScope(scope, entry, child);
    } else if (entry.pid != null) {
      await this.deps.terminateTree(entry.pid);
    } else if (!child.kill("SIGTERM")) {
      throw new Error("OpenCode serve child could not be terminated");
    }
    await this.deps.waitForPortClosed?.(entry.key.hostname, entry.port);
    scope?.close();
  }

  private async terminateScope(scope: OpenCodeProcessScope, entry: OpenCodePoolEntry, child: OpenCodePoolProcess): Promise<void> {
    const terminated = scope.terminate(0);
    if (!terminated.ok) {
      if (entry.pid != null) await this.deps.terminateTree(entry.pid);
      else if (!child.kill("SIGTERM")) throw new Error(terminated.error ?? "OpenCode serve scope termination failed");
      return;
    }
    const emptied = await scope.waitForEmpty(OPENCODE_POOL_CLOSE_TIMEOUT_MS);
    if (!emptied.ok) throw new Error(emptied.error ?? "OpenCode serve process scope remained non-empty");
  }

  private ensureEvictionTimer(): void {
    if (this.evictionTimer) return;
    this.evictionTimer = setInterval(() => {
      void this.closeIdle().catch((error: unknown) => logger.error("OpenCode serve idle cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
      }));
    }, 60_000);
    this.evictionTimer.unref?.();
  }
}
