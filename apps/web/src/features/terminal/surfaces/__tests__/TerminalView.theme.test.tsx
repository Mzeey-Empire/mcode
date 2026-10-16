import { render, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getDefaultSettings } from "@mcode/contracts";
import { useSettingsStore } from "@/stores/settingsStore";
import { dropRemountAnchor } from "../terminalRemountScroll";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
}


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
  write: vi.fn((_data: string | Uint8Array, cb?: () => void) => cb?.()),
  paste: vi.fn(),
  clear: vi.fn(),
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
  terminalSubscribe: vi.fn(() => () => {}),
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
    serialize = vi.fn(() => "");
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


const PALETTES = {
  light: { "--page": "oklch(95.5% 0.005 260)", "--ink": "oklch(19% 0.005 260)" },
  dark: { "--page": "oklch(18% 0.005 260)", "--ink": "oklch(92% 0.005 260)" },
} as const;

function applyPalette(mode: keyof typeof PALETTES): void {
  const root = document.documentElement;
  root.classList.toggle("dark", mode === "dark");
  for (const [token, value] of Object.entries(PALETTES[mode])) root.style.setProperty(token, value);
}

describe("TerminalView theme", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const token of ["--success", "--primary", "--error", "--link"]) {
      document.documentElement.style.setProperty(token, "oklch(50% 0.1 260)");
    }
    applyPalette("light");
    dropRemountAnchor("pty-theme");
    useSettingsStore.setState({ settings: getDefaultSettings(), loaded: true });
  });

  it("recolours the open terminal when the app theme flips, without remounting it", async () => {
    render(<TerminalView ptyId="pty-theme" visible={true} threadActive={true} />);
    await settle();
    expect(term.options.theme).toMatchObject({ background: PALETTES.light["--page"] });

    applyPalette("dark");
    await waitFor(() => {
      expect(term.options.theme).toMatchObject({
        background: PALETTES.dark["--page"],
        foreground: PALETTES.dark["--ink"],
      });
    });
    expect(term.dispose).not.toHaveBeenCalled();
    expect(term.open).toHaveBeenCalledTimes(1);
  });
});
