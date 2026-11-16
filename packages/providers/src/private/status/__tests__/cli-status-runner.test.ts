import { describe, expect, it } from "vitest";
import { readCliStatusVersion } from "../cli-status-runner.js";

describe("readCliStatusVersion", () => {
  it.each([
    ["2.1.0 (Claude Code)", "2.1.0"],
    ["1.0.0-beta.1", "1.0.0-beta.1"],
    ["unknown version", null],
    ["1.2.3.4", null],
  ])("reads the adapter version from %s", async (output, expected) => {
    expect(await readCliStatusVersion(async (_binary, args) => {
      expect(args).toEqual(["--version"]);
      return { kind: "exited", code: 0, output };
    }, "provider")).toBe(expected);
  });

  it("does not treat version output from a failed probe as installed", async () => {
    expect(await readCliStatusVersion(async () => ({ kind: "exited", code: 1, output: "1.2.3" }), "provider")).toBeNull();
  });
});
