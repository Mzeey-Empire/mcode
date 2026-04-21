import { render } from "@testing-library/react";
import { act } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";

// jsdom doesn't implement ResizeObserver; TerminalView instantiates one in
// its mount effect. A no-op stub is enough — fit is exercised via the
// visibility effects, not the observer.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
}

// Shared xterm term instance observable from the tests. We focus on the
// .focus() call because that's the one that can steal input from the
// composer — fit and refresh are idempotent repaints.
const term = {
  options: { scrollback: 0 },
  loadAddon: vi.fn(),
  open: vi.fn(),
  attachCustomKeyEventHandler: vi.fn(),
  getSelection: vi.fn(() => ""),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  write: vi.fn(),
  paste: vi.fn(),
  clear: vi.fn(),
  refresh: vi.fn(),
  focus: vi.fn(),
  dispose: vi.fn(),
  rows: 24,
};

const transport = {
  terminalWrite: vi.fn(() => Promise.resolve()),
  terminalResize: vi.fn(() => Promise.resolve()),
  terminalResume: vi.fn(() => Promise.resolve()),
};

vi.mock("@xterm/xterm", () => {
  class Terminal {
    constructor() {
      return term as unknown as Terminal;
    }
  }
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => {
  class FitAddon {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
  }
  return { FitAddon };
});

vi.mock("@/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/transport")>();
  return {
    ...actual,
    getTransport: () => transport,
  };
});

import { TerminalView } from "@/components/terminal/TerminalView";

describe("TerminalView focus behaviour (regression)", () => {
  beforeEach(() => {
    term.focus.mockClear();
    term.refresh.mockClear();
    transport.terminalResume.mockClear();
  });

  // Regression guard: term.focus() must NOT fire when the window/tab
  // regains visibility. The user may be typing in the composer when the
  // app returns to the foreground — stealing focus into xterm would
  // contradict commit 09e0a3e (Ctrl+J from composer).
  it("does not call term.focus() on document visibilitychange", async () => {
    await act(async () => {
      render(<TerminalView ptyId="pty-1" visible={true} />);
    });
    // Let the async dynamic imports in init() settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const focusCallsBefore = term.focus.mock.calls.length;

    // Simulate return-from-background.
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });

    expect(term.focus.mock.calls.length).toBe(focusCallsBefore);
    // Repaint still happens so half-painted output recovers.
    expect(term.refresh).toHaveBeenCalled();
  });

  it("resumes a newly-created PTY after the view mounts", async () => {
    await act(async () => {
      render(<TerminalView ptyId="pty-1" visible={true} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(transport.terminalResume).toHaveBeenCalledWith("pty-1");
  });

  it("does NOT resume when mounted hidden", async () => {
    await act(async () => {
      render(<TerminalView ptyId="pty-1" visible={false} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(transport.terminalResume).not.toHaveBeenCalled();
  });
});
