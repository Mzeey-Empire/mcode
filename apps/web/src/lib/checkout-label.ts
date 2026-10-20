import type { Thread } from "@/transport";

/** True when the thread's checkout has no named branch, so its ref is a bare commit. */
export function isDetachedCheckout(thread: Pick<Thread, "branch" | "checkout_state">): boolean {
  return thread.checkout_state === "branchless" || thread.branch === "HEAD" || !thread.branch;
}

/**
 * Resolves the user-facing checkout label for a thread row or header control. A detached checkout
 * names the base it started from when one is known, because a bare "HEAD" says nothing about where
 * the work sits.
 */
export function resolveThreadCheckoutLabel(
  thread: Pick<Thread, "branch" | "checkout_state" | "base_branch"> | null | undefined,
): string {
  if (!thread) return "detached";
  if (!isDetachedCheckout(thread)) return thread.branch;
  return thread.base_branch ? `detached from ${thread.base_branch}` : "detached";
}
