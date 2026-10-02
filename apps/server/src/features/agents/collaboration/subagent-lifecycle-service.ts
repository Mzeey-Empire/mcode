import { inject, injectable } from "tsyringe";
import {
  CanonicalSubagentRosterSchema,
  isChildTurnCancellable,
  type CanonicalSubagentRoster,
  type CanonicalSubagentRosterRequest,
  type CanonicalSubagentStopRequest,
  type CanonicalSubagentStopResult,
  type IAgentProvider,
  type IProviderRegistry,
  type ProviderId,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import {
  SUBAGENT_LIFECYCLE_DURABILITY,
  type SubagentLifecycleDurability,
  type SubagentStopTarget,
} from "./subagent-lifecycle-durability.js";

type AcceptedSubagentProgress = Pick<import("../canonical/canonical-accepted-progress.js").CanonicalAcceptedProgress,
  "loadSubagentRoster" | "loadSubagentStopTarget" | "loadActiveSubagentStopTargets" | "finishSubagentTurn" | "interruptSubagentTurns">;

/** Owns server-authoritative sub-agent rosters and independent cancellation. */
@injectable()
export class SubagentLifecycleService {
  private readonly activeStops = new Map<string, Promise<CanonicalSubagentStopResult>>();
  private acceptedProgress: AcceptedSubagentProgress | undefined;

  constructor(
    @inject(SUBAGENT_LIFECYCLE_DURABILITY)
    private readonly durability: SubagentLifecycleDurability,
    @inject("IProviderRegistry") private readonly providers: IProviderRegistry,
  ) {}

  /** Resolve controls through retained family identities before their saved rows exist. */
  bindAcceptedProgress(progress: AcceptedSubagentProgress): void {
    this.acceptedProgress = progress;
  }

  /** Load a roster with cancellation availability derived from the active provider. */
  loadRoster(request: CanonicalSubagentRosterRequest): CanonicalSubagentRoster {
    const roster = this.acceptedProgress?.loadSubagentRoster(request) ?? this.durability.loadSubagentRoster(request);
    return CanonicalSubagentRosterSchema().parse({
      ...roster,
      active: roster.active.map((entry) => this.withStopAvailability(request.owningParentThreadId, entry)),
    });
  }

  /** Stop one owned sub-agent turn without stopping its provider session. */
  async stop(request: CanonicalSubagentStopRequest): Promise<CanonicalSubagentStopResult> {
    const key = `${request.owningParentThreadId}:${request.childThreadId}`;
    const existing = this.activeStops.get(key);
    if (existing) return existing;
    const operation = this.stopOne(request);
    this.activeStops.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.activeStops.get(key) === operation) this.activeStops.delete(key);
    }
  }

  /** Stop every active descendant before its parent terminalizes. */
  async stopDescendants(owningParentThreadId: string): Promise<void> {
    const targets = (this.acceptedProgress?.loadActiveSubagentStopTargets(owningParentThreadId)
      ?? this.durability.loadActiveSubagentStopTargets(owningParentThreadId))
      .filter((target) => target.latestTurn?.status === "Running");
    await Promise.allSettled(targets.map((target) => this.stop({
      owningParentThreadId,
      childThreadId: target.childThread.id,
    })));
    const ids = targets.map((target) => target.childThread.id);
    if (!this.acceptedProgress?.interruptSubagentTurns(ids, "Interrupted by parent stop")) {
      await this.durability.interruptSubagentTurns(ids, "Interrupted by parent stop");
    }
  }

  private withStopAvailability(
    owningParentThreadId: string,
    row: CanonicalSubagentRoster["active"][number],
  ): CanonicalSubagentRoster["active"][number] {
    const target = this.loadStopTarget({
      owningParentThreadId,
      childThreadId: row.id,
    });
    if (!this.canAddress(target)) return row;
    try {
      return isChildTurnCancellable(this.providers.resolve(target.childThread.providerId as ProviderId))
        ? { ...row, canStop: true }
        : row;
    } catch {
      return row;
    }
  }

  private async stopOne(request: CanonicalSubagentStopRequest): Promise<CanonicalSubagentStopResult> {
    const target = this.loadStopTarget(request);
    if (!target) return this.failed(request.childThreadId, "The selected sub-agent does not belong to this thread.");
    if (target.latestTurn?.status !== "Running") {
      return { childThreadId: request.childThreadId, status: "already-terminal" };
    }
    if (!this.canAddress(target)) {
      return { childThreadId: request.childThreadId, status: "unsupported", message: "The active sub-agent has no exact provider identity." };
    }
    const provider = this.resolveProvider(target, request.childThreadId);
    if (!provider || !isChildTurnCancellable(provider)) {
      return { childThreadId: request.childThreadId, status: "unsupported", message: "The sub-agent provider cannot cancel this turn independently." };
    }
    try {
      await provider.interruptChildTurn(
        `mcode-${request.owningParentThreadId}`,
        target.nativeThreadId,
        target.nativeTurnId,
      );
    } catch {
      logger.warn("Sub-agent interruption failed", {
        category: "provider-interrupt-failed",
        owningParentThreadId: request.owningParentThreadId,
        childThreadId: request.childThreadId,
        providerId: target.childThread.providerId,
      });
      return this.failed(request.childThreadId, "Sub-agent interruption failed.");
    }
    const input = {
      childThreadId: request.childThreadId,
      nativeTurnId: target.nativeTurnId,
      outcome: "interrupted" as const,
      error: "Interrupted by user",
    };
    const finished = await this.finishStop(input);
    return {
      childThreadId: request.childThreadId,
      status: finished.status === "Interrupted" ? "interrupted" : "already-terminal",
    };
  }

  private async finishStop(input: Parameters<SubagentLifecycleDurability["finishSubagentTurn"]>[0]): Promise<{ status: string }> {
    return this.acceptedProgress?.finishSubagentTurn(input) ?? this.durability.finishSubagentTurn(input);
  }

  private loadStopTarget(request: CanonicalSubagentStopRequest): SubagentStopTarget | null {
    const accepted = this.acceptedProgress?.loadSubagentStopTarget(request);
    return accepted === undefined ? this.durability.loadSubagentStopTarget(request) : accepted;
  }

  private canAddress(target: SubagentStopTarget | null): target is SubagentStopTarget & {
    nativeThreadId: string;
    nativeTurnId: string;
  } {
    return target !== null && target.nativeThreadId !== null && target.nativeTurnId !== null;
  }

  private resolveProvider(target: SubagentStopTarget, childThreadId: string): IAgentProvider | null {
    try {
      return this.providers.resolve(target.childThread.providerId as ProviderId);
    } catch {
      logger.debug("Sub-agent provider unavailable", { childThreadId, providerId: target.childThread.providerId });
      return null;
    }
  }

  private failed(childThreadId: string, message: string): CanonicalSubagentStopResult {
    return { childThreadId, status: "failed", message };
  }
}
