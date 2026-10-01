import type { AgentEvent } from "@mcode/contracts";

const STORAGE_PREFIX = "mcode-agent-publication-v2:";
const MAX_SEQUENCE_BYTES = 16;

type PublicationStorage = Pick<Storage, "getItem" | "setItem">;
/** Identity assigned by the accepted canonical stream, independent of legacy publication numbers. */
export interface CanonicalPublicationIdentity { epoch: string; eventId: string; ownerThreadId?: string }

function legacyIdentity(event: AgentEvent, epoch: string): string {
  return `legacy:${epoch}:${event.turnExecutionId ?? ""}:${event.publicationId ?? ""}`;
}

function publicationSequence(value: string): number | null {
  if (value.length > MAX_SEQUENCE_BYTES || !/^[1-9]\d*$/.test(value)) return null;
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

/** Retains a per-thread cursor, surviving reloads when storage writes succeed. */
export class StableAgentEventPublications {
  private readonly pendingWrites = new Map<string, number>();
  private readonly observed = new Map<string, Set<string>>();
  private warnedAboutWriteFailure = false;

  constructor(private readonly storage: () => PublicationStorage | undefined) {}

  /** Reserve a publication before applying its UI effects, retaining failed writes in memory. */
  accept(event: AgentEvent, canonicalEpoch?: string): boolean {
    if (!event.publicationId) return true;
    // Synthesized publications belong to no execution; the thread-scoped sequence is the dedup key.
    if (publicationSequence(event.publicationId) === null) return false;
    try {
      const accepted = this.reserve(event.threadId, event.publicationId);
      if (accepted && canonicalEpoch) this.remember(event.threadId, legacyIdentity(event, canonicalEpoch));
      return accepted;
    } catch {
      return false;
    }
  }

  /** Canonical ordering already rejects gaps; an unseen repaired publication may precede a legacy cursor. */
  acceptCanonical(event: AgentEvent, identity: CanonicalPublicationIdentity): boolean {
    if (!event.publicationId) return true;
    if (publicationSequence(event.publicationId) === null) return false;
    const key = JSON.stringify([identity.epoch, identity.eventId]);
    const ownerThreadId = identity.ownerThreadId ?? event.threadId;
    const seen = this.observed.get(ownerThreadId);
    if (seen?.has(key) || this.observed.get(event.threadId)?.has(legacyIdentity(event, identity.epoch))) return false;
    this.remember(ownerThreadId, key);
    this.persistCanonicalCursor(event.threadId, event.publicationId);
    return true;
  }

  private persistCanonicalCursor(threadId: string, publicationId: string): void {
    let previous = this.pendingWrites.get(threadId) ?? 0;
    try { previous = Math.max(previous, this.readCursor(threadId) ?? 0); }
    catch (error) { console.warn("Legacy publication cursor could not be read; canonical progress remains ordered.", error); }
    this.persistCursor(threadId, String(Math.max(previous, Number(publicationId))));
  }

  /** Release observations unless a remaining alias retains their stream owner. */
  forgetThread(threadId: string, retainedOwners?: ReadonlySet<string>): void {
    if (!retainedOwners?.has(threadId)) this.observed.delete(threadId);
    this.pendingWrites.delete(threadId);
  }

  /** Clear renderer-local publication observations when resetting an isolated test store. */
  reset(): void {
    this.observed.clear();
    this.pendingWrites.clear();
  }

  private remember(threadId: string, publicationId: string): void {
    const seen = this.observed.get(threadId) ?? new Set<string>();
    seen.add(publicationId);
    if (seen.size > 8_192) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    this.observed.set(threadId, seen);
    if (this.observed.size > 128) {
      const oldestThread = this.observed.keys().next().value;
      if (oldestThread !== undefined) this.observed.delete(oldestThread);
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
