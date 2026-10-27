import type { CanonicalAgentEventEnvelope } from "@mcode/contracts/compat/agent-model";

import { CodexCollaborationEventAdapter } from "../collaboration/adapters/codex-collaboration-event-adapter.js";
import type { CodexCollaborationDurability } from "../collaboration/codex-collaboration-durability.js";
import type { ProjectedCommittedProviderEvent } from "../execution/execution-worker-handler.js";
import { processProviderEventWorkerTask } from "../../providers/composition/provider-event-worker-protocol.js";
import type { ProviderEventProjection } from "../../providers/composition/provider-event-adapter.js";
import type { ProviderEventIngressEvent } from "../../providers/composition/provider-event-ingress.js";

/** Runs one Codex projection in a savepoint and retains only its complete effects. */
export type CommitCodexProjection = (project: () => ProviderEventProjection) => ProviderEventProjection;

/** Interprets committed runtime envelopes beside the SQLite connection that owns their effects. */
export class CanonicalCommittedProviderProjector {
  private readonly codex: CodexCollaborationEventAdapter;

  constructor(private readonly durability: CodexCollaborationDurability, private readonly commitCodex: CommitCodexProjection) {
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
      const interpretation = this.interpret(outcome.event);
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

  private interpret(input: ProviderEventIngressEvent): ProviderEventProjection {
    const extension = input.runtimeExtension;
    switch (extension?.kind) {
      case "codex-collaboration": return this.commitCodex(() => this.codex.project(input));
      case "child-thread": {
        if (extension.childThread.role === "delegate") return { status: "forward", event: input.event };
        const diagnostic = { threadId: input.event.threadId, executionId: input.event.turnExecutionId,
          parentItemId: `toolCall:${extension.childThread.path[0]}`, event: input.event,
          reason: "child-thread-requires-accepted-path" };
        this.durability.recordCodexChildRoutingDiagnostic(diagnostic);
        return { status: "rejected", diagnostic };
      }
      case undefined: return input.providerId === "codex"
        ? this.commitCodex(() => this.codex.project(input)) : { status: "forward", event: input.event };
      default: {
        const unhandled: never = extension;
        throw new Error(`Unsupported runtime extension: ${unhandled}`);
      }
    }
  }
}
