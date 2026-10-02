import type { ParentNarrativeRecoveryItem } from "@mcode/contracts";
import { ACTIVE_TURN_WRITE_BATCH_LIMITS } from "../../../runtime/persistence/sqlite/bounded-write-batches.js";
import type { ParentNarrativeRecoveryCommit } from "./parent-turn-durability.js";
import { assertActiveTurnRecoveryRetention } from "./active-turn-recovery-retention-policy.js";
import type { NarrativeRecoveryChanges } from "../conversation/narrative/narrative-turn-state.js";

/** One narrative difference awaiting acknowledgement by its persistence or acceptance owner. */
export interface PreparedNarrativeRecoveryDelta {
  readonly items: readonly ParentNarrativeRecoveryItem[];
  readonly discardedItemIds: readonly string[];
  acknowledge(): void;
}

/** Tracks one execution's committed narrative snapshot without owning persistence. */
export class NarrativeRecoveryDelta {
  private fingerprints = new Map<string, string>();
  private retainedBytes = 0;
  private retainedRecords = 0;
  private revision = 0;

  /** Share fingerprints until acknowledgement replaces the map; saving belongs to the progress owner. */
  fork(): NarrativeRecoveryDelta {
    const copy = new NarrativeRecoveryDelta();
    copy.fingerprints = this.fingerprints;
    copy.retainedBytes = this.retainedBytes;
    copy.retainedRecords = this.retainedRecords;
    copy.revision = this.revision;
    return copy;
  }

  /** Compare a complete snapshot to the last acknowledged one. */
  prepare(snapshot: readonly ParentNarrativeRecoveryItem[]): PreparedNarrativeRecoveryDelta | null {
    const next = new Map<string, string>();
    const items: ParentNarrativeRecoveryItem[] = [];
    let retainedBytes = 0;
    for (const item of snapshot) {
      const id = `${item.kind}:${item.record.id}`;
      const fingerprint = JSON.stringify(item);
      retainedBytes += Buffer.byteLength(fingerprint, "utf8");
      next.set(id, fingerprint);
      if (this.fingerprints.get(id) !== fingerprint) items.push(item);
    }
    const discardedItemIds = [...this.fingerprints.keys()]
      .filter((id) => !next.has(id)).map(canonicalItemId);
    if (items.length === 0 && discardedItemIds.length === 0) {
      // Recovery limits count snapshot entries, including repeated hook/thought identities.
      this.retainedBytes = retainedBytes;
      this.retainedRecords = snapshot.length;
      return null;
    }
    const preparedAt = this.revision;
    return {
      items,
      discardedItemIds,
      acknowledge: () => {
        if (this.revision !== preparedAt) throw new Error("Narrative recovery delta was already superseded");
        this.fingerprints = next;
        this.retainedBytes = retainedBytes;
        this.retainedRecords = snapshot.length;
        this.revision += 1;
      },
    };
  }

  /** Update one already checkpointed tool without treating unrelated records as deleted. */
  prepareToolUpdate(item: Extract<ParentNarrativeRecoveryItem, { kind: "toolCall" }> | null): PreparedNarrativeRecoveryDelta | null {
    if (!item) return null;
    const id = `${item.kind}:${item.record.id}`;
    const previous = this.fingerprints.get(id);
    if (previous === undefined) throw new Error("Tool recovery update requires an acknowledged full checkpoint");
    const fingerprint = JSON.stringify(item);
    const bytes = Buffer.byteLength(fingerprint, "utf8");
    if (bytes > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxBytes) throw new Error("Parent narrative recovery item exceeds the active-turn byte limit");
    const retainedBytes = this.retainedBytes + bytes - Buffer.byteLength(previous, "utf8");
    assertActiveTurnRecoveryRetention(this.retainedRecords, retainedBytes);
    if (previous === fingerprint) return null;
    const preparedAt = this.revision;
    return {
      items: [item], discardedItemIds: [],
      acknowledge: () => {
        if (this.revision !== preparedAt) throw new Error("Narrative recovery delta was already superseded");
        this.fingerprints = new Map(this.fingerprints);
        this.fingerprints.set(id, fingerprint);
        this.retainedBytes = retainedBytes;
        this.revision += 1;
      },
    };
  }

  /** Compare only an event's changed records; accepted history is not unsaved retention. */
  prepareChanges(changes: NarrativeRecoveryChanges): PreparedNarrativeRecoveryDelta | null {
    const updates = new Map<string, string>();
    const items = changes.items.filter((item) => {
      const id = `${item.kind}:${item.record.id}`;
      const fingerprint = JSON.stringify(item);
      if (Buffer.byteLength(fingerprint, "utf8") > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxBytes) {
        throw new Error("Parent narrative recovery item exceeds the active-turn byte limit");
      }
      updates.set(id, fingerprint);
      return this.fingerprints.get(id) !== fingerprint;
    });
    const discardedItemIds = changes.discardedItemIds.filter((id) => this.fingerprints.has(id));
    if (discardedItemIds.some((id) => updates.has(id))) throw new Error("Narrative recovery cannot update and discard the same item");
    if (items.length === 0 && discardedItemIds.length === 0) return null;
    const changedBytes = items.reduce((bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item), "utf8"), 0)
      + discardedItemIds.reduce((bytes, id) => bytes + Buffer.byteLength(id, "utf8"), 0);
    assertActiveTurnRecoveryRetention(items.length + discardedItemIds.length, changedBytes);
    const preparedAt = this.revision;
    return { items, discardedItemIds, acknowledge: () => {
      if (this.revision !== preparedAt) throw new Error("Narrative recovery delta was already superseded");
      this.acknowledgeChanges(updates, discardedItemIds);
    } };
  }

  private acknowledgeChanges(updates: ReadonlyMap<string, string>, discardedItemIds: readonly string[]): void {
    const next = new Map(this.fingerprints);
    for (const id of discardedItemIds) {
      const previous = next.get(id);
      if (previous === undefined) continue;
      this.retainedBytes -= Buffer.byteLength(previous, "utf8");
      this.retainedRecords -= 1;
      next.delete(id);
    }
    for (const [id, fingerprint] of updates) {
      const previous = next.get(id);
      this.retainedBytes += Buffer.byteLength(fingerprint, "utf8") - Buffer.byteLength(previous ?? "", "utf8");
      if (previous === undefined) this.retainedRecords += 1;
      next.set(id, fingerprint);
    }
    this.fingerprints = next;
    this.revision += 1;
  }
}

/** Split one prepared delta into writer-sized commands; acknowledge only after every command commits. */
export function splitNarrativeRecoveryDelta(
  executionId: string,
  prepared: PreparedNarrativeRecoveryDelta,
): ParentNarrativeRecoveryCommit[] {
  if (!executionId) throw new Error("Narrative recovery requires an execution ID");
  const chunks: ParentNarrativeRecoveryCommit[] = [];
  let items: ParentNarrativeRecoveryItem[] = [];
  let discardedItemIds: string[] = [];
  const flush = (): void => {
    if (items.length === 0 && discardedItemIds.length === 0) return;
    chunks.push({ executionId, items, discardedItemIds });
    items = [];
    discardedItemIds = [];
  };
  const fits = (nextItems: ParentNarrativeRecoveryItem[], nextDiscarded: string[]): boolean => {
    if (nextItems.length + nextDiscarded.length > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxRows - 2) return false;
    return Buffer.byteLength(JSON.stringify({ executionId, items: nextItems, discardedItemIds: nextDiscarded }), "utf8")
      <= ACTIVE_TURN_WRITE_BATCH_LIMITS.maxBytes;
  };
  for (const item of prepared.items) {
    if (!fits([...items, item], discardedItemIds)) flush();
    if (!fits([item], [])) throw new Error("Narrative recovery item exceeds one writer command");
    items.push(item);
  }
  for (const itemId of prepared.discardedItemIds) {
    if (!fits(items, [...discardedItemIds, itemId])) flush();
    if (!fits([], [itemId])) throw new Error("Narrative recovery discard exceeds one writer command");
    discardedItemIds.push(itemId);
  }
  flush();
  return chunks;
}

function canonicalItemId(key: string): string {
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1) {
    throw new Error(`Invalid narrative recovery identity: ${key}`);
  }
  return key;
}
