import { describe, it, expect, beforeEach } from "vitest";
import {
  setContext,
  evaluateWhen,
  resetContext,
} from "@/lib/context-tracker";

describe("ContextTracker", () => {
  beforeEach(() => {
    resetContext();
  });

  it("evaluateWhen returns true for undefined when clause", () => {
    expect(evaluateWhen(undefined)).toBe(true);
  });

  it("evaluateWhen checks positive context", () => {
    setContext("inputFocused", true);
    expect(evaluateWhen("inputFocused")).toBe(true);
    expect(evaluateWhen("terminalFocused")).toBe(false);
  });

  it("evaluateWhen checks negated context", () => {
    setContext("inputFocused", false);
    expect(evaluateWhen("!inputFocused")).toBe(true);
    setContext("inputFocused", true);
    expect(evaluateWhen("!inputFocused")).toBe(false);
  });

  it("evaluateWhen returns false for unknown context keys", () => {
    expect(evaluateWhen("unknownKey")).toBe(false);
  });

  it("evaluateWhen supports && conjunction", () => {
    setContext("showLanding", true);
    setContext("commandPaletteOpen", false);
    setContext("inputFocused", false);
    expect(
      evaluateWhen("showLanding && !commandPaletteOpen && !inputFocused"),
    ).toBe(true);
    setContext("commandPaletteOpen", true);
    expect(
      evaluateWhen("showLanding && !commandPaletteOpen && !inputFocused"),
    ).toBe(false);
  });
});
