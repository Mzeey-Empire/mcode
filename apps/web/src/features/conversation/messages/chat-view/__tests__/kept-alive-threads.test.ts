import { describe, expect, it } from "vitest";
import { NO_KEPT_ALIVE_THREADS, keepThreadAlive, type KeptAliveThreads } from "../kept-alive-threads";

function select(ids: readonly string[], limit = 3): KeptAliveThreads {
  return ids.reduce((kept, id) => keepThreadAlive(kept, id, limit), NO_KEPT_ALIVE_THREADS);
}

describe("keepThreadAlive", () => {
  it("keeps every mounted transcript in place when switching back and forth", () => {
    let kept = NO_KEPT_ALIVE_THREADS;
    const orders = ["a", "b", "a", "b"].map((id) => (kept = keepThreadAlive(kept, id, 3)).mounted);
    expect(orders).toEqual([["a"], ["a", "b"], ["a", "b"], ["a", "b"]]);
  });

  it("adds a newly selected thread after the mounted ones", () => {
    expect(select(["a", "b", "c"]).mounted).toEqual(["a", "b", "c"]);
  });

  it("evicts the least recently selected thread, not the first mounted one", () => {
    expect(select(["a", "b", "c", "a", "d"]).mounted).toEqual(["a", "c", "d"]);
  });
});
