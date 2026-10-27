import type { AgentEvent } from "@mcode/contracts/events/agent-event";
import type { ProviderFileMutationStart, ProviderTurnDiffUpdate } from "@mcode/contracts/providers/interfaces";
import type { TurnDiffService } from "./turn-diff-service.js";

import type {
  ProviderEventIngressConsumer,
  ProviderEventIngressEvent,
} from "../../providers/composition/provider-event-ingress.js";

/** Runtime authority retained by AgentService while the pipeline owns event ordering. */
export interface TurnLifecycleControl {
  /** Normalize an event against the authoritative turn attempt. */
  normalize(event: AgentEvent): AgentEvent | undefined;
}

/** Applies one ordered event to the existing focused turn collaborators. */
export interface TurnEventApplication {
  /** Publish an event whose complete semantic work already committed on the execution writer. */
  publishCommitted(event: AgentEvent): void;
}

/** Claims every worker-owned file callback, including one rejected by its attempt fence. */
export interface WorkerFileObservationPort {
  ownsFileMutation(event: ProviderFileMutationStart): boolean;
  capture(event: ProviderFileMutationStart): boolean;
}

/** Publishes committed worker output and captures private provider file evidence. */
export class TurnEventPipeline implements ProviderEventIngressConsumer {
  constructor(
    private readonly lifecycle: TurnLifecycleControl,
    private readonly application: TurnEventApplication,
    private readonly turnDiffs?: Pick<TurnDiffService, "push">,
    private readonly workerFileObserver?: WorkerFileObservationPort,
  ) {}

  /** Publish committed worker output without passing it through legacy persistence. */
  handleProjectedCommitted(input: ProviderEventIngressEvent): void {
    const event = this.lifecycle.normalize(input.event);
    if (event) this.application.publishCommitted(event);
  }

  /** Observe one provider file mutation before public event attribution is available. */
  handleProviderFileMutation(event: ProviderFileMutationStart): void {
    if (this.workerFileObserver?.ownsFileMutation(event)) {
      this.workerFileObserver.capture(event);
    }
  }

  /** Forward non-renderer native evidence through the dedicated bounded source. */
  handleProviderTurnDiff(event: ProviderTurnDiffUpdate): void {
    this.turnDiffs?.push(event);
  }
}
