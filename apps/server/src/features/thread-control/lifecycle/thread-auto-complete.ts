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
export type AutoCompleteDecisionInput = Pick<Thread,
  "deleted_at" | "user_completed_at" | "auto_complete_on_merge" | "auto_complete_paused_at" | "pull_requests"
> & {
  attention: ThreadAttention | null;
  completeOnPrMerge: boolean;
};

/** Explain whether the current durable facts permit automatic completion. */
export function autoCompleteDecision(facts: AutoCompleteDecisionInput):
  "complete" | "inactive" | "disabled" | "paused" | "pull-requests" | "needs-user" {
  if (facts.deleted_at !== null || facts.user_completed_at !== null) return "inactive";
  if (!effectiveAutoCompleteOnMerge(facts, facts.completeOnPrMerge)) return "disabled";
  if (facts.auto_complete_paused_at !== null) return "paused";
  if (!pullRequestsSettledMerged(facts.pull_requests)) return "pull-requests";
  if (!facts.attention || threadAttentionNeedsUser(facts.attention)) return "needs-user";
  return "complete";
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
    const decision = autoCompleteDecision({
      ...thread,
      attention: this.attention.get(threadId),
      completeOnPrMerge: this.settings.get().thread.completion.completeOnPrMerge,
    });
    if (decision !== "complete") return;
    this.inFlight.add(threadId);
    try {
      await this.completion.complete(threadId);
    } finally {
      this.inFlight.delete(threadId);
    }
  }

  /** Stop receiving hints during server shutdown. */
  dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }
}
