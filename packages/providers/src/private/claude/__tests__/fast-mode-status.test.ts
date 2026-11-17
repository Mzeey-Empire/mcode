import { describe, expect, it } from "vitest";
import { parseClaudeFastModeStatus } from "../fast-mode-status.js";

describe("Claude Fast status", () => {
  it.each([
    ["sdk_opt_in_required", undefined], ["preference", undefined], ["pending", undefined],
    ["free", "plan"], ["extra_usage_disabled", "extra_usage"], ["not_first_party", "provider_route"],
    ["disabled_by_env", "environment"], ["model_not_allowed", "model"],
    ["network_error", "unreachable"], ["unknown", "unknown"], ["future_reason", "unknown"],
  ])("maps %s", (reason, unavailable) => {
    expect(parseClaudeFastModeStatus({ type: "system", subtype: "init", fast_mode_state: "off", fast_mode_disabled_reason: reason }, "opus"))
      .toEqual({ modelId: "opus", state: "off", ...(unavailable ? { unavailable } : {}) });
  });
  it.each(["success", "error_during_execution"])("reads %s results", (subtype) => {
    expect(parseClaudeFastModeStatus({ type: "result", subtype, fast_mode_state: "cooldown" }, "opus"))
      .toEqual({ modelId: "opus", state: "cooldown" });
  });
  it("ignores messages without a state", () => {
    expect(parseClaudeFastModeStatus({ type: "system", subtype: "init" }, "opus")).toBeUndefined();
  });
});
