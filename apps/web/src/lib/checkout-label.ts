import type { Thread } from "@/transport";

/** True when the thread's checkout has no named branch, so its ref is a bare commit. */
export function isDetachedCheckout(thread: Pick<Thread, "branch" | "checkout_state">): boolean {
  return thread.checkout_state === "branchless" || thread.branch === "HEAD" || !thread.branch;
}

/**
 * Resolves the user-facing checkout label for a thread row or header control. A detached checkout
 * names its commit when the hash is known, because two detached threads on the same base are only
 * told apart by where their HEAD sits. Without a hash it falls back to the base it started from.
 */
export function resolveThreadCheckoutLabel(
  thread: Pick<Thread, "branch" | "checkout_state" | "base_branch" | "head_sha"> | null | undefined,
): string {
  if (!thread) return "detached";
  if (!isDetachedCheckout(thread)) return thread.branch;
  if (thread.head_sha) return `detached at ${thread.head_sha}`;
  return thread.base_branch ? `detached from ${thread.base_branch}` : "detached";
}
