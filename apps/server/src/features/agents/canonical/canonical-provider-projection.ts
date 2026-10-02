import type { Database } from "bun:sqlite";
import { AgentEventSchema, CanonicalAgentEventEnvelopeSchema, ProviderIdSchema, type CanonicalAgentEventEnvelope } from "@mcode/contracts";
import { z } from "zod";
import type { ProviderEventProjection } from "../../providers/composition/provider-event-adapter.js";
import { CanonicalAgentStore } from "./canonical-agent-store.js";
import { CanonicalCommittedProviderProjector } from "./canonical-committed-provider-projector.js";
import type { CanonicalProviderWriteInput } from "./canonical-agent-writer-protocol.js";

const MAX_PUBLICATIONS = 2_048;
const MAX_PROJECTION_BYTES = 16 * 1024 * 1024;

/** Provider-neutral event retained in a receipt after transaction-local interpretation. */
export const ProjectedProviderEventSchema = z.object({
  providerId: ProviderIdSchema,
  sourceKind: z.literal("canonical-commit"),
  event: AgentEventSchema(),
  deliveryAttempt: z.number().int().positive().optional(),
  canonicalReceipt: z.object({
    eventId: z.string(), sourceSequence: z.number().int().optional(),
    acceptedSequence: z.number().int(), durableRevision: z.number().int(),
    serverTimestamps: z.object({ acceptedAt: z.string(), persistedAt: z.string().optional() }),
  }),
});

/** Bounded committed deliveries and publications, replayed without repeating child writes. */
export const CanonicalProviderProjectionSchema = z.object({
  events: z.array(ProjectedProviderEventSchema).max(MAX_PUBLICATIONS),
  publications: z.array(CanonicalAgentEventEnvelopeSchema).max(MAX_PUBLICATIONS),
});

/** Compact publication references include the child execution that owns each saved event. */
export const StoredCanonicalProviderProjectionSchema = z.object({
  events: z.array(ProjectedProviderEventSchema).max(MAX_PUBLICATIONS),
  publications: z.array(z.object({ executionId: z.string(), eventId: z.string() })).max(MAX_PUBLICATIONS),
});

/** Cloneable receipt data for a legacy provider batch interpreted in the database worker. */
export type CanonicalProviderProjection = z.infer<typeof CanonicalProviderProjectionSchema>;

class RejectedProjection extends Error {
  constructor(readonly diagnostic: Extract<ProviderEventProjection, { status: "rejected" }>["diagnostic"]) {
    super("Codex projection rejected");
  }
}

/** Keeps raw provider events, child mutations and their publication receipt in one transaction. */
export class CanonicalProviderCommitProjector {
  readonly canonical: CanonicalAgentStore;
  private readonly projector: CanonicalCommittedProviderProjector;
  private pending: { events: CanonicalAgentEventEnvelope[]; overflow: boolean } | undefined;

  constructor(private readonly db: Database) {
    this.canonical = new CanonicalAgentStore(db, (events) => {
      if (!this.pending) return;
      if (this.pending.events.length + events.length > MAX_PUBLICATIONS) {
        this.pending.overflow = true;
        return;
      }
      this.pending.events.push(...events);
    });
    this.projector = new CanonicalCommittedProviderProjector(this.canonical, (project) => this.commitCodex(project));
  }

  /** Called inside the receipt transaction; no publication leaves the worker before commit. */
  commit(input: CanonicalProviderWriteInput) {
    if (this.pending) throw new Error("Provider projection is already active");
    this.pending = { events: [], overflow: false };
    try {
      const result = this.canonical.commit(input);
      const events = this.projector.project(result.events);
      if (this.pending.overflow) throw new Error("Provider publication capacity reached");
      const providerProjection = CanonicalProviderProjectionSchema.parse({ events, publications: this.pending.events });
      if (Buffer.byteLength(JSON.stringify(providerProjection), "utf8") > MAX_PROJECTION_BYTES) {
        throw new Error("Provider projection receipt byte capacity reached");
      }
      return { ...result, providerProjection };
    } finally {
      this.pending = undefined;
    }
  }

  private commitCodex(project: () => ProviderEventProjection): ProviderEventProjection {
    const pending = this.pending;
    if (!pending) throw new Error("Provider projection has no active transaction");
    const count = pending.events.length;
    const overflow = pending.overflow;
    try {
      return this.db.transaction(() => {
        const result = project();
        if (result.status === "rejected") throw new RejectedProjection(result.diagnostic);
        return result;
      })();
    } catch (error) {
      pending.events.length = count;
      pending.overflow = overflow;
      if (!(error instanceof RejectedProjection)) throw error;
      this.canonical.recordCodexChildRoutingDiagnostic(error.diagnostic);
      return { status: "rejected", diagnostic: error.diagnostic };
    }
  }
}
