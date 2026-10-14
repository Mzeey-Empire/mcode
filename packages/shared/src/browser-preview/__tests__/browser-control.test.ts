import { describe, expect, it } from "vitest";
import { createBrowserThreadControl, reduceBrowserControl } from "../browser-control.js";

function agentControl() {
  return reduceBrowserControl(createBrowserThreadControl(), {
    type: "agent-effect", tabId: "first", expectedEpoch: 0,
  }).next;
}

function userControl() {
  return reduceBrowserControl(agentControl(), { type: "take-control", tabId: "first" }).next;
}

describe("reduceBrowserControl", () => {
  it("admits a matching effect from none without mutating the initial state", () => {
    const initial = createBrowserThreadControl();
    const decision = reduceBrowserControl(initial, { type: "agent-effect", tabId: "first", expectedEpoch: 0 });
    expect(decision).toEqual({ admitted: true, next: { holder: "agent", heldTabId: null, epochByTab: new Map([["first", 0]]) } });
    expect(initial).toEqual({ holder: "none", heldTabId: null, epochByTab: new Map() });
  });

  it("refuses a stale effect from none without claiming control", () => {
    expect(reduceBrowserControl(createBrowserThreadControl(), { type: "agent-effect", tabId: "first", expectedEpoch: 1 }))
      .toEqual({ admitted: false, code: "STALE_CONTROL_EPOCH", next: { holder: "none", heldTabId: null, epochByTab: new Map() } });
  });

  it("invalidates observations on idle user input without creating a hold", () => {
    const initial = createBrowserThreadControl();
    const decision = reduceBrowserControl(initial, { type: "user-input", tabId: "first" });
    expect(decision).toEqual({ admitted: true, next: { holder: "none", heldTabId: null, epochByTab: new Map([["first", 1]]) } });
    expect(initial.epochByTab.size).toBe(0);
  });

  it.each(["user-input", "take-control"] as const)("holds agent control on %s and increments only that tab's epoch", (type) => {
    const initial = reduceBrowserControl(agentControl(), { type: "agent-effect", tabId: "second", expectedEpoch: 0 }).next;
    expect(reduceBrowserControl(initial, { type, tabId: "first" })).toEqual({
      admitted: true, next: { holder: "user", heldTabId: "first", epochByTab: new Map([["first", 1], ["second", 0]]) },
    });
    expect(initial.epochByTab).toEqual(new Map([["first", 0], ["second", 0]]));
  });

  it("releases agent control at turn end and revokes its observation epochs", () => {
    expect(reduceBrowserControl(agentControl(), { type: "agent-turn-ended" })).toEqual({
      admitted: true, next: { holder: "none", heldTabId: null, epochByTab: new Map([["first", 1]]) },
    });
  });

  it.each(["first", "second"])("refuses an effect on %s while held, even with the current epoch", (tabId) => {
    const state = userControl();
    expect(reduceBrowserControl(state, { type: "agent-effect", tabId, expectedEpoch: tabId === "first" ? 1 : 0 }))
      .toEqual({ admitted: false, code: "HUMAN_INTERRUPTED", next: { holder: "user", heldTabId: "first", epochByTab: new Map([["first", 1]]) } });
  });

  it("hands back control once and requires a fresh epoch", () => {
    const held = userControl();
    const released = reduceBrowserControl(held, { type: "hand-back" }).next;
    expect(released).toEqual({ holder: "none", heldTabId: null, epochByTab: new Map([["first", 2]]) });
    expect(held.epochByTab.get("first")).toBe(1);
    expect(reduceBrowserControl(released, { type: "hand-back" }).next).toBe(released);
    expect(reduceBrowserControl(released, { type: "agent-effect", tabId: "first", expectedEpoch: 1 }))
      .toMatchObject({ admitted: false, code: "STALE_CONTROL_EPOCH" });
    expect(reduceBrowserControl(released, { type: "agent-effect", tabId: "first", expectedEpoch: 2 }))
      .toMatchObject({ admitted: true, next: { holder: "agent" } });
  });

  it("preserves the user hold at agent turn end", () => {
    expect(reduceBrowserControl(userControl(), { type: "agent-turn-ended" })).toEqual({
      admitted: true, next: { holder: "user", heldTabId: "first", epochByTab: new Map([["first", 1]]) },
    });
  });

  it("ends the hold only when the held tab closes", () => {
    const held = userControl();
    expect(reduceBrowserControl(held, { type: "tab-closed", tabId: "second" }).next).toEqual(held);
    expect(reduceBrowserControl(held, { type: "tab-closed", tabId: "first" })).toEqual({
      admitted: true, next: { holder: "none", heldTabId: null, epochByTab: new Map() },
    });
    expect(held.epochByTab.get("first")).toBe(1);
  });

  it.each(["first", "second"])("keeps the hold when a message starts a new turn acting on %s", (tabId) => {
    const ended = reduceBrowserControl(userControl(), { type: "agent-turn-ended" }).next;
    expect(reduceBrowserControl(ended, { type: "agent-effect", tabId, expectedEpoch: tabId === "first" ? 1 : 0 }))
      .toEqual({ admitted: false, code: "HUMAN_INTERRUPTED", next: { holder: "user", heldTabId: "first", epochByTab: new Map([["first", 1]]) } });
  });
});
