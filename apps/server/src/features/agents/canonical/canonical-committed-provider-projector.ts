import type { CanonicalAgentEventEnvelope } from "@mcode/contracts";

import { CodexCollaborationEventAdapter } from "../collaboration/adapters/codex-collaboration-event-adapter.js";
import type { CodexCollaborationDurability } from "../collaboration/codex-collaboration-durability.js";
import type { ProjectedCommittedProviderEvent } from "../execution/execution-worker-handler.js";
import { processProviderEventWorkerTask } from "../../providers/composition/provider-event-worker-protocol.js";

/** Interprets committed runtime envelopes beside the SQLite connection that owns their effects. */
export class CanonicalCommittedProviderProjector {
  private readonly codex: CodexCollaborationEventAdapter;

  constructor(durability: CodexCollaborationDurability) {
    this.codex = new CodexCollaborationEventAdapter(durability);
  }

  /** Return cloneable, provider-neutral deliveries after any Codex child writes have committed. */
  project(envelopes: readonly CanonicalAgentEventEnvelope[]): ProjectedCommittedProviderEvent[] {
    const projected: ProjectedCommittedProviderEvent[] = [];
    for (const envelope of envelopes) {
      if (envelope.payload.type !== "item.recorded"
        || envelope.payload.item.payload.projection !== "providerRuntimeEvent") continue;
      const outcome = processProviderEventWorkerTask({ kind: "canonical-commit", envelope });
      if (outcome.status !== "accepted" || !outcome.event.canonicalReceipt) {
        throw new Error(`Committed provider envelope cannot be interpreted: ${envelope.eventId}`);
      }
      const interpretation = outcome.event.providerId === "codex"
        ? this.codex.project(outcome.event)
        : { status: "forward" as const, event: outcome.event.event };
      if (interpretation.status !== "forward") continue;
      projected.push({
        providerId: outcome.event.providerId,
        sourceKind: "canonical-commit",
        event: interpretation.event,
        canonicalReceipt: outcome.event.canonicalReceipt,
      });
    }
    return projected;
  }
}
