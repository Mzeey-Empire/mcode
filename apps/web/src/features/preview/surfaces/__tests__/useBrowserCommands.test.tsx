import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverlayGateContext } from "@/components/ui/overlay-gate";
import { clearCommands } from "@/lib/command-registry";
import { resetContext } from "@/lib/context-tracker";
import { clearKeybindings } from "@/lib/keybinding-manager";
import { initShortcuts } from "@/lib/shortcuts";
import type { BrowserCommandActions } from "../browserToolbarModel";
import { useBrowserCommands } from "../useBrowserCommands";

function Owner({
  name,
  active,
  gateOpen = true,
  log,
}: {
  readonly name: string;
  readonly active: boolean;
  readonly gateOpen?: boolean;
  readonly log: string[];
}) {
  return (
    <OverlayGateContext.Provider value={gateOpen}>
      <OwnerCommands name={name} active={active} log={log} />
    </OverlayGateContext.Provider>
  );
}

function OwnerCommands({ name, active, log }: { readonly name: string; readonly active: boolean; readonly log: string[] }) {
  const actions: BrowserCommandActions = {
    deviceToolbar: { kind: "enabled", run: () => log.push(`${name}:device`) },
    developerTools: { kind: "enabled", run: () => log.push(`${name}:devtools`) },
    forceReload: { kind: "disabled", reason: "Load a page first" },
  };
  useBrowserCommands({ active, actions });
  return <input data-browser-chrome="" aria-label={`${name} URL`} />;
}

function pressF12(): void {
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "F12", bubbles: true, cancelable: true }));
}

describe("useBrowserCommands", () => {
  let cleanup: () => void;

  beforeEach(() => {
    clearKeybindings();
    clearCommands();
    resetContext();
    cleanup = initShortcuts();
  });

  afterEach(() => {
    cleanup();
  });

  it("targets the visible owner even when a hidden warm owner mounts after it", () => {
    const log: string[] = [];
    const { getByLabelText } = render(
      <>
        <Owner name="visible" active log={log} />
        <Owner name="warm" active={false} log={log} />
        <Owner name="gated" active gateOpen={false} log={log} />
      </>,
    );
    getByLabelText("visible URL").focus();

    pressF12();

    expect(log).toEqual(["visible:devtools"]);
  });

  it("hands the keys to the newly visible owner and drops them on unmount", () => {
    const log: string[] = [];
    const { getByLabelText, rerender, unmount } = render(
      <>
        <Owner name="a" active log={log} />
        <Owner name="b" active={false} log={log} />
      </>,
    );
    rerender(
      <>
        <Owner name="a" active={false} log={log} />
        <Owner name="b" active log={log} />
      </>,
    );
    getByLabelText("b URL").focus();
    pressF12();
    unmount();
    const outside = document.createElement("input");
    outside.setAttribute("data-browser-chrome", "");
    document.body.appendChild(outside);
    outside.focus();
    pressF12();

    expect(log).toEqual(["b:devtools"]);
    outside.remove();
  });

  it("runs the device toolbar action on Ctrl Shift M from the browser chrome", () => {
    const log: string[] = [];
    const { getByLabelText } = render(<Owner name="visible" active log={log} />);
    getByLabelText("visible URL").focus();

    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "M", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
    );

    expect(log).toEqual(["visible:device"]);
  });

  it("leaves a disabled action unregistered so its key does nothing", () => {
    const log: string[] = [];
    const { getByLabelText } = render(<Owner name="visible" active log={log} />);
    getByLabelText("visible URL").focus();
    const event = new KeyboardEvent("keydown", { key: "R", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });

    document.activeElement!.dispatchEvent(event);

    expect(log).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });
});
