import { describe, expect, it } from "vitest";
import { browserPartitionFor } from "../browser-partition.js";

describe("browserPartitionFor", () => {
  it("names and canonicalizes UUID partitions", () => {
    expect(browserPartitionFor("ABCDEF12-3456-4789-8ABC-DEF012345678"))
      .toBe("persist:mcode-browser-abcdef12-3456-4789-8abc-def012345678");
  });

  it.each(["", "workspace-A", "../escape", "11111111-1111-4111-8111-111111111111/..", " 11111111-1111-4111-8111-111111111111", "11111111-1111-4111-1111-111111111111"])("rejects %s", (id) => {
    expect(() => browserPartitionFor(id)).toThrow(TypeError);
  });
});
