import { describe, expect, it } from "vitest";
import type { ParentNarrativeRecoveryItem } from "@mcode/contracts";

import { NarrativeRecoveryDelta, splitNarrativeRecoveryDelta } from "../narrative-recovery-delta.js";

const thought = {
  kind: "narrationSegment",
  record: {
    id: "thought-1", message_id: "message-1", text: "First thought",
    started_at: "2026-09-24T10:00:00.000Z", ended_at: null, sort_order: 1,
  },
} satisfies ParentNarrativeRecoveryItem;
const revisedThought = { ...thought, record: { ...thought.record, text: "Revised thought" } };

describe("NarrativeRecoveryDelta", () => {
  it("returns changed items, then skips an unchanged acknowledged snapshot", () => {
    const delta = new NarrativeRecoveryDelta();
    const first = delta.prepare([thought]);
    expect(first).toMatchObject({ items: [thought], discardedItemIds: [] });
    first?.acknowledge();
    expect(delta.prepare([thought])).toBeNull();

    const revised = delta.prepare([revisedThought]);
    expect(revised).toMatchObject({ items: [revisedThought], discardedItemIds: [] });
    revised?.acknowledge();
    expect(delta.prepare([revisedThought])).toBeNull();
  });

  it("reports an item removed from the complete snapshot", () => {
    const delta = new NarrativeRecoveryDelta();
    delta.prepare([thought])?.acknowledge();
    const discard = delta.prepare([]);
    expect(discard).toMatchObject({ items: [], discardedItemIds: ["narrationSegment:thought-1"] });
    discard?.acknowledge();
    expect(delta.prepare([])).toBeNull();
  });

  it("retries the same delta when persistence failed before acknowledgement", () => {
    const delta = new NarrativeRecoveryDelta();
    const failed = delta.prepare([thought]);
    const retry = delta.prepare([thought]);
    expect(retry).toMatchObject({ items: [thought], discardedItemIds: [] });
    retry?.acknowledge();
    expect(delta.prepare([thought])).toBeNull();
    expect(() => failed?.acknowledge()).toThrow("already superseded");
  });

  it("keeps separate executions' fingerprints independent", () => {
    const firstExecution = new NarrativeRecoveryDelta();
    const secondExecution = new NarrativeRecoveryDelta();
    firstExecution.prepare([thought])?.acknowledge();
    expect(firstExecution.prepare([thought])).toBeNull();
    expect(secondExecution.prepare([thought])).toMatchObject({ items: [thought] });
    expect(secondExecution.prepare([])).toBeNull();
  });

  it("updates and discards only supplied identities while preserving unrelated accepted records", () => {
    const delta = new NarrativeRecoveryDelta();
    const other = { ...thought, record: { ...thought.record, id: "other" } };
    delta.prepare([thought, other])?.acknowledge();
    const update = delta.prepareChanges({ items: [revisedThought], discardedItemIds: [] });
    expect(update).toMatchObject({ items: [revisedThought], discardedItemIds: [] });
    update?.acknowledge();
    expect(delta.prepare([revisedThought, other])).toBeNull();
    const discard = delta.prepareChanges({ items: [], discardedItemIds: ["narrationSegment:thought-1", "unknown"] });
    expect(discard).toMatchObject({ items: [], discardedItemIds: ["narrationSegment:thought-1"] });
    discard?.acknowledge();
    expect(delta.prepare([other])).toBeNull();
  });

  it("accepts small changes after acknowledged history exceeds the unsaved recovery budget", () => {
    const delta = new NarrativeRecoveryDelta();
    const history = Array.from({ length: 1100 }, (_, index) => ({
      ...thought, record: { ...thought.record, id: `thought-${index}`, text: "x".repeat(500) },
    }));
    for (const item of history) delta.prepareChanges({ items: [item], discardedItemIds: [] })?.acknowledge();
    expect(Buffer.byteLength(JSON.stringify(history), "utf8")).toBeGreaterThan(256 * 1024);
    expect(delta.prepare(history)).toBeNull();
    const last = history.at(-1);
    if (!last) throw new Error("Expected long history");
    const updated = { ...last, record: { ...last.record, text: "updated" } };
    const change = delta.prepareChanges({ items: [updated], discardedItemIds: [] });
    expect(change).toMatchObject({ items: [updated], discardedItemIds: [] });
    change?.acknowledge();
    expect(delta.prepare([...history.slice(0, -1), updated])).toBeNull();
  });

  it("keeps rejected fork acknowledgement separate from the accepted checkpoint", () => {
    const accepted = new NarrativeRecoveryDelta();
    accepted.prepare([thought])?.acknowledge();
    const rejected = accepted.fork();
    rejected.prepareChanges({ items: [revisedThought], discardedItemIds: [] })?.acknowledge();
    expect(accepted.prepare([thought])).toBeNull();
    expect(accepted.prepareChanges({ items: [revisedThought], discardedItemIds: [] }))
      .toMatchObject({ items: [revisedThought] });
    expect(rejected.prepare([revisedThought])).toBeNull();
  });

  it("keeps per-item and changed-event byte limits instead of increasing the recovery caps", () => {
    const delta = new NarrativeRecoveryDelta();
    expect(() => delta.prepareChanges({ items: [{ ...thought, record: {
      ...thought.record, text: "x".repeat(300_000),
    } }], discardedItemIds: [] })).toThrow("active-turn byte limit");
    const changed = ["first", "second"].map((id) => ({ ...thought,
      record: { ...thought.record, id, text: "x".repeat(150_000) } }));
    expect(() => delta.prepareChanges({ items: changed, discardedItemIds: [] }))
      .toThrow("retained byte capacity");
    expect(delta.prepare([])).toBeNull();
  });

  it("splits a large delta without acknowledging any chunk early", () => {
    const delta = new NarrativeRecoveryDelta();
    const snapshot = Array.from({ length: 63 }, (_, index) => ({
      ...thought,
      record: { ...thought.record, id: `thought-${index}` },
    }));
    const prepared = delta.prepare(snapshot);
    expect(prepared).not.toBeNull();
    if (!prepared) return;

    const chunks = splitNarrativeRecoveryDelta("execution-1", prepared);
    expect(chunks.map((chunk) => chunk.items.length)).toEqual([62, 1]);
    expect(chunks.flatMap((chunk) => chunk.items)).toEqual(snapshot);
    expect(delta.prepare(snapshot)?.items).toHaveLength(63);
    prepared.acknowledge();
    expect(delta.prepare(snapshot)).toBeNull();
  });

  it("splits by serialized bytes and rejects an item larger than one command", () => {
    const delta = new NarrativeRecoveryDelta();
    const snapshot = ["first", "second"].map((id) => ({
      ...thought,
      record: { ...thought.record, id, text: "x".repeat(150_000) },
    }));
    const prepared = delta.prepare(snapshot);
    expect(prepared).not.toBeNull();
    if (!prepared) return;
    expect(splitNarrativeRecoveryDelta("execution-1", prepared).map((chunk) => chunk.items.length)).toEqual([1, 1]);
    const oversized = delta.prepare([{ ...thought, record: { ...thought.record, text: "x".repeat(300_000) } }]);
    expect(oversized).not.toBeNull();
    if (!oversized) return;
    expect(() => splitNarrativeRecoveryDelta("execution-1", oversized)).toThrow("exceeds one writer command");
  });
});
