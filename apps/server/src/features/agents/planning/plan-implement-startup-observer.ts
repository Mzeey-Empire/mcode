import { logger } from "@mcode/shared";
import type { ThreadStartupService } from "../../thread-startup/thread-startup-service.js";
import { subscribeCommittedCanonicalEvents } from "../canonical/committed-canonical-events.js";
import type { PlanService } from "./plan-service.js";

/** Settles Implement requests held by Setup after admission or terminal startup facts. */
export class PlanImplementStartupObserver {
  private subscriptions: (() => void)[] = [];
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly plans: Pick<PlanService, "settleStartup">,
    private readonly startups: Pick<ThreadStartupService, "subscribe" | "findByThreadId">) {}

  /** Begin observing durable facts once. */
  start(): void {
    if (this.subscriptions.length) return;
    this.subscriptions = [
      this.startups.subscribe(startup => {
        if (["completed", "cancelled", "failed", "interrupted"].includes(startup.state)) this.settle(startup.startupId);
      }),
      subscribeCommittedCanonicalEvents(events => {
        for (const event of events) {
          if (event.payload.type !== "turn.started") continue;
          const startup = this.startups.findByThreadId(event.routing.threadId);
          if (startup) this.settle(startup.startupId);
        }
      }),
    ];
  }

  /** Stop subscriptions and drain already observed transitions before writer shutdown. */
  async stop(): Promise<void> {
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions = [];
    await Promise.all(this.pending);
  }

  private settle(startupId: string): void {
    const operation = this.plans.settleStartup(startupId).catch((error: unknown) => {
      logger.error("Plan Implement startup settlement failed", { startupId, error });
    });
    this.pending.add(operation);
    void operation.then(() => { this.pending.delete(operation); });
  }
}
