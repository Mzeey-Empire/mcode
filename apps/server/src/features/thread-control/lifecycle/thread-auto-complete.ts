import { logger } from "@mcode/shared";
import { effectiveAutoCompleteOnMerge, type Thread } from "@mcode/contracts/models/thread";
import { threadAttentionNeedsUser, type ThreadAttention } from "@mcode/contracts/models/thread-attention";
import { pullRequestsSettledMerged } from "@mcode/contracts/models/thread-pull-request";
import type { ThreadRepo } from "../persistence/thread-repo.js";
import type { ThreadAttentionService } from "../attention/thread-attention-service.js";
import type { ThreadCompletionService } from "./thread-completion-service.js";
import type { PullRequestLinkFunnel } from "../../pull-requests/links/pull-request-link-funnel.js";
import type { SettingsService } from "../../settings/settings-service.js";
import { subscribeThreadActivity } from "../persistence/thread-activity.js";

/** Facts that can change whether a thread qualifies for automatic completion. */
export type AutoCompleteStateInput = Pick<Thread,
  "deleted_at" | "user_completed_at" | "auto_complete_on_merge" | "auto_complete_paused_at" | "pull_requests"
> & {
  attention: ThreadAttention | null;
  completeOnPrMerge: boolean;
};

/**
 * inactive: the thread is deleted or already closed.
 * off: automatic completion is disabled by the effective setting.
 * held: reopening holds automatic completion.
 * waiting-for-merge: the PR list is empty or has an unmerged PR.
 * waiting-for-user: attention is unknown or something needs the user.
 * ready: the thread can complete automatically.
 *
 * Held enters on reopen, by hand or by sending a message to a closed thread.
 * Its hold snapshot remembers the PRs linked when it began, or when first observed for an older build's hold.
 * It leaves only when a PR outside that set is linked
 * or a remembered PR changes state. Forgetting and re-linking the same PR keeps the hold.
 * Held is stored as auto_complete_paused_at, whose name stays because older builds share the database.
 */
export type AutoCompleteState = "inactive" | "off" | "held" | "waiting-for-merge" | "waiting-for-user" | "ready";

/** Explain the auto-complete state from the current durable facts. */
export function autoCompleteState(facts: AutoCompleteStateInput): AutoCompleteState {
  if (facts.deleted_at !== null || facts.user_completed_at !== null) return "inactive";
  if (!effectiveAutoCompleteOnMerge(facts, facts.completeOnPrMerge)) return "off";
  if (facts.auto_complete_paused_at !== null) return "held";
  if (!pullRequestsSettledMerged(facts.pull_requests)) return "waiting-for-merge";
  if (!facts.attention || threadAttentionNeedsUser(facts.attention)) return "waiting-for-user";
  return "ready";
}

/** Level-triggered completion from committed thread facts, with one flight per thread. */
export class ThreadAutoCompleteService {
  private readonly inFlight = new Set<string>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    private readonly threads: Pick<ThreadRepo, "findById" | "listAll" | "onAutoCompleteOverrideChanged">,
    private readonly attention: Pick<ThreadAttentionService, "get" | "onPublished">,
    private readonly completion: Pick<ThreadCompletionService, "complete">,
    private readonly funnel: Pick<PullRequestLinkFunnel, "onChanged">,
    private readonly settings: Pick<SettingsService, "get" | "on">,
  ) {}

  /** Connect every decision input and reconcile already-merged threads on startup. */
  start(): void {
    if (this.unsubscribers.length > 0) return;
    const hint = (threadId: string) => {
      void this.evaluate(threadId).catch((error: unknown) => {
        logger.error("Thread auto-completion failed", { threadId, error: error instanceof Error ? error.message : String(error) });
      });
    };
    let enabled = this.settings.get().thread.completion.completeOnPrMerge;
    const sweep = () => {
      for (const thread of this.threads.listAll()) hint(thread.id);
    };
    this.unsubscribers.push(
      this.attention.onPublished(hint),
      this.threads.onAutoCompleteOverrideChanged(hint),
      this.funnel.onChanged(hint),
      // Retry refused completion even when activity leaves the deduplicated attention value unchanged.
      subscribeThreadActivity(hint),
      this.settings.on("change", (next) => {
        const nextEnabled = next.thread.completion.completeOnPrMerge;
        if (!enabled && nextEnabled) sweep();
        enabled = nextEnabled;
      }),
    );
    sweep();
  }

  /** Re-read current facts; completion refusals wait for the next hint without a timer. */
  async evaluate(threadId: string): Promise<void> {
    if (this.inFlight.has(threadId)) return;
    const thread = this.threads.findById(threadId);
    if (!thread) return;
    const state = autoCompleteState({
      ...thread,
      attention: this.attention.get(threadId),
      completeOnPrMerge: this.settings.get().thread.completion.completeOnPrMerge,
    });
    if (state !== "ready") return;
    this.inFlight.add(threadId);
    try {
      await this.completion.complete(threadId, 0, "auto");
    } finally {
      this.inFlight.delete(threadId);
    }
  }

  /** Stop receiving hints during server shutdown. */
  dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }
}
