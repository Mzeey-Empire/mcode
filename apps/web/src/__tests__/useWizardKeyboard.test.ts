import { describe, it, expect } from "vitest";
import { resolveWizardKeyAction } from "../components/chat/plan-questions/useWizardKeyboard";

/** Helper to create a minimal KeyboardEvent-like object. */
function key(
  k: string,
  opts: { ctrl?: boolean; alt?: boolean; target?: string } = {},
): KeyboardEvent {
  return {
    key: k,
    ctrlKey: opts.ctrl ?? false,
    altKey: opts.alt ?? false,
    target: { tagName: opts.target ?? "DIV" } as unknown as EventTarget,
  } as unknown as KeyboardEvent;
}

describe("resolveWizardKeyAction", () => {
  // --- Number keys (AC-1.7) ---
  it("selects option by number key 1-indexed", () => {
    const action = resolveWizardKeyAction(key("1"), 4, -1, false);
    expect(action).toEqual({ type: "selectOption", index: 0 });
  });

  it("selects option 5", () => {
    const action = resolveWizardKeyAction(key("5"), 5, 0, true);
    expect(action).toEqual({ type: "selectOption", index: 4 });
  });

  it("ignores number key beyond option count", () => {
    const action = resolveWizardKeyAction(key("5"), 3, 0, true);
    expect(action).toBeNull();
  });

  it("ignores number keys when text input focused", () => {
    const action = resolveWizardKeyAction(key("2", { target: "TEXTAREA" }), 4, 0, true);
    expect(action).toBeNull();
  });

  // --- Arrow keys (AC-1.8) ---
  it("wraps forward with ArrowDown", () => {
    const action = resolveWizardKeyAction(key("ArrowDown"), 4, 3, true);
    expect(action).toEqual({ type: "selectOption", index: 0 });
  });

  it("wraps backward with ArrowUp", () => {
    const action = resolveWizardKeyAction(key("ArrowUp"), 4, 0, true);
    expect(action).toEqual({ type: "selectOption", index: 3 });
  });

  it("selects first on ArrowDown when nothing selected", () => {
    const action = resolveWizardKeyAction(key("ArrowDown"), 4, -1, false);
    expect(action).toEqual({ type: "selectOption", index: 0 });
  });

  it("cycles backward with ArrowLeft", () => {
    const action = resolveWizardKeyAction(key("ArrowLeft"), 4, 2, true);
    expect(action).toEqual({ type: "selectOption", index: 1 });
  });

  it("ignores arrow keys when a text input is focused", () => {
    const action = resolveWizardKeyAction(key("ArrowDown", { target: "TEXTAREA" }), 4, 1, true);
    expect(action).toBeNull();
  });

  // --- Enter / Ctrl+Enter (AC-1.9) ---
  it("advances on Enter", () => {
    const action = resolveWizardKeyAction(key("Enter"), 4, 0, true);
    expect(action).toEqual({ type: "advance" });
  });

  it("advances on Ctrl+Enter", () => {
    const action = resolveWizardKeyAction(key("Enter", { ctrl: true }), 4, 0, true);
    expect(action).toEqual({ type: "advance" });
  });

  it("ignores Enter when text input is focused (allows newlines in textarea)", () => {
    const action = resolveWizardKeyAction(
      key("Enter", { target: "TEXTAREA" }),
      4,
      0,
      true,
    );
    expect(action).toBeNull();
  });

  it("ignores Enter when an INPUT is focused", () => {
    const action = resolveWizardKeyAction(
      key("Enter", { target: "INPUT" }),
      4,
      0,
      true,
    );
    expect(action).toBeNull();
  });

  // --- Escape (AC-1.10) ---
  it("deselects on Escape when an option is selected", () => {
    const action = resolveWizardKeyAction(key("Escape"), 4, 1, true);
    expect(action).toEqual({ type: "deselect" });
  });

  it("cancels on Escape when nothing is selected", () => {
    const action = resolveWizardKeyAction(key("Escape"), 4, -1, false);
    expect(action).toEqual({ type: "cancel" });
  });

  // --- Backspace / Alt+Left (AC-1.11) ---
  it("navigates to previous on Backspace when no text input focused", () => {
    const action = resolveWizardKeyAction(key("Backspace"), 4, 0, true);
    expect(action).toEqual({ type: "previous" });
  });

  it("ignores Backspace when text input is focused", () => {
    const action = resolveWizardKeyAction(key("Backspace", { target: "INPUT" }), 4, 0, true);
    expect(action).toBeNull();
  });

  it("navigates to previous on Alt+ArrowLeft", () => {
    const action = resolveWizardKeyAction(key("ArrowLeft", { alt: true }), 4, 0, true);
    expect(action).toEqual({ type: "previous" });
  });

  // --- Unrelated keys ---
  it("returns null for unrecognized keys", () => {
    const action = resolveWizardKeyAction(key("a"), 4, 0, true);
    expect(action).toBeNull();
  });
});
