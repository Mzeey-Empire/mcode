import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { delay, isProcessAlive, type ServerLock } from "./lock.js";

/**
 * Time to wait for another Electron instance to finish starting the server.
 * Must exceed the lock holder's own startup budget so an awaited local data
 * migration is never mistaken for a stuck startup.
 */
const STARTUP_LOCK_TIMEOUT_MS = 10 * 60_000 + 15_000;

/** Interval between lock-owned server probes while another instance starts it. */
const STARTUP_LOCK_POLL_INTERVAL_MS = 200;

/**
 * Grace period before reclaiming a sentinel with no readable owner file. A
 * healthy owner writes its owner file immediately after creating the sentinel
 * directory; several seconds without one means the writer died mid-creation.
 */
const STARTUP_LOCK_OWNERLESS_GRACE_MS = 5_000;

/** Unique ownership data for a server startup sentinel. */
export interface StartupLockOwner {
  pid: number;
  token: string;
}

/** Result of acquiring the inter-process server startup lock. */
export type StartupLockResult =
  | { kind: "acquired"; owner: StartupLockOwner }
  | { kind: "existing"; lock: ServerLock };

/** Dependencies for server startup-lock acquisition. */
export interface StartupLockDependencies {
  readonly createLock: () => StartupLockOwner | null;
  readonly releaseLock: (owner: StartupLockOwner) => void;
  readonly removeOwnerlessLock: () => void;
  readonly readLockOwner: () => StartupLockOwner | null;
  readonly isOwnerAlive: (pid: number) => boolean;
  readonly findExistingServer: () => Promise<ServerLock | null>;
  readonly wait: (timeoutMs: number) => Promise<void>;
  readonly now: () => number;
}

/** Create filesystem-backed startup-lock dependencies. */
export function createStartupLockDependencies(
  sentinelPath: string,
  findExistingServer: () => Promise<ServerLock | null>,
): StartupLockDependencies {
  return {
    createLock: () => tryCreateStartupLock(sentinelPath),
    releaseLock: (owner) => releaseStartupLock(sentinelPath, owner),
    removeOwnerlessLock: () => {
      try {
        NodeFS.rmSync(sentinelPath, { recursive: true, force: true });
      } catch {
        // A concurrent owner may still be writing; the next poll retries.
      }
    },
    readLockOwner: () => readStartupLockOwner(sentinelPath),
    isOwnerAlive: isProcessAlive,
    findExistingServer,
    wait: delay,
    now: Date.now,
  };
}

/** Wait for a lock-owned server, then reclaim an abandoned startup lock. */
export async function acquireStartupLock(
  dependencies: StartupLockDependencies,
  timeoutMs = STARTUP_LOCK_TIMEOUT_MS,
): Promise<StartupLockResult> {
  const owner = dependencies.createLock();
  if (owner) return { kind: "acquired", owner };
  console.log(
    "[server-manager] Startup lock held by another process, waiting for server",
  );
  return waitForStartupLock(dependencies, timeoutMs);
}

/**
 * Wait out a live owner's startup. A lock owner that stays alive may still be
 * mid-startup for several minutes, so keep polling until it publishes a
 * healthy server, releases the sentinel, or outlives the deadline.
 */
async function waitForStartupLock(
  dependencies: StartupLockDependencies,
  timeoutMs: number,
): Promise<StartupLockResult> {
  const deadline = dependencies.now() + timeoutMs;
  let ownerlessSince: number | null = null;
  for (;;) {
    const existing = await dependencies.findExistingServer();
    if (existing) return { kind: "existing", lock: existing };
    const owner = dependencies.readLockOwner();
    if (owner && !dependencies.isOwnerAlive(owner.pid)) {
      dependencies.releaseLock(owner);
    }
    const acquired = dependencies.createLock();
    if (acquired) return { kind: "acquired", owner: acquired };
    ownerlessSince = reclaimOwnerlessSentinel(dependencies, owner, ownerlessSince);
    if (dependencies.now() >= deadline) {
      if (owner && dependencies.isOwnerAlive(owner.pid)) {
        throw new Error(
          `Server startup lock owner ${owner.pid} is still running`,
        );
      }
      throw new Error("Server startup lock owner is unavailable after timeout");
    }
    await dependencies.wait(STARTUP_LOCK_POLL_INTERVAL_MS);
  }
}

/**
 * Track how long a blocking sentinel has named no owner and reclaim it once
 * the writer grace expires. A healthy owner writes its owner file immediately
 * after creating the sentinel, so a stable ownerless sentinel means the
 * writer died mid-creation. Returns the first-seen timestamp, or null when an
 * owner exists or a reclaim just ran.
 */
function reclaimOwnerlessSentinel(
  dependencies: StartupLockDependencies,
  owner: StartupLockOwner | null,
  ownerlessSince: number | null,
): number | null {
  if (owner) return null;
  const since = ownerlessSince ?? dependencies.now();
  if (dependencies.now() - since >= STARTUP_LOCK_OWNERLESS_GRACE_MS) {
    // Re-verify immediately before removal: a concurrent acquirer may have
    // written its owner file since our last poll.
    if (!dependencies.readLockOwner()) dependencies.removeOwnerlessLock();
    return null;
  }
  return since;
}

/** Remove only the startup sentinel file owned by the supplied token. */
export function releaseStartupLock(
  sentinelPath: string,
  owner: StartupLockOwner,
): void {
  try {
    NodeFS.unlinkSync(startupOwnerPath(sentinelPath, owner));
  } catch {
    return;
  }
  try {
    NodeFS.rmdirSync(sentinelPath);
  } catch {
    // A replacement owner creates its own token file before this owner releases.
  }
}

/** Try to create an owner-scoped startup sentinel without replacing another owner. */
function tryCreateStartupLock(sentinelPath: string): StartupLockOwner | null {
  const owner = { pid: process.pid, token: NodeCrypto.randomUUID() };
  try {
    NodeFS.mkdirSync(sentinelPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  try {
    NodeFS.writeFileSync(
      startupOwnerPath(sentinelPath, owner),
      JSON.stringify(owner),
      {
        flag: "wx",
      },
    );
  } catch (error) {
    removeEmptyStartupDirectory(sentinelPath);
    throw error;
  }
  // A stalled writer can land its owner file in this directory after a
  // reclaim removed the original sentinel; refuse to co-own a contested one.
  if (NodeFS.readdirSync(sentinelPath).length > 1) {
    try {
      NodeFS.unlinkSync(startupOwnerPath(sentinelPath, owner));
    } catch {
      // The directory may already be gone; the next poll re-evaluates it.
    }
    return null;
  }
  return owner;
}

/** Read the unique owner recorded in a startup sentinel directory. */
function readStartupLockOwner(sentinelPath: string): StartupLockOwner | null {
  try {
    const ownerFiles = NodeFS.readdirSync(sentinelPath);
    // More than one owner file means two writers raced; no single owner can
    // be trusted, so treat the sentinel as ownerless and let grace reclaim it.
    if (ownerFiles.length !== 1) return null;
    const owner: unknown = JSON.parse(
      NodeFS.readFileSync(NodePath.join(sentinelPath, ownerFiles[0]), "utf-8"),
    );
    return isStartupLockOwner(owner) ? owner : null;
  } catch {
    return null;
  }
}

/** Return whether a value has the expected startup sentinel ownership shape. */
function isStartupLockOwner(value: unknown): value is StartupLockOwner {
  if (!value || typeof value !== "object") return false;
  const owner = value as Partial<StartupLockOwner>;
  return (
    typeof owner.pid === "number" &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.token === "string" &&
    owner.token.length > 0
  );
}

/** Return the owner-scoped file path inside a startup sentinel directory. */
function startupOwnerPath(
  sentinelPath: string,
  owner: StartupLockOwner,
): string {
  return NodePath.join(sentinelPath, `${owner.token}.json`);
}

/** Remove a newly created empty sentinel directory after an owner-file write failure. */
function removeEmptyStartupDirectory(sentinelPath: string): void {
  try {
    NodeFS.rmdirSync(sentinelPath);
  } catch {
    // Another process cannot own this directory until this creator removes it.
  }
}

/** Find an available TCP port in a half-open range. */
export async function findAvailablePort(
  min: number,
  max: number,
): Promise<number> {
  for (let port = min; port < max; port += 1) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available port found in range ${min}-${max}`);
}

/** Ask the operating system whether a port is available for the server. */
async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = NodeNet.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as NodeNet.AddressInfo;
      server.close(() => resolve(address.port === port));
    });
  });
}
