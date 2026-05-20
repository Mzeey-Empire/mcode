import { render } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getScrollAnchor,
  isScrollPinned,
} from "@/components/terminal/terminalScrollState";
import { releaseWebglSlot } from "@/components/terminal/terminalWebglSlot";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
}

const bufferActive = { viewportY: 0, length: 200 };

const term = {
  options: { scrollback: 1000 },
  buffer: { active: bufferActive },
  cols: 80,
  rows: 24,
  loadAddon: vi.fn(),
  open: vi.fn(),
  attachCustomKeyEventHandler: vi.fn(),
  getSelection: vi.fn(() => ""),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onScroll: vi.fn(() => ({ dispose: vi.fn() })),
  write: vi.fn((_data: string, cb?: () => void) => cb?.()),
  paste: vi.fn(),
  refresh: vi.fn(),
  focus: vi.fn(),
  scrollToLine: vi.fn((line: number) => {
    bufferActive.viewportY = line;
  }),
  dispose: vi.fn(),
};

const transport = {
  terminalWrite: vi.fn(() => Promise.resolve()),
  terminalResize: vi.fn(() => Promise.resolve()),
  terminalResume: vi.fn(() => Promise.resolve()),
  terminalPause: vi.fn(() => Promise.resolve()),
  ptySetLastSeq: vi.fn(),
  ptyDeleteLastSeq: vi.fn(),
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
  return { ...actual, getTransport: () => transport };
});

import { TerminalView } from "@/components/terminal/TerminalView";

/** Flushes React effects and chained requestAnimationFrame callbacks. */
async function flushFrames(count = 4): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("TerminalView scroll on workspace thread switch (simulated)", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.useFakeTimers();
    bufferActive.viewportY = 50;
    bufferActive.length = 200;
    term.scrollToLine.mockClear();
    term.refresh.mockClear();
    term.focus.mockClear();
    releaseWebglSlot("pty-a");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("saved anchor survives hide (thread inactive) and restores on show", async () => {
    const { rerender } = render(
      <TerminalView ptyId="pty-a" visible={true} threadActive={true} />,
    );
    await flushFrames(6);

    // User scrolled up (simulated).
    await act(async () => {
      bufferActive.viewportY = 42;
      term.scrollToLine(42);
    });

    await act(async () => {
      rerender(<TerminalView ptyId="pty-a" visible={false} threadActive={false} />);
    });

    const anchor = getScrollAnchor("pty-a");
    expect(anchor).toBeDefined();
    expect(anchor?.viewportY).toBe(42);
    expect(anchor?.linesFromBottom).toBe(200 - 42 - 24);
    expect(isScrollPinned("pty-a")).toBe(true);

    term.scrollToLine.mockClear();
    term.refresh.mockClear();
    term.focus.mockClear();

    await act(async () => {
      rerender(<TerminalView ptyId="pty-a" visible={true} threadActive={true} />);
    });
    await flushFrames(6);
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(term.scrollToLine).toHaveBeenCalledWith(42);
    expect(term.refresh).not.toHaveBeenCalled();
    expect(term.focus).not.toHaveBeenCalled();
    expect(isScrollPinned("pty-a")).toBe(true);
  });
});
