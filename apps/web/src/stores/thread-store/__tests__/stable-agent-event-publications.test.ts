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
  it("deduplicates one owner event across target thread identities", () => {
    const cursor = new StableAgentEventPublications(storage);
    const identity = { ownerThreadId: "parent", epoch: "runtime-1", eventId: "event-1" };
    expect(cursor.acceptCanonical(event(1), identity)).toBe(true);
    expect(cursor.acceptCanonical({ ...event(1), threadId: "other-alias" }, identity)).toBe(false);
    cursor.forgetThread("other-alias");
    expect(cursor.acceptCanonical(event(1), identity)).toBe(false);
    cursor.forgetThread("parent", new Set(["parent"]));
    expect(cursor.acceptCanonical(event(1), identity)).toBe(false);
  });

  it("keeps identical event IDs from independent owners separate", () => {
    const cursor = new StableAgentEventPublications(storage);
    expect(cursor.acceptCanonical(event(1), { ownerThreadId: "parent-a", epoch: "runtime-1", eventId: "event-1" })).toBe(true);
    expect(cursor.acceptCanonical(event(1), { ownerThreadId: "parent-b", epoch: "runtime-1", eventId: "event-1" })).toBe(true);
  });

  it("does not merge epoch and event IDs containing separators", () => {
    const cursor = new StableAgentEventPublications(storage);
    expect(cursor.acceptCanonical(event(1), { epoch: "runtime:1", eventId: "event" })).toBe(true);
    expect(cursor.acceptCanonical(event(1), { epoch: "runtime", eventId: "1:event" })).toBe(true);
  });
  it("accepts reused numeric publications in a new runtime epoch", () => {
    const cursor = new StableAgentEventPublications(storage);
    expect(cursor.acceptCanonical(event(1), { epoch: "runtime-1", eventId: "event-1" })).toBe(true);
    expect(cursor.acceptCanonical(event(1), { epoch: "runtime-1", eventId: "event-1" })).toBe(false);
    expect(cursor.acceptCanonical(event(1), { epoch: "runtime-2", eventId: "event-2" })).toBe(true);
  });

  it("does not confuse an older legacy publication with a new epoch's first effect", () => {
    const cursor = new StableAgentEventPublications(storage);
    expect(cursor.accept(event(1), "runtime-1")).toBe(true);
    expect(cursor.acceptCanonical(event(1), { epoch: "runtime-2", eventId: "new-event-1" })).toBe(true);
  });
  it("rejects a publish-then-crash replay after recreating the client", () => {
    const shared = storage();
    const firstClient = new StableAgentEventPublications(() => shared);
    const published = event(7);
    expect(firstClient.accept(published)).toBe(true);
    const reloadedClient = new StableAgentEventPublications(() => shared);
    expect(reloadedClient.accept(published)).toBe(false);
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

  it("applies each publication once when its cursor write fails", () => {
    const cursor = new StableAgentEventPublications(() => ({
      getItem: () => null,
      setItem: () => { throw new Error("quota"); },
    }));
    expect(cursor.accept(event(1))).toBe(true);
    expect(cursor.accept(event(1))).toBe(false);
    expect(cursor.accept(event(2))).toBe(true);
    expect(cursor.accept(event(1))).toBe(false);
  });

  it("retains a failed write over the older stored cursor and persists again after recovery", () => {
    const shared = storage();
    let failWrites = false;
    const cursor = new StableAgentEventPublications(() => ({
      getItem: shared.getItem,
      setItem: (key, value) => {
        if (failWrites) throw new Error("quota");
        shared.setItem(key, value);
      },
    }));
    expect(cursor.accept(event(6))).toBe(true);
    failWrites = true;
    expect(cursor.accept(event(7))).toBe(true);
    expect(cursor.accept(event(7))).toBe(false);
    failWrites = false;
    expect(cursor.accept(event(8))).toBe(true);
    const reloaded = new StableAgentEventPublications(() => shared);
    expect(reloaded.accept(event(7))).toBe(false);
    expect(reloaded.accept(event(8))).toBe(false);
    expect(reloaded.accept(event(9))).toBe(true);
  });

  it("fails closed on an oversized stored cursor", () => {
    const cursor = new StableAgentEventPublications(() => ({
      getItem: () => "1".repeat(17),
      setItem: () => { throw new Error("unexpected write"); },
    }));
    expect(cursor.accept(event(1))).toBe(false);
  });
});
