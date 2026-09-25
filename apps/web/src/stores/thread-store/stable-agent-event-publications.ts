import type { AgentEvent } from "@mcode/contracts";

const STORAGE_PREFIX = "mcode-agent-publication-v2:";
const MAX_SEQUENCE_BYTES = 16;

type PublicationStorage = Pick<Storage, "getItem" | "setItem">;

function publicationSequence(value: string): number | null {
  if (value.length > MAX_SEQUENCE_BYTES || !/^[1-9]\d*$/.test(value)) return null;
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

/** Retains one per-thread cursor across server epochs, executions, and browser reloads. */
export class StableAgentEventPublications {
  constructor(private readonly storage: () => PublicationStorage | undefined) {}

  /** Reserve a publication before applying its UI effects. A storage failure fails closed. */
  accept(event: AgentEvent): boolean {
    if (!event.publicationId) return true;
    if (!event.turnExecutionId || publicationSequence(event.publicationId) === null) return false;
    try {
      return this.reserve(event.threadId, event.publicationId);
    } catch {
      return false;
    }
  }

  private reserve(threadId: string, publicationId: string): boolean {
    const store = this.storage();
    if (!store) return false;
    const key = `${STORAGE_PREFIX}${threadId}`;
    const stored = store.getItem(key);
    const previous = stored === null ? 0 : publicationSequence(stored);
    if (previous === null || Number(publicationId) <= previous) return false;
    store.setItem(key, publicationId);
    return true;
  }
}

/** Browser-tab cursor with constant retained bytes per thread. */
export const stableAgentEventPublications = new StableAgentEventPublications(
  () => typeof sessionStorage === "undefined" ? undefined : sessionStorage,
);
