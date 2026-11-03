import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENIE_CLOSE_MS, GENIE_OPEN_MS } from "../genie";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Popover, PopoverContent, PopoverTrigger, type PopoverRootActions } from "../popover";

let frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;
let now = 0;

function frame(ms = 16): void {
  now += ms;
  const due = [...frames.values()];
  frames = new Map();
  act(() => due.forEach((callback) => callback(now)));
}

function realPopup(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="popover-content"]');
}

function clipOf(popup: HTMLElement | null): string {
  return popup?.style.clipPath ?? "";
}

function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce, media: query, addEventListener() {}, removeEventListener() {} }));
}

/** The popup at (100,100), 200x240; each of its rows a 32px strip near its top; the trigger 60x30 below it. */
function stubPopupWithRows(): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.dataset.slot === "popover-content") return new DOMRect(100, 100, 200, 240);
    if (this.closest('[data-slot="popover-content"]')) return new DOMRect(100, 140, 200, 32);
    return new DOMRect(150, 400, 60, 30);
  });
}

function widthScaleOf(element: HTMLElement): number {
  return Number(element.style.scale.split(" ")[0] || 1);
}

/** Records whether any element ever had an inline clip-path written, even for a single frame. */
function watchForClips(): () => boolean {
  let seen = false;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target instanceof HTMLElement && record.target.style.clipPath !== "") seen = true;
    }
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ["style"], subtree: true });
  return () => {
    observer.takeRecords().forEach((record) => {
      if (record.target instanceof HTMLElement && record.target.style.clipPath !== "") seen = true;
    });
    observer.disconnect();
    return seen;
  };
}

function SearchPopover({ genie }: { readonly genie: boolean }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<PopoverRootActions | null>(null);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      actionsRef={actionsRef}
      motion={genie ? { kind: "genie", origin: () => triggerRef.current } : undefined}
    >
      <PopoverTrigger ref={triggerRef}>Model</PopoverTrigger>
      <PopoverContent aria-label="Models" role="dialog">
        <input aria-label="Search models" autoFocus />
        <button type="button" onClick={() => actionsRef.current?.close()}>
          Pick
        </button>
      </PopoverContent>
    </Popover>
  );
}

type Part = "model" | "access";

function SwitchingPopover() {
  const [handle] = useState(() => PopoverPrimitive.createHandle<Part>());
  const [part, setPart] = useState<Part | null>(null);
  const triggers = useRef(new Map<Part, HTMLElement>());
  const lastPart = useRef<Part>("model");
  if (part) lastPart.current = part;
  const trigger = (name: Part, label: string) => (
    <PopoverTrigger
      handle={handle}
      id={name}
      payload={name}
      ref={(element: HTMLElement | null) => {
        if (element) triggers.current.set(name, element);
      }}
    >
      {label}
    </PopoverTrigger>
  );
  return (
    <>
      {trigger("model", "Model")}
      {trigger("access", "Access")}
      <Popover
        handle={handle}
        open={part !== null}
        triggerId={part}
        onOpenChange={(next, details) => {
          const opened = details.trigger?.id;
          setPart(next && (opened === "model" || opened === "access") ? opened : null);
        }}
        motion={{ kind: "genie", origin: () => triggers.current.get(lastPart.current) ?? null }}
      >
        <PopoverContent aria-label="Settings" role="dialog">
          {part}
        </PopoverContent>
      </Popover>
    </>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  frames = new Map();
  now = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrameId, callback);
    return nextFrameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  stubReducedMotion(false);
  // jsdom lays nothing out; the Genie skips popups with no size.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 200, 240));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Popover genie motion", () => {
  it("pours the real popup out of the trigger and leaves it unclipped and visible under StrictMode", () => {
    render(
      <StrictMode>
        <SearchPopover genie />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    for (let i = 0; i < 16; i++) frame();

    const popup = realPopup();
    expect(popup).not.toBeNull();
    expect(popup?.style.clipPath).toBe("");
    expect(popup?.style.transform).toBe("");
    expect(popup?.style.opacity).toBe("");
  });

  it("clips the popup before its first frame, reshapes it each frame, and clears the clip when done", () => {
    render(<SearchPopover genie />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));

    expect(screen.getByRole("textbox", { name: "Search models" })).toHaveFocus();
    expect(clipOf(realPopup())).not.toBe("");
    frame(0);
    frame();
    const early = clipOf(realPopup());
    frame();
    expect(clipOf(realPopup())).not.toBe(early);

    for (let i = 0; i < 16; i++) frame();
    expect(clipOf(realPopup())).toBe("");
    expect(realPopup()?.style.transform).toBe("");
  });

  it("squeezes the popup's rows into the trigger while it pours either way, and leaves them untouched while open", () => {
    stubPopupWithRows();
    render(<SearchPopover genie />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const row = screen.getByRole("button", { name: "Pick" });
    frame(0);
    frame(GENIE_OPEN_MS / 2);
    expect(widthScaleOf(row)).toBeLessThan(1);

    for (let i = 0; i < 16; i++) frame();
    expect(row.style.scale).toBe("");
    expect(row.style.translate).toBe("");

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search models" }), { key: "Escape" });
    frame(0);
    frame(GENIE_CLOSE_MS / 2);
    expect(widthScaleOf(row)).toBeLessThan(1);
  });

  it("aims the pour at the trigger from where the popup lands, not where it first mounts", () => {
    // Base UI places the popup after it mounts; until then it sits at the page's top-left corner.
    let placed = false;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.slot !== "popover-content") return new DOMRect(150, 400, 60, 30);
      return placed ? new DOMRect(100, 100, 200, 240) : new DOMRect(0, 0, 200, 240);
    });
    render(<SearchPopover genie />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    placed = true;
    frame(0);

    // Folded, the popup has slid down by the distance from its top edge to the trigger's centre.
    expect(realPopup()?.style.transform).toBe("translateY(315.0px)");
  });

  it("stops pouring from a trigger the popover has switched away from", () => {
    render(<SwitchingPopover />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    frame(0);
    frame();
    expect(clipOf(realPopup())).not.toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Access" }));
    frame();
    expect(clipOf(realPopup())).toBe("");
    expect(realPopup()?.style.transform).toBe("");
  });

  it("ends the pour at once when the user types", () => {
    render(<SearchPopover genie />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    frame();

    const search = screen.getByRole("textbox", { name: "Search models" });
    fireEvent.input(search, { target: { value: "opus" } });
    expect(search).toHaveValue("opus");
    expect(clipOf(realPopup())).toBe("");
    expect(realPopup()?.style.transform).toBe("");
  });

  it("keeps a closing popup mounted for the pour back, then unmounts it", () => {
    render(<SearchPopover genie />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    for (let i = 0; i < 16; i++) frame();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search models" }), { key: "Escape" });
    frame(0);
    frame(GENIE_CLOSE_MS - 1);
    expect(realPopup()).toBeInTheDocument();
    expect(clipOf(realPopup())).not.toBe("");

    frame(1);
    expect(realPopup()).not.toBeInTheDocument();
  });

  it("pours back when a pick closes the popup through the root's actions", () => {
    render(<SearchPopover genie />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    for (let i = 0; i < 16; i++) frame();

    fireEvent.click(screen.getByRole("button", { name: "Pick" }));
    frame(0);
    frame(GENIE_CLOSE_MS - 1);
    expect(realPopup()).toBeInTheDocument();
    expect(clipOf(realPopup())).not.toBe("");

    frame(1);
    expect(realPopup()).not.toBeInTheDocument();
  });

  it("never clips the popup under reduced motion and closes at once", () => {
    stubReducedMotion(true);
    const sawClip = watchForClips();
    render(<SearchPopover genie />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    for (let i = 0; i < 4; i++) frame();
    expect(screen.getByRole("dialog", { name: "Models" })).not.toHaveStyle({ opacity: "0" });

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search models" }), { key: "Escape" });
    for (let i = 0; i < 4; i++) frame();
    expect(realPopup()).not.toBeInTheDocument();
    expect(sawClip()).toBe(false);
  });

  it("leaves a popover without a motion prop on its plain fade", () => {
    const sawClip = watchForClips();
    render(<SearchPopover genie={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    for (let i = 0; i < 4; i++) frame();
    expect(screen.getByRole("dialog", { name: "Models" })).not.toHaveStyle({ opacity: "0" });

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search models" }), { key: "Escape" });
    expect(realPopup()).not.toBeInTheDocument();
    expect(sawClip()).toBe(false);
  });
});
