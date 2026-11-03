import { describe, expect, it } from "vitest";
import type { ThreadTargetModelOption } from "@mcode/contracts/thread-control";
import { reasoningEffortOption, selectReasoningLevel } from "../reasoning-effort-option.js";

describe("reasoningEffortOption", () => {
  it("offers no option when the model declares no levels, even if it supports reasoning", () => {
    expect(reasoningEffortOption({}, "high")).toBeUndefined();
    expect(reasoningEffortOption({ supportedReasoningEfforts: [] }, "high")).toBeUndefined();
    expect(reasoningEffortOption({ supportedReasoningEfforts: [], defaultReasoningEffort: "high" }, "high")).toBeUndefined();
  });

  it("lists the declared levels lowest first without repeats", () => {
    expect(reasoningEffortOption({ supportedReasoningEfforts: ["high", "low", "low", "medium"] }, "high"))
      .toEqual({ id: "reasoningEffort", values: ["low", "medium", "high"], default: "high" });
  });

  it("snaps the user default down to the highest declared level at or below it", () => {
    expect(reasoningEffortOption({ supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "low" }, "max")?.default)
      .toBe("high");
  });

  it("falls back to the model's declared default when nothing sits at or below the user default", () => {
    expect(reasoningEffortOption({ supportedReasoningEfforts: ["medium", "high", "xhigh"], defaultReasoningEffort: "high" }, "low")?.default)
      .toBe("high");
  });

  it("falls back to the lowest declared level when the model's default is missing or unlisted", () => {
    expect(reasoningEffortOption({ supportedReasoningEfforts: ["medium", "high"] }, "low")?.default).toBe("medium");
    expect(reasoningEffortOption({ supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "max" }, "low")?.default)
      .toBe("medium");
  });
});

describe("selectReasoningLevel", () => {
  const option: ThreadTargetModelOption = { id: "reasoningEffort", values: ["low", "medium", "high"], default: "medium" };

  it("accepts a listed level", () => {
    expect(selectReasoningLevel("gpt-test", option, "low")).toEqual({ ok: true, level: "low" });
  });

  it("rejects an unlisted level instead of clamping it", () => {
    expect(selectReasoningLevel("gpt-test", option, "max")).toEqual({
      ok: false,
      message: "gpt-test accepts options.reasoningEffort low, medium, high; got max. Omit it to use medium.",
    });
  });

  it("rejects any level for a model without the option", () => {
    expect(selectReasoningLevel("gpt-test", undefined, "high")).toEqual({
      ok: false,
      message: "gpt-test does not accept options.reasoningEffort. Omit it.",
    });
  });

  it("returns the option default when no level is requested, and nothing for a model without the option", () => {
    expect(selectReasoningLevel("gpt-test", option, undefined)).toEqual({ ok: true, level: "medium" });
    expect(selectReasoningLevel("gpt-test", undefined, undefined)).toEqual({ ok: true, level: undefined });
  });
});
