import { mockTransport } from "@/__tests__/mocks/transport";
import { render } from "@testing-library/react";
import { act } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getDefaultSettings } from "@mcode/contracts/models/settings";
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
  terminalCreate: vi.mocked(mockTransport.terminalCreate),
  terminalKill: vi.mocked(mockTransport.terminalKill),
  terminalWrite: vi.mocked(mockTransport.terminalWrite),
  terminalResize: vi.mocked(mockTransport.terminalResize),
  terminalPause: vi.mocked(mockTransport.terminalPause),
  terminalResume: vi.mocked(mockTransport.terminalResume),
  terminalSubscribe: vi.mocked(mockTransport.terminalSubscribe),
  terminalDetachForSwitch: vi.mocked(mockTransport.terminalDetachForSwitch),
  terminalReattach: vi.mocked(mockTransport.terminalReattach),
  terminalCheckpoint: vi.mocked(mockTransport.terminalCheckpoint),
  ptySetLastSeq: vi.mocked(mockTransport.ptySetLastSeq),
  ptyDeleteLastSeq: vi.mocked(mockTransport.ptyDeleteLastSeq),
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
  return { ...actual, getTransport: () => mockTransport };
});

beforeEach(() => {
  vi.mocked(mockTransport.terminalCreate).mockReset();
  vi.mocked(mockTransport.terminalKill).mockReset().mockImplementation(() => Promise.resolve());
  vi.mocked(mockTransport.terminalWrite).mockReset().mockImplementation(() => Promise.resolve());
  vi.mocked(mockTransport.terminalResize).mockReset().mockImplementation(() => Promise.resolve());
  vi.mocked(mockTransport.terminalPause).mockReset().mockImplementation(() => Promise.resolve());
  vi.mocked(mockTransport.terminalResume).mockReset().mockImplementation(() => Promise.resolve());
  vi.mocked(mockTransport.terminalSubscribe).mockReset().mockImplementation((ptyId: string, subscription: {
    onData?: (event: { ptyId: string; payload: Uint8Array; seq: number }) => void;
  }) => {
    const unsubscribe = subscription.onData ? onPtyData(ptyId, subscription.onData) : undefined;
    return () => unsubscribe?.();
  });
  vi.mocked(mockTransport.terminalDetachForSwitch).mockReset().mockImplementation(() => Promise.resolve());
  vi.mocked(mockTransport.terminalReattach).mockReset().mockImplementation(() => Promise.resolve({ mode: "delta" }));
  vi.mocked(mockTransport.terminalCheckpoint).mockReset().mockImplementation((_ptyId: string, _seq: number, _data: string) =>
    Promise.resolve({ accepted: true }));
  vi.mocked(mockTransport.ptySetLastSeq).mockReset();
  vi.mocked(mockTransport.ptyDeleteLastSeq).mockReset();
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
