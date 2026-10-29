import { injectable } from "tsyringe";
import type { ThreadCompletionResult } from "@mcode/contracts/ws/methods";

interface CompletionHold {
  timer: ReturnType<typeof setTimeout> | null;
  result: Promise<ThreadCompletionResult>;
  resolve: (result: ThreadCompletionResult) => void;
}

/** Owns cancellable completion delays without changing durable thread state. */
@injectable()
export class CompletionHolds {
  private readonly holds = new Map<string, CompletionHold>();

  /** Join an existing request or commit once its requested delay has elapsed. */
  complete(threadId: string, holdMs: number, commit: () => Promise<ThreadCompletionResult>): Promise<ThreadCompletionResult> {
    const existing = this.holds.get(threadId);
    if (existing) return existing.result;
    if (holdMs === 0) return commit();

    let resolve!: (result: ThreadCompletionResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<ThreadCompletionResult>((resolveResult, rejectResult) => {
      resolve = resolveResult;
      reject = rejectResult;
    });
    const hold: CompletionHold = { timer: null, result: promise, resolve };
    this.holds.set(threadId, hold);
    hold.timer = setTimeout(() => {
      hold.timer = null;
      commit().then(
        (result) => {
          this.holds.delete(threadId);
          resolve(result);
        },
        (error: unknown) => {
          this.holds.delete(threadId);
          reject(error);
        },
      );
    }, holdMs);
    return promise;
  }

  /** Cancel a waiting request; a commit already under its reservation must finish. */
  cancel(threadId: string): boolean {
    const hold = this.holds.get(threadId);
    if (!hold || hold.timer === null) return false;
    clearTimeout(hold.timer);
    this.holds.delete(threadId);
    hold.resolve({ ok: false, refusal: "cancelled" });
    return true;
  }

  /** Discard waiting requests when their server owner stops. */
  stop(): void {
    for (const threadId of this.holds.keys()) this.cancel(threadId);
  }
}
