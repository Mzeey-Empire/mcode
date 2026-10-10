import { describe, it, expect } from "vitest";
import { extractCursorCreatePlanMarkdown } from "../cursor-create-plan.js";
import { loadProviderFixtureManifest } from "../../../../conformance/fixture-safety.js";
import { replayCursorPlanRequest } from "../../../../conformance/harness.js";
import * as NodePath from "node:path";

describe("extractCursorCreatePlanMarkdown", () => {
  const fixture = loadProviderFixtureManifest(NodePath.resolve(import.meta.dirname, "../../../../conformance/fixtures/cursor-core.synthetic.json"));
  it("rejects oversized native capture with feedback and accepts the exact limit", async () => {
    const responses: unknown[] = [];
    expect(await replayCursorPlanRequest(fixture, { plan: "x".repeat(64 * 1024 + 1) }, (response) => responses.push(response))).toEqual([]);
    expect(responses).toEqual([{ outcome: { outcome: "rejected" },
      message: "The plan is too long for the client to capture. Shorten it and call create_plan again." }]);
    expect(await replayCursorPlanRequest(fixture, { plan: "x".repeat(64 * 1024) })).toEqual([
      { threadId: "CURSOR_TRACE_THREAD", markdown: "x".repeat(64 * 1024), source: "native" },
    ]);
  });
  it("reads the S07-00 captured top-level plan field", () => {
    expect(extractCursorCreatePlanMarkdown({ plan: "# Plan\n\nBody", markdown: "Wrong field" })).toBe("# Plan\n\nBody");
  });

  it.each([{}, { plan: "" }, { plan: "  " }, { plan: 42 }, { markdown: "# Wrong field" }, { plan: { markdown: "# Wrong shape" } }])("rejects missing or invalid native plan text: %j", (params) => {
    expect(extractCursorCreatePlanMarkdown(params)).toBeNull();
  });
});
