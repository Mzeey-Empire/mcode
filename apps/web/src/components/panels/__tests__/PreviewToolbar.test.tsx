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
    onGoBack: vi.fn(),
    onGoForward: vi.fn(),
    onReload: vi.fn(),
    onOpenExternal: vi.fn(),
    onAddPictureReference: vi.fn(),
    onAddRegionPictureReference: vi.fn(),
    onAddElementPickPictureReference: vi.fn(),
    onAddPageContextOnly: vi.fn(),
    ...overrides,
  };
}

describe("PreviewToolbar — toolbar buttons rendered", () => {
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

  it("renders the Crop region button", () => {
    render(<PreviewToolbar {...defaultProps()} />);
    expect(screen.getByLabelText("Crop region")).toBeInTheDocument();
  });

  it("renders the Pick element button", () => {
    render(<PreviewToolbar {...defaultProps()} />);
    expect(screen.getByLabelText("Pick element")).toBeInTheDocument();
  });

  it("renders the Capture viewport button", () => {
    render(<PreviewToolbar {...defaultProps()} />);
    expect(screen.getByLabelText("Capture viewport")).toBeInTheDocument();
  });

  it("renders the Attach page context button", () => {
    render(<PreviewToolbar {...defaultProps()} />);
    expect(screen.getByLabelText("Attach page context")).toBeInTheDocument();
  });
});

describe("PreviewToolbar — Back/Forward enabled state", () => {
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

describe("PreviewToolbar — capture buttons disabled during active capture", () => {
  it("disables Crop region when anyCaptureActive is true", () => {
    render(<PreviewToolbar {...defaultProps({ anyCaptureActive: true })} />);
    expect(screen.getByLabelText("Crop region")).toBeDisabled();
  });

  it("disables Pick element when anyCaptureActive is true", () => {
    render(<PreviewToolbar {...defaultProps({ anyCaptureActive: true })} />);
    expect(screen.getByLabelText("Pick element")).toBeDisabled();
  });

  it("disables Capture viewport when anyCaptureActive is true", () => {
    render(<PreviewToolbar {...defaultProps({ anyCaptureActive: true })} />);
    expect(screen.getByLabelText("Capture viewport")).toBeDisabled();
  });

  it("disables Attach page context when anyCaptureActive is true", () => {
    render(<PreviewToolbar {...defaultProps({ anyCaptureActive: true })} />);
    expect(screen.getByLabelText("Attach page context")).toBeDisabled();
  });

  it("enables capture buttons when anyCaptureActive is false", () => {
    render(<PreviewToolbar {...defaultProps({ anyCaptureActive: false })} />);
    expect(screen.getByLabelText("Crop region")).not.toBeDisabled();
    expect(screen.getByLabelText("Pick element")).not.toBeDisabled();
    expect(screen.getByLabelText("Capture viewport")).not.toBeDisabled();
    expect(screen.getByLabelText("Attach page context")).not.toBeDisabled();
  });
});

describe("PreviewToolbar — click handlers", () => {
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

  it("calls onAddRegionPictureReference when Crop region is clicked", () => {
    render(<PreviewToolbar {...props} />);
    fireEvent.click(screen.getByLabelText("Crop region"));
    expect(props.onAddRegionPictureReference).toHaveBeenCalledOnce();
  });

  it("calls onAddElementPickPictureReference when Pick element is clicked", () => {
    render(<PreviewToolbar {...props} />);
    fireEvent.click(screen.getByLabelText("Pick element"));
    expect(props.onAddElementPickPictureReference).toHaveBeenCalledOnce();
  });

  it("calls onAddPictureReference when Capture viewport is clicked", () => {
    render(<PreviewToolbar {...props} />);
    fireEvent.click(screen.getByLabelText("Capture viewport"));
    expect(props.onAddPictureReference).toHaveBeenCalledOnce();
  });

  it("calls onAddPageContextOnly when Attach page context is clicked", () => {
    render(<PreviewToolbar {...props} />);
    fireEvent.click(screen.getByLabelText("Attach page context"));
    expect(props.onAddPageContextOnly).toHaveBeenCalledOnce();
  });
});

describe("PreviewToolbar — cancel/design pill visibility", () => {
  it("shows Cancel pill when regionBusy is true", () => {
    render(<PreviewToolbar {...defaultProps({ regionBusy: true })} />);
    expect(screen.getByLabelText("Cancel capture")).toBeInTheDocument();
  });

  it("shows Design pill when elementPickBusy is true", () => {
    render(<PreviewToolbar {...defaultProps({ elementPickBusy: true })} />);
    expect(screen.getByLabelText("Exit design mode")).toBeInTheDocument();
  });

  it("hides both pills when no capture is active", () => {
    render(
      <PreviewToolbar
        {...defaultProps({ regionBusy: false, elementPickBusy: false })}
      />,
    );
    expect(screen.queryByLabelText("Cancel capture")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Exit design mode")).not.toBeInTheDocument();
  });

  it("prefers Design pill when both regionBusy and elementPickBusy are true", () => {
    render(
      <PreviewToolbar
        {...defaultProps({ regionBusy: true, elementPickBusy: true })}
      />,
    );
    expect(screen.getByLabelText("Exit design mode")).toBeInTheDocument();
    expect(screen.queryByLabelText("Cancel capture")).not.toBeInTheDocument();
  });
});
