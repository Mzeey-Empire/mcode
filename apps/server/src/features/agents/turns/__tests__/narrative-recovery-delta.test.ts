import { describe, expect, it } from "vitest";
import type { ParentNarrativeRecoveryItem } from "@mcode/contracts";

import { NarrativeRecoveryDelta } from "../narrative-recovery-delta.js";

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
});
