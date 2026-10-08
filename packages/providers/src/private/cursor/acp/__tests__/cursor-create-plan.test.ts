import { describe, it, expect } from "vitest";
import { extractCursorCreatePlanMarkdown } from "../cursor-create-plan.js";
import { loadProviderFixtureManifest } from "../../../../conformance/fixture-safety.js";
import { replayCursorPlanRequest } from "../../../../conformance/harness.js";
import * as NodePath from "node:path";

describe("extractCursorCreatePlanMarkdown", () => {
  const fixture = loadProviderFixtureManifest(NodePath.resolve(import.meta.dirname, "../../../../conformance/fixtures/cursor-core.synthetic.json"));
  it("drops oversized native capture at the bridge without failing the request", async () => {
    expect(await replayCursorPlanRequest(fixture, { plan: "x".repeat(256 * 1024 + 1) })).toEqual([]);
    expect(await replayCursorPlanRequest(fixture, { plan: "x".repeat(256 * 1024) })).toEqual([
      { threadId: "CURSOR_TRACE_THREAD", markdown: "x".repeat(256 * 1024), source: "native" },
    ]);
  });
  it("reads the S07-00 captured top-level plan field", () => {
    expect(extractCursorCreatePlanMarkdown({ plan: "# Plan\n\nBody", markdown: "Wrong field" })).toBe("# Plan\n\nBody");
  });

  it.each([{}, { plan: "" }, { plan: "  " }, { plan: 42 }, { markdown: "# Wrong field" }, { plan: { markdown: "# Wrong shape" } }])("rejects missing or invalid native plan text: %j", (params) => {
    expect(extractCursorCreatePlanMarkdown(params)).toBeNull();
  });
});
