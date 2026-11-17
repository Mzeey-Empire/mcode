import { describe, expect, it } from "vitest";
import { fastModeView } from "../fast-mode-view";

describe("fastModeView", () => {
  it("is absent when the model does not support Fast", () => {
    expect(fastModeView({ supported: false, chosen: true, status: { modelId: "opus", state: "on" }, modelId: "opus" })).toEqual({ kind: "absent" });
  });

  it("ignores a status reported for another model", () => {
    expect(fastModeView({ supported: true, chosen: true, status: { modelId: "sonnet", state: "cooldown" }, modelId: "opus" })).toEqual({ kind: "on" });
  });

  it("shows cooling while the selected model cools down", () => {
    expect(fastModeView({ supported: true, chosen: true, status: { modelId: "opus", state: "cooldown" }, modelId: "opus" })).toEqual({ kind: "cooling" });
  });

  it("shows the reason Fast is unavailable", () => {
    expect(fastModeView({ supported: true, chosen: true, status: { modelId: "opus", state: "off", unavailable: "plan" }, modelId: "opus" }))
      .toEqual({ kind: "unavailable", reason: "plan" });
  });

  it("follows the user's choice when the provider reports plain off", () => {
    expect(fastModeView({ supported: true, chosen: true, status: { modelId: "opus", state: "off" }, modelId: "opus" })).toEqual({ kind: "on" });
  });
});
