import { createRef } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
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
          <ComposerOverlaySurface ref={ref} anchorRect={anchorRect} estimatedHeight={40} attached>
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
          <ComposerOverlaySurface anchorRect={anchorRect} estimatedHeight={40} attached>
            First notice{details && <p>Expanded details</p>}
          </ComposerOverlaySurface>
        </ComposerOverlayLayout>
        <ComposerOverlayLayout>
          <ComposerOverlaySurface anchorRect={anchorRect} estimatedHeight={40} attached>
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

  it("preserves fixed positioning outside the composer layout", () => {
    render(<ComposerOverlaySurface anchorRect={anchorRect} estimatedHeight={40} attached>
      Standalone notice
    </ComposerOverlaySurface>);
    const surface = screen.getByText("Standalone notice");
    expect(surface.parentElement).toBe(document.body);
    expect(surface.style.position).toBe("fixed");
  });

  it("keeps non-attached popups out of the composer layout", () => {
    render(<ComposerOverlayLayout>
      <ComposerOverlaySurface anchorRect={anchorRect} estimatedHeight={40}>
        Floating picker
      </ComposerOverlaySurface>
    </ComposerOverlayLayout>);
    expect(screen.getByText("Floating picker").parentElement).toBe(document.body);
    expect(screen.getByTestId("composer-overlay-host").childElementCount).toBe(0);
  });
});
