import type { AgentEvent } from "@mcode/contracts";

const STORAGE_PREFIX = "mcode-agent-publication-v2:";
const MAX_SEQUENCE_BYTES = 16;

type PublicationStorage = Pick<Storage, "getItem" | "setItem">;

function publicationSequence(value: string): number | null {
  if (value.length > MAX_SEQUENCE_BYTES || !/^[1-9]\d*$/.test(value)) return null;
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

/** Retains a per-thread cursor, surviving reloads when storage writes succeed. */
export class StableAgentEventPublications {
  private readonly pendingWrites = new Map<string, number>();
  private warnedAboutWriteFailure = false;

  constructor(private readonly storage: () => PublicationStorage | undefined) {}

  /** Reserve a publication before applying its UI effects, retaining failed writes in memory. */
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
    const previous = this.pendingWrites.get(threadId) ?? this.readCursor(threadId);
    if (previous === null || Number(publicationId) <= previous) return false;
    this.pendingWrites.set(threadId, Number(publicationId));
    this.persistCursor(threadId, publicationId);
    return true;
  }

  private readCursor(threadId: string): number | null {
    const store = this.storage();
    if (!store) return null;
    const stored = store.getItem(`${STORAGE_PREFIX}${threadId}`);
    return stored === null ? 0 : publicationSequence(stored);
  }

  private persistCursor(threadId: string, publicationId: string): void {
    try {
      const store = this.storage();
      if (!store) throw new Error("Publication cursor storage is unavailable");
      store.setItem(`${STORAGE_PREFIX}${threadId}`, publicationId);
      this.pendingWrites.delete(threadId);
    } catch {
      if (this.warnedAboutWriteFailure) return;
      this.warnedAboutWriteFailure = true;
      console.warn("Live event cursor could not be saved. Duplicate protection remains active in this renderer; reload recovery may replay older events.");
    }
  }
}

/** Browser-tab cursor with constant retained bytes per thread. */
export const stableAgentEventPublications = new StableAgentEventPublications(
  () => typeof sessionStorage === "undefined" ? undefined : sessionStorage,
);
