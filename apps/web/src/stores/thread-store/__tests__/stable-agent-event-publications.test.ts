import type { AgentEvent } from "@mcode/contracts";
import { describe, expect, it } from "vitest";
import { StableAgentEventPublications } from "../stable-agent-event-publications";

const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const NEXT_EXECUTION_ID = "00000000-0000-4000-8000-000000000002";

function event(sequence: number, executionId = EXECUTION_ID): AgentEvent {
  return { type: "toolUse", threadId: "thread-publication", turnExecutionId: executionId,
    publicationId: String(sequence), toolCallId: `call-${sequence}`,
    toolName: "Read", toolInput: {} };
}

function storage(): Pick<Storage, "getItem" | "setItem"> {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => { items.set(key, value); },
  };
}

describe("stable AgentEvent publications", () => {
  it("rejects a publish-then-crash replay after recreating the client and changing server epoch", () => {
    const shared = storage();
    const firstClient = new StableAgentEventPublications(() => shared);
    const published = event(7);
    expect(firstClient.accept({ ...published, epoch: "00000000-0000-4000-8000-000000000004" }))
      .toBe(true);
    const reloadedClient = new StableAgentEventPublications(() => shared);
    expect(reloadedClient.accept({ ...published, epoch: "00000000-0000-4000-8000-000000000005" }))
      .toBe(false);
    expect(reloadedClient.accept(event(8))).toBe(true);
    expect(reloadedClient.accept(event(7))).toBe(false);
  });

  it("rejects an arbitrarily late prior-execution replay after an all-day stream", () => {
    const shared = storage();
    const cursor = new StableAgentEventPublications(() => shared);
    for (let sequence = 1; sequence <= 8_193; sequence++) {
      expect(cursor.accept(event(sequence))).toBe(true);
    }
    expect(cursor.accept(event(8_194, NEXT_EXECUTION_ID))).toBe(true);
    expect(cursor.accept(event(1))).toBe(false);
    expect(cursor.accept(event(8_193))).toBe(false);
  });

  it("lets two independent tabs each apply the same publication", () => {
    const firstStore = storage();
    const secondStore = storage();
    const firstTab = new StableAgentEventPublications(() => firstStore);
    const secondTab = new StableAgentEventPublications(() => secondStore);
    expect(firstTab.accept(event(1))).toBe(true);
    expect(secondTab.accept(event(1))).toBe(true);
    expect(firstTab.accept(event(1))).toBe(false);
    expect(secondTab.accept(event(1))).toBe(false);
  });

  it("fails closed if its durable cursor cannot be stored", () => {
    const cursor = new StableAgentEventPublications(() => ({
      getItem: () => null,
      setItem: () => { throw new Error("quota"); },
    }));
    expect(cursor.accept(event(1))).toBe(false);
  });

  it("fails closed on an oversized stored cursor", () => {
    const cursor = new StableAgentEventPublications(() => ({
      getItem: () => "1".repeat(17),
      setItem: () => { throw new Error("unexpected write"); },
    }));
    expect(cursor.accept(event(1))).toBe(false);
  });
});
