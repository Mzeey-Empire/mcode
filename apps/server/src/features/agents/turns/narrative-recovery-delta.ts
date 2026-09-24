import type { ParentNarrativeRecoveryItem } from "@mcode/contracts";

/** One full-snapshot difference awaiting confirmation of its durable write. */
export interface PreparedNarrativeRecoveryDelta {
  readonly items: readonly ParentNarrativeRecoveryItem[];
  readonly discardedItemIds: readonly string[];
  acknowledge(): void;
}

/** Tracks one execution's committed narrative snapshot without owning persistence. */
export class NarrativeRecoveryDelta {
  private fingerprints = new Map<string, string>();
  private revision = 0;

  /** Compare a complete snapshot to the last acknowledged one. */
  prepare(snapshot: readonly ParentNarrativeRecoveryItem[]): PreparedNarrativeRecoveryDelta | null {
    const next = new Map<string, string>();
    const items: ParentNarrativeRecoveryItem[] = [];
    for (const item of snapshot) {
      const id = `${item.kind}:${item.record.id}`;
      const fingerprint = JSON.stringify(item);
      next.set(id, fingerprint);
      if (this.fingerprints.get(id) !== fingerprint) items.push(item);
    }
    const discardedItemIds = [...this.fingerprints.keys()]
      .filter((id) => !next.has(id)).map(canonicalItemId);
    if (items.length === 0 && discardedItemIds.length === 0) return null;
    const preparedAt = this.revision;
    return {
      items,
      discardedItemIds,
      acknowledge: () => {
        if (this.revision !== preparedAt) throw new Error("Narrative recovery delta was already superseded");
        this.fingerprints = next;
        this.revision += 1;
      },
    };
  }
}

function canonicalItemId(key: string): string {
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1) {
    throw new Error(`Invalid narrative recovery identity: ${key}`);
  }
  return key;
}
