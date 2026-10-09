import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initShortcuts, getKeybindings, loadKeybindings } from "@/lib/shortcuts";
import { registerCommand, clearCommands } from "@/lib/command-registry";
import { clearKeybindings } from "@/lib/keybinding-manager";
import { resetContext } from "@/lib/context-tracker";

function createKeyEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: overrides.key ?? "a",
    ctrlKey: overrides.ctrlKey ?? false,
    metaKey: overrides.metaKey ?? false,
    shiftKey: overrides.shiftKey ?? false,
    altKey: overrides.altKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  vi.spyOn(event, "preventDefault");
  return event;
}

describe("shortcuts integration", () => {
  let cleanup: () => void;

  beforeEach(() => {
    clearKeybindings();
    clearCommands();
    resetContext();
    loadKeybindings([]);
    cleanup = initShortcuts();
  });

  afterEach(() => {
    cleanup();
  });

  it("fires a registered command when its keybinding matches", () => {
    const handler = vi.fn();
    registerCommand({ id: "test.cmd", title: "Test", category: "Test", handler });
    loadKeybindings([{ key: "mod+k", command: "test.cmd" }]);

    const event = createKeyEvent({ key: "k", ctrlKey: true });
    document.dispatchEvent(event);

    expect(handler).toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("does not fire when key does not match", () => {
    const handler = vi.fn();
    registerCommand({ id: "test.cmd", title: "Test", category: "Test", handler });
    loadKeybindings([{ key: "mod+k", command: "test.cmd" }]);

    document.dispatchEvent(createKeyEvent({ key: "j", ctrlKey: true }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("respects when clause: !inputFocused blocks when input is focused", () => {
    const handler = vi.fn();
    registerCommand({ id: "test.cmd", title: "Test", category: "Test", handler });
    loadKeybindings([{ key: "mod+n", command: "test.cmd", when: "!inputFocused" }]);

    // handleKeyDown calls updateFocusContext() which reads document.activeElement,
    // so we need an actual input element to simulate input focus
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    document.dispatchEvent(createKeyEvent({ key: "n", ctrlKey: true }));
    expect(handler).not.toHaveBeenCalled();

    input.blur();
    document.dispatchEvent(createKeyEvent({ key: "n", ctrlKey: true }));
    expect(handler).toHaveBeenCalled();

    document.body.removeChild(input);
  });

  it("getKeybindings returns active bindings", () => {
    loadKeybindings([{ key: "mod+k", command: "commandPalette.toggle" }]);
    expect(getKeybindings().length).toBe(1);
  });
});

// Regression guard for issue #304: terminal.toggle must fire even when an
// input is focused. Users invoke Ctrl/Cmd+J from the composer to toggle the
// terminal; the previous `when: !inputFocused` gate broke that workflow.
describe("terminal.toggle keybinding (regression #304)", () => {
  let cleanup: () => void;

  beforeEach(() => {
    clearKeybindings();
    clearCommands();
    resetContext();
  });

  afterEach(() => {
    cleanup?.();
  });

  it("default keybindings bind terminal.toggle to mod+j without a when clause", async () => {
    const defaults = (await import("@/config/default-keybindings.json")).default as Array<{
      key: string;
      command: string;
      when?: string;
    }>;
    const terminalToggle = defaults.find((b) => b.command === "terminal.toggle");
    expect(terminalToggle).toBeDefined();
    expect(terminalToggle!.key).toBe("mod+j");
    expect(terminalToggle!.when).toBeUndefined();
  });

  it("fires terminal.toggle even when a text input is focused", () => {
    const handler = vi.fn();
    registerCommand({
      id: "terminal.toggle",
      title: "Toggle Terminal",
      category: "Terminal",
      handler,
    });
    loadKeybindings([{ key: "mod+j", command: "terminal.toggle" }]);
    cleanup = initShortcuts();

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    document.dispatchEvent(createKeyEvent({ key: "j", ctrlKey: true }));
    expect(handler).toHaveBeenCalled();

    document.body.removeChild(input);
  });
});

describe("window keys", () => {
  const presses: [string, Partial<KeyboardEvent>][] = [
    ["window.zoomIn", { key: "=", ctrlKey: true }],
    ["window.zoomIn", { key: "+", ctrlKey: true }],
    ["window.zoomIn", { key: "+", ctrlKey: true, shiftKey: true }],
    ["window.zoomOut", { key: "-", ctrlKey: true }],
    ["window.zoomReset", { key: "0", ctrlKey: true }],
    ["window.toggleFullScreen", { key: "F11" }],
  ];
  let cleanup: (() => void) | undefined;
  let fired: string[];

  function start(platform: "win32" | "linux" | "darwin" | undefined): void {
    vi.stubGlobal(
      "desktopBridge",
      platform ? { window: { platform, isDevelopment: false } } : undefined,
    );
    fired = [];
    for (const id of new Set(presses.map(([command]) => command))) {
      registerCommand({ id, title: id, category: "View", handler: () => fired.push(id) });
    }
    cleanup = initShortcuts();
  }

  beforeEach(() => {
    clearKeybindings();
    clearCommands();
    resetContext();
  });

  afterEach(() => {
    cleanup?.();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it.each(["win32", "linux"] as const)("fire on %s desktop even while a text field has focus", (platform) => {
    start(platform);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    for (const [, press] of presses) input.dispatchEvent(createKeyEvent(press));

    expect(fired).toEqual(presses.map(([command]) => command));
  });

  it.each([
    ["macOS desktop, where the native menu owns them", "darwin"],
    ["the web build", undefined],
  ] as const)("do nothing on %s", (_label, platform) => {
    start(platform);

    for (const [, press] of presses) document.dispatchEvent(createKeyEvent(press));

    expect(fired).toEqual([]);
  });
});
