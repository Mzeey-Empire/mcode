import { describe, expect, it } from "vitest";
import type { FastModeStatus } from "@mcode/contracts/models/fast-mode";
import { fastModeView, type FastModeView } from "../fast-mode-view";

const ON: FastModeStatus = { modelId: "opus", state: "on" };
const COOLDOWN: FastModeStatus = { modelId: "opus", state: "cooldown" };
const UNAVAILABLE: FastModeStatus = { modelId: "opus", state: "off", unavailable: "plan" };
const PLAIN_OFF: FastModeStatus = { modelId: "opus", state: "off" };

describe("fastModeView", () => {
  it("is absent when the model does not support Fast", () => {
    expect(fastModeView({ supported: false, chosen: true, status: ON, modelId: "opus" })).toEqual({ kind: "absent" });
  });

  const cases: ReadonlyArray<[string, boolean, FastModeStatus | undefined, FastModeView]> = [
    ["follows a Fast choice with no status", true, undefined, { kind: "on" }],
    ["follows a Standard choice with no status", false, undefined, { kind: "off" }],
    ["ignores a status for another model", true, { modelId: "sonnet", state: "cooldown" }, { kind: "on" }],
    ["keeps Standard after a turn that ran Fast", false, ON, { kind: "off" }],
    ["keeps Standard while Fast cools down", false, COOLDOWN, { kind: "off" }],
    ["keeps Standard on a plain off", false, PLAIN_OFF, { kind: "off" }],
    ["dims Fast under Standard when it is unavailable", false, UNAVAILABLE, { kind: "unavailable", reason: "plan" }],
    ["shows Fast running", true, ON, { kind: "on" }],
    ["shows a chosen Fast cooling down", true, COOLDOWN, { kind: "cooling" }],
    ["shows why a chosen Fast is unavailable", true, UNAVAILABLE, { kind: "unavailable", reason: "plan" }],
    ["follows a Fast choice on a plain off", true, PLAIN_OFF, { kind: "on" }],
  ];

  it.each(cases)("%s", (_name, chosen, status, expected) => {
    expect(fastModeView({ supported: true, chosen, status, modelId: "opus" })).toEqual(expected);
  });
});
