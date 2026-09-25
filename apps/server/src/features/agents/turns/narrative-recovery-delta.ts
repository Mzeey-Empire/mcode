import type { ParentNarrativeRecoveryItem } from "@mcode/contracts";
import { ACTIVE_TURN_WRITE_BATCH_LIMITS } from "../../../runtime/persistence/sqlite/bounded-write-batches.js";
import type { ParentNarrativeRecoveryCommit } from "./parent-turn-durability.js";
import { assertActiveTurnRecoveryRetention } from "./active-turn-recovery-retention-policy.js";

/** One full-snapshot difference awaiting confirmation of its durable write. */
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
        this.fingerprints.set(id, fingerprint);
        this.retainedBytes = retainedBytes;
        this.revision += 1;
      },
    };
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
