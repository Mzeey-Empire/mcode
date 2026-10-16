import { render } from "@testing-library/react";
import { act } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getDefaultSettings } from "@mcode/contracts";
import { useSettingsStore } from "@/stores/settingsStore";
import { emitPtyData, onPtyData } from "@/features/terminal/adapters/pty-data-registry";
import { dropRemountAnchor } from "../terminalRemountScroll";
import { dispatchTerminalClear } from "../terminalClear";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
}

let serializedScreen = "";
const OLD_SCREEN = "old-screen";
let writeCompletes: Array<() => void> = [];
let deferWrites = false;

const term = {
  options: { scrollback: 0, disableStdin: false } as Record<string, unknown>,
  element: { style: {} },
  buffer: { active: { viewportY: 0, length: 0, getLine: vi.fn() } },
  cols: 80,
  rows: 24,
  loadAddon: vi.fn(),
  open: vi.fn(),
  attachCustomKeyEventHandler: vi.fn(),
  registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
  getSelection: vi.fn(() => ""),
  hasSelection: vi.fn(() => false),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onScroll: vi.fn(() => ({ dispose: vi.fn() })),
  onSelectionChange: vi.fn(() => ({ dispose: vi.fn() })),
  write: vi.fn((_data: string | Uint8Array, cb?: () => void) => {
    if (!cb) return;
    if (deferWrites) writeCompletes.push(cb);
    else cb();
  }),
  paste: vi.fn(),
  clear: vi.fn(() => {
    serializedScreen = "cleared-state";
  }),
  refresh: vi.fn(),
  focus: vi.fn(),
  scrollToLine: vi.fn(),
  scrollToBottom: vi.fn(),
  dispose: vi.fn(),
};

const transport = {
  terminalCapabilities: vi.fn(() => Promise.resolve({ contractVersion: 1, backend: "modern" })),
  terminalCreate: vi.fn(),
  terminalKill: vi.fn(() => Promise.resolve()),
  terminalWrite: vi.fn(() => Promise.resolve()),
  terminalResize: vi.fn(() => Promise.resolve()),
  terminalPause: vi.fn(() => Promise.resolve()),
  terminalResume: vi.fn(() => Promise.resolve()),
  terminalSubscribe: vi.fn((ptyId: string, subscription: {
    onData?: (event: { ptyId: string; payload: Uint8Array; seq: number }) => void;
  }) => {
    const unsubscribe = subscription.onData ? onPtyData(ptyId, subscription.onData) : undefined;
    return () => unsubscribe?.();
  }),
  terminalDetachForSwitch: vi.fn(() => Promise.resolve()),
  terminalReattach: vi.fn(() => Promise.resolve({ mode: "delta" })),
  terminalCheckpoint: vi.fn((_ptyId: string, _seq: number, _data: string) =>
    Promise.resolve({ accepted: true })),
  ptySetLastSeq: vi.fn(),
  ptyDeleteLastSeq: vi.fn(),
};

vi.mock("@xterm/xterm", () => {
  class Terminal {
    constructor(options: Record<string, unknown>) {
      Object.assign(term.options, options);
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

vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class {
    serialize = vi.fn(() => serializedScreen);
  },
}));

vi.mock("@/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/transport")>();
  return { ...actual, getTransport: () => transport };
});

import { TerminalView } from "../TerminalView";

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function emit(ptyId: string, seq: number, text: string): void {
  act(() => emitPtyData({ ptyId, seq, payload: new TextEncoder().encode(text) }));
}

describe("TerminalView Clear", () => {
  beforeEach(() => {
    for (const token of ["--page", "--ink", "--success", "--primary", "--error", "--link"]) {
      document.documentElement.style.setProperty(token, "oklch(50% 0.1 260)");
    }
    vi.clearAllMocks();
    deferWrites = false;
    writeCompletes = [];
    serializedScreen = OLD_SCREEN;
    dropRemountAnchor("pty-clear");
    useSettingsStore.setState({ settings: getDefaultSettings(), loaded: true });
  });

  it("checkpoints the cleared screen at the last painted sequence so a remount shows only new output", async () => {
    render(<TerminalView ptyId="pty-clear" visible={true} threadActive={true} />);
    await settle();
    emit("pty-clear", 4, "old output");
    transport.terminalCheckpoint.mockClear();

    act(() => dispatchTerminalClear("pty-clear"));

    expect(term.clear).toHaveBeenCalledTimes(1);
    expect(transport.terminalCheckpoint).toHaveBeenCalledWith("pty-clear", 4, "cleared-state");
  });

  it("does not clear a different terminal", async () => {
    render(<TerminalView ptyId="pty-clear" visible={true} threadActive={true} />);
    await settle();

    act(() => dispatchTerminalClear("another-pty"));

    expect(term.clear).not.toHaveBeenCalled();
  });

  it("clears after output already queued in the parser, and keeps later output out of the checkpoint", async () => {
    render(<TerminalView ptyId="pty-clear" visible={true} threadActive={true} />);
    await settle();
    deferWrites = true;
    emit("pty-clear", 1, "queued");
    transport.terminalCheckpoint.mockClear();

    act(() => dispatchTerminalClear("pty-clear"));
    expect(term.clear).not.toHaveBeenCalled();

    emit("pty-clear", 2, "after clear");
    act(() => writeCompletes.shift()?.());
    act(() => writeCompletes.shift()?.());

    expect(term.clear).toHaveBeenCalledTimes(1);
    expect(transport.terminalCheckpoint).toHaveBeenCalledWith("pty-clear", 1, "cleared-state");
  });
});
