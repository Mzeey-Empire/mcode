import { describe, expect, it } from "vitest";
import { decideOccupancy, type OccupancyInput } from "../session-occupancy.js";

function input(overrides: Partial<OccupancyInput> = {}): OccupancyInput {
  return { now: 1000, clock: 0, turnBusy: false, nativeTasks: [], occupancy: { held: false, lastActivityAt: null, lastUserTurnAt: null }, policy: { idleTtlMs: 100, nativeCapMs: 400, mode: "idle" }, ...overrides };
}

describe("session occupancy", () => {
  it.each([1000, 1001])("counts idle TTL from the latest activity at %i", (now) => {
    const facts = input({ now, occupancy: { held: false, lastActivityAt: 900, lastUserTurnAt: null } });
    expect(decideOccupancy(facts).evict).toBe(now === 1001);
    expect(decideOccupancy({ ...facts, clock: 950 }).evict).toBe(false);
  });

  it("never evicts turn work or declared holds", () => {
    expect(decideOccupancy(input({ turnBusy: true })).evict).toBe(false);
    expect(decideOccupancy(input({ occupancy: { held: true, lastActivityAt: null, lastUserTurnAt: null } })).evict).toBe(false);
  });

  it("caps each task from its own start or the last user turn", () => {
    const facts = input({ nativeTasks: [{ startedAt: 0 }], occupancy: { held: false, lastActivityAt: null, lastUserTurnAt: 700 } });
    expect(decideOccupancy({ ...facts, now: 1099 })).toEqual({ evict: false, nativeTasks: 1, nativeProtecting: 1 });
    expect(decideOccupancy({ ...facts, now: 1100 })).toEqual({ evict: true, reason: "idle", idleMs: 1100, nativeTasks: 1, nativeProtecting: 0 });
    expect(decideOccupancy({ ...facts, nativeTasks: [{ startedAt: 0 }, { startedAt: 900 }] })).toEqual({ evict: false, nativeTasks: 2, nativeProtecting: 2 });
    expect(decideOccupancy(input({ nativeTasks: [{ startedAt: 0 }, { startedAt: 900 }] }))).toEqual({ evict: false, nativeTasks: 2, nativeProtecting: 1 });
  });

  it("lets recent activity finish its TTL even after native protection expires", () => {
    expect(decideOccupancy(input({ nativeTasks: [{ startedAt: 0 }], occupancy: { held: false, lastActivityAt: 950, lastUserTurnAt: null } })).evict).toBe(false);
  });

  it("memory pressure skips TTL but respects turn and native work", () => {
    const facts = input({ clock: 1000, policy: { idleTtlMs: 100, nativeCapMs: 400, mode: "memory-pressure" } });
    expect(decideOccupancy(facts)).toEqual({ evict: true, reason: "memory-pressure", idleMs: 0, nativeTasks: 0, nativeProtecting: 0 });
    expect(decideOccupancy({ ...facts, turnBusy: true }).evict).toBe(false);
    expect(decideOccupancy({ ...facts, nativeTasks: [{ startedAt: 900 }] }).evict).toBe(false);
  });
});
