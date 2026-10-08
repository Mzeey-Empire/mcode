import { createRef } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ComposerOverlayLayout, ComposerOverlaySurface } from "../ComposerOverlaySurface";

afterEach(cleanup);

const anchorRect = new DOMRect(100, 500, 600, 120);

describe("composer overlay layout", () => {
  it("places nested attached content before the editor in normal flow and forwards its ref", () => {
    const ref = createRef<HTMLDivElement>();
    const { rerender } = render(
      <ComposerOverlayLayout>
        <div data-testid="editor">
          <ComposerOverlaySurface ref={ref} anchorRect={anchorRect} attached>
            Notice
          </ComposerOverlaySurface>
        </div>
      </ComposerOverlayLayout>,
    );
    const host = screen.getByTestId("composer-overlay-host");
    expect(within(host).getByText("Notice")).toBe(ref.current);
    expect(ref.current?.style.position).toBe("");
    expect(host.nextElementSibling).toBe(screen.getByTestId("editor"));

    rerender(<ComposerOverlayLayout><div data-testid="editor" /></ComposerOverlayLayout>);
    expect(host.childElementCount).toBe(0);
    expect(ref.current).toBeNull();
  });

  it("keeps simultaneous composers and their changing content separate", () => {
    function Composers({ details }: { details: boolean }) {
      return <>
        <ComposerOverlayLayout>
          <ComposerOverlaySurface anchorRect={anchorRect} attached>
            First notice{details && <p>Expanded details</p>}
          </ComposerOverlaySurface>
        </ComposerOverlayLayout>
        <ComposerOverlayLayout>
          <ComposerOverlaySurface anchorRect={anchorRect} attached>
            Second notice
          </ComposerOverlaySurface>
        </ComposerOverlayLayout>
      </>;
    }
    const { rerender } = render(<Composers details={false} />);
    const [first, second] = screen.getAllByTestId("composer-overlay-host");
    rerender(<Composers details />);
    expect(within(first).getByText("Expanded details")).toBeTruthy();
    expect(within(second).queryByText("Expanded details")).toBeNull();
    expect(within(second).getByText("Second notice")).toBeTruthy();
  });

  it("floats above its anchor as a popover outside the composer layout", async () => {
    render(<ComposerOverlaySurface anchorRect={anchorRect} attached>
      Standalone notice
    </ComposerOverlaySurface>);
    const surface = screen.getByText("Standalone notice");
    expect(surface).toHaveAttribute("data-slot", "popover-content");
    await waitFor(() => expect(surface.parentElement).toHaveAttribute("data-side", "top"));
  });

  it("keeps non-attached popups out of the composer layout without taking focus", () => {
    render(<ComposerOverlayLayout>
      <input aria-label="Editor" autoFocus />
      <ComposerOverlaySurface anchorRect={anchorRect}>
        Floating picker
      </ComposerOverlaySurface>
    </ComposerOverlayLayout>);
    expect(screen.getByText("Floating picker")).toHaveAttribute("data-slot", "popover-content");
    expect(screen.getByTestId("composer-overlay-host").childElementCount).toBe(0);
    expect(screen.getByRole("textbox", { name: "Editor" })).toHaveFocus();
  });
});
