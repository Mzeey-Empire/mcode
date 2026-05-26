/**
 * Unit tests for PreviewToolbar.
 *
 * PreviewToolbar is a pure presentational component: all state and handlers
 * are passed as props, making it straightforward to test in isolation.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PreviewToolbar,
  type PreviewToolbarProps,
} from "../PreviewToolbar";

/** Builds a complete set of default props, with optional overrides. */
function defaultProps(
  overrides: Partial<PreviewToolbarProps> = {},
): PreviewToolbarProps {
  return {
    canBack: false,
    canFwd: false,
    captureBusy: false,
    regionBusy: false,
    elementPickBusy: false,
    contextBusy: false,
    anyCaptureActive: false,
    threadId: "test-thread",
    designModeActive: false,
    devDockOpen: false,
    devDockEdge: "bottom",
    onGoBack: vi.fn(),
    onGoForward: vi.fn(),
    onReload: vi.fn(),
    onOpenExternal: vi.fn(),
    onAddPictureReference: vi.fn(),
    onToggleDesign: vi.fn(),
    onExitDesignMode: vi.fn(),
    onToggleDevDock: vi.fn(),
    onAddRegionPictureReference: vi.fn(),
    onAddElementPickPictureReference: vi.fn(),
    onAddPageContextOnly: vi.fn(),
    ...overrides,
  };
}

describe("PreviewToolbar -primary buttons rendered", () => {
  it("renders the Back button", () => {
    render(<PreviewToolbar {...defaultProps()} />);
    expect(screen.getByLabelText("Back")).toBeInTheDocument();
  });

  it("renders the Forward button", () => {
    render(<PreviewToolbar {...defaultProps()} />);
    expect(screen.getByLabelText("Forward")).toBeInTheDocument();
  });

  it("renders the Reload button", () => {
    render(<PreviewToolbar {...defaultProps()} />);
    expect(screen.getByLabelText("Reload")).toBeInTheDocument();
  });

  it("renders the Open in system browser button", () => {
    render(<PreviewToolbar {...defaultProps()} />);
    expect(screen.getByLabelText("Open in system browser")).toBeInTheDocument();
  });

  it("renders the Design button", () => {
    render(<PreviewToolbar {...defaultProps()} />);
    expect(screen.getByLabelText("Design")).toBeInTheDocument();
  });

  it("renders the Screenshot button", () => {
    render(<PreviewToolbar {...defaultProps()} />);
    expect(screen.getByLabelText("Screenshot")).toBeInTheDocument();
  });

  it("renders the Toggle capture tools button", () => {
    render(<PreviewToolbar {...defaultProps()} />);
    expect(screen.getByLabelText("Toggle capture tools")).toBeInTheDocument();
  });
});

describe("PreviewToolbar -legacy buttons removed", () => {
  it("no longer renders the Crop region button", () => {
    render(<PreviewToolbar {...defaultProps()} />);
    expect(screen.queryByLabelText("Crop region")).not.toBeInTheDocument();
  });

  it("no longer renders the Pick element button", () => {
    render(<PreviewToolbar {...defaultProps()} />);
    expect(screen.queryByLabelText("Pick element")).not.toBeInTheDocument();
  });

  it("no longer renders the Capture viewport button", () => {
    render(<PreviewToolbar {...defaultProps()} />);
    expect(screen.queryByLabelText("Capture viewport")).not.toBeInTheDocument();
  });

  it("no longer renders the Attach page context button", () => {
    render(<PreviewToolbar {...defaultProps()} />);
    expect(screen.queryByLabelText("Attach page context")).not.toBeInTheDocument();
  });
});

describe("PreviewToolbar -Back/Forward enabled state", () => {
  it("disables Back when canBack is false", () => {
    render(<PreviewToolbar {...defaultProps({ canBack: false })} />);
    expect(screen.getByLabelText("Back")).toBeDisabled();
  });

  it("enables Back when canBack is true", () => {
    render(<PreviewToolbar {...defaultProps({ canBack: true })} />);
    expect(screen.getByLabelText("Back")).not.toBeDisabled();
  });

  it("disables Forward when canFwd is false", () => {
    render(<PreviewToolbar {...defaultProps({ canFwd: false })} />);
    expect(screen.getByLabelText("Forward")).toBeDisabled();
  });

  it("enables Forward when canFwd is true", () => {
    render(<PreviewToolbar {...defaultProps({ canFwd: true })} />);
    expect(screen.getByLabelText("Forward")).not.toBeDisabled();
  });
});

describe("PreviewToolbar -Design button state", () => {
  it("is not pressed when designModeActive and elementPickBusy are both false", () => {
    render(<PreviewToolbar {...defaultProps()} />);
    expect(screen.getByLabelText("Design")).toHaveAttribute("aria-pressed", "false");
  });

  it("is pressed when designModeActive is true", () => {
    render(<PreviewToolbar {...defaultProps({ designModeActive: true })} />);
    expect(screen.getByLabelText("Design")).toHaveAttribute("aria-pressed", "true");
  });

  it("is pressed when elementPickBusy is true", () => {
    render(<PreviewToolbar {...defaultProps({ elementPickBusy: true })} />);
    expect(screen.getByLabelText("Design")).toHaveAttribute("aria-pressed", "true");
  });

  it("is disabled when threadId is empty", () => {
    render(<PreviewToolbar {...defaultProps({ threadId: "" })} />);
    expect(screen.getByLabelText("Design")).toBeDisabled();
  });
});

describe("PreviewToolbar -Screenshot disabled while other captures in flight", () => {
  it("disables Screenshot when captureBusy is true", () => {
    render(<PreviewToolbar {...defaultProps({ captureBusy: true })} />);
    expect(screen.getByLabelText("Screenshot")).toBeDisabled();
  });

  it("disables Screenshot when regionBusy is true", () => {
    render(<PreviewToolbar {...defaultProps({ regionBusy: true })} />);
    expect(screen.getByLabelText("Screenshot")).toBeDisabled();
  });

  it("disables Screenshot when elementPickBusy is true", () => {
    render(<PreviewToolbar {...defaultProps({ elementPickBusy: true })} />);
    expect(screen.getByLabelText("Screenshot")).toBeDisabled();
  });

  it("disables Screenshot when threadId is empty", () => {
    render(<PreviewToolbar {...defaultProps({ threadId: "" })} />);
    expect(screen.getByLabelText("Screenshot")).toBeDisabled();
  });
});

describe("PreviewToolbar -Dev dock toggle state", () => {
  it("aria-pressed reflects devDockOpen=false", () => {
    render(<PreviewToolbar {...defaultProps({ devDockOpen: false })} />);
    expect(screen.getByLabelText("Toggle capture tools")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("aria-pressed reflects devDockOpen=true", () => {
    render(<PreviewToolbar {...defaultProps({ devDockOpen: true })} />);
    expect(screen.getByLabelText("Toggle capture tools")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("PreviewToolbar -click handlers", () => {
  let props: PreviewToolbarProps;

  beforeEach(() => {
    props = defaultProps({ canBack: true, canFwd: true });
  });

  it("calls onGoBack when Back is clicked", () => {
    render(<PreviewToolbar {...props} />);
    fireEvent.click(screen.getByLabelText("Back"));
    expect(props.onGoBack).toHaveBeenCalledOnce();
  });

  it("calls onGoForward when Forward is clicked", () => {
    render(<PreviewToolbar {...props} />);
    fireEvent.click(screen.getByLabelText("Forward"));
    expect(props.onGoForward).toHaveBeenCalledOnce();
  });

  it("calls onReload when Reload is clicked", () => {
    render(<PreviewToolbar {...props} />);
    fireEvent.click(screen.getByLabelText("Reload"));
    expect(props.onReload).toHaveBeenCalledOnce();
  });

  it("calls onOpenExternal when Open in system browser is clicked", () => {
    render(<PreviewToolbar {...props} />);
    fireEvent.click(screen.getByLabelText("Open in system browser"));
    expect(props.onOpenExternal).toHaveBeenCalledOnce();
  });

  it("calls onToggleDesign when Design is clicked", () => {
    render(<PreviewToolbar {...props} />);
    fireEvent.click(screen.getByLabelText("Design"));
    expect(props.onToggleDesign).toHaveBeenCalledOnce();
  });

  it("calls onAddPictureReference when Screenshot is clicked", () => {
    render(<PreviewToolbar {...props} />);
    fireEvent.click(screen.getByLabelText("Screenshot"));
    expect(props.onAddPictureReference).toHaveBeenCalledOnce();
  });

  it("calls onToggleDevDock when Toggle capture tools is clicked", () => {
    render(<PreviewToolbar {...props} />);
    fireEvent.click(screen.getByLabelText("Toggle capture tools"));
    expect(props.onToggleDevDock).toHaveBeenCalledOnce();
  });
});

describe("PreviewToolbar -cancel/design pill visibility", () => {
  it("shows Cancel pill when regionBusy is true", () => {
    render(<PreviewToolbar {...defaultProps({ regionBusy: true })} />);
    expect(screen.getByLabelText("Cancel capture")).toBeInTheDocument();
  });

  it("shows Design (exit) pill when designModeActive is true", () => {
    render(<PreviewToolbar {...defaultProps({ designModeActive: true })} />);
    expect(screen.getByLabelText("Exit design mode")).toBeInTheDocument();
  });

  it("does not show Design pill on elementPickBusy alone (mode owns visibility now)", () => {
    render(<PreviewToolbar {...defaultProps({ elementPickBusy: true })} />);
    expect(screen.queryByLabelText("Exit design mode")).not.toBeInTheDocument();
  });

  it("hides both pills when no mode/capture is active", () => {
    render(
      <PreviewToolbar
        {...defaultProps({
          regionBusy: false,
          elementPickBusy: false,
          designModeActive: false,
        })}
      />,
    );
    expect(screen.queryByLabelText("Cancel capture")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Exit design mode")).not.toBeInTheDocument();
  });

  it("prefers Design pill when both designModeActive and regionBusy are true", () => {
    render(
      <PreviewToolbar
        {...defaultProps({ designModeActive: true, regionBusy: true })}
      />,
    );
    expect(screen.getByLabelText("Exit design mode")).toBeInTheDocument();
    expect(screen.queryByLabelText("Cancel capture")).not.toBeInTheDocument();
  });

  it("calls onExitDesignMode when the Design (exit) pill is clicked", () => {
    const onExit = vi.fn();
    render(
      <PreviewToolbar
        {...defaultProps({ designModeActive: true, onExitDesignMode: onExit })}
      />,
    );
    fireEvent.click(screen.getByLabelText("Exit design mode"));
    expect(onExit).toHaveBeenCalledOnce();
  });
});
