import { describe, expect, it } from "vitest";
import { assignShards } from "../test-duration-sequencer.js";

describe("assignShards", () => {
  it("balances shards by recorded duration rather than file count", () => {
    const durations = { "a.test.ts": 100, "b.test.ts": 60, "c.test.ts": 50, "d.test.ts": 40, "e.test.ts": 10 };

    expect(assignShards(Object.keys(durations), durations, 2)).toEqual([
      ["a.test.ts", "d.test.ts"],
      ["b.test.ts", "c.test.ts", "e.test.ts"],
    ]);
  });

  it("weights an unrecorded file as the median recorded file", () => {
    const durations = { "a.test.ts": 10, "b.test.ts": 30, "c.test.ts": 500 };

    expect(assignShards(["a.test.ts", "b.test.ts", "c.test.ts", "new.test.ts"], durations, 2)).toEqual([
      ["c.test.ts"],
      ["b.test.ts", "new.test.ts", "a.test.ts"],
    ]);
  });

  it("gives every shard job the same split whatever order Vitest lists the files in", () => {
    const durations = { "a.test.ts": 20, "b.test.ts": 20, "c.test.ts": 20, "d.test.ts": 5 };
    const paths = Object.keys(durations);

    expect(assignShards([...paths].reverse(), durations, 3)).toEqual(assignShards(paths, durations, 3));
    expect(assignShards(paths, durations, 3)).toEqual([["a.test.ts", "d.test.ts"], ["b.test.ts"], ["c.test.ts"]]);
  });
});
