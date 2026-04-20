import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const setBackground = vi.fn().mockResolvedValue(undefined);

vi.mock("@/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/transport")>();
  return {
    ...actual,
    getTransport: () => ({ setBackground }),
  };
});

// threadStore.clearToolCallRecordCache is called during idle — stub the module
// so we don't pull in its ambient dependencies.
vi.mock("@/stores/threadStore", () => ({
  useThreadStore: {
    getState: () => ({ clearToolCallRecordCache: vi.fn() }),
  },
}));

import {
  useIdleReclamation,
  CLEAR_TERMINAL_BUFFERS_EVENT,
} from "@/hooks/useIdleReclamation";

describe("useIdleReclamation (regression #305)", () => {
  beforeEach(() => {
    setBackground.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Previously, after 60s of background idle the hook dispatched
  // CLEAR_TERMINAL_BUFFERS_EVENT, which wiped xterm scrollback. Users reported
  // their terminal content vanishing after leaving the app for a minute —
  // that's the bug. Server-side idle reclamation still runs; only the
  // destructive frontend buffer wipe must be gone.
  it("does not dispatch CLEAR_TERMINAL_BUFFERS_EVENT on background idle", () => {
    const listener = vi.fn();
    window.addEventListener(CLEAR_TERMINAL_BUFFERS_EVENT, listener);

    renderHook(() => useIdleReclamation());

    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(61_000);

    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(CLEAR_TERMINAL_BUFFERS_EVENT, listener);
  });

  it("still notifies the server to enter background idle", () => {
    renderHook(() => useIdleReclamation());

    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(61_000);

    expect(setBackground).toHaveBeenCalledWith(true);
  });
});
