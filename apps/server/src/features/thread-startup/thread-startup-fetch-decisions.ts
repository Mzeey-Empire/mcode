import type { ThreadStartup, ThreadStartupResolveInput } from "@mcode/contracts/thread-startup";

type FetchDecision = ThreadStartupResolveInput["action"] | "cancel";

/** A resolution cannot be delivered to an active blocked origin fetch. */
export class ThreadStartupResolveError extends Error {
  readonly code = "STARTUP_NOT_BLOCKED_ON_FETCH";

  constructor() {
    super("This startup is not waiting for an origin fetch decision.");
    this.name = "ThreadStartupResolveError";
  }
}

/** Shares only live origin-fetch waiters between creation and startup RPCs. */
export class ThreadStartupFetchDecisions {
  private readonly waiters = new Map<string, (decision: FetchDecision) => void>();

  /** Register before publishing the block so an immediate decision cannot be lost. */
  async wait(startupId: string, publishBlock: () => Promise<void>): Promise<FetchDecision> {
    if (this.waiters.has(startupId)) throw new ThreadStartupResolveError();
    const decision = new Promise<FetchDecision>((resolve) => this.waiters.set(startupId, resolve));
    try {
      await publishBlock();
      return await decision;
    } finally {
      this.waiters.delete(startupId);
    }
  }

  /** Deliver one user decision, rejecting stale, cancelled, or non-fetch requests. */
  resolve(startup: ThreadStartup | null, action: ThreadStartupResolveInput["action"]): ThreadStartup {
    if (!startup || startup.state !== "blocked" || startup.phase !== "fetch"
      || startup.cancellation === "requested" || startup.block?.code !== "start_from_origin_failed"
      || !startup.block.actions.includes(action) || !this.settle(startup.startupId, action)) {
      throw new ThreadStartupResolveError();
    }
    return startup;
  }

  /** Wake a blocked owner after cancellation intent commits. */
  cancel(startupId: string): void {
    this.settle(startupId, "cancel");
  }

  private settle(startupId: string, decision: FetchDecision): boolean {
    const resolve = this.waiters.get(startupId);
    if (!resolve) return false;
    this.waiters.delete(startupId);
    resolve(decision);
    return true;
  }
}
