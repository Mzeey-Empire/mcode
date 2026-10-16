import { describe, it, expect, beforeEach, vi } from "vitest";

const terminalPause = vi.fn().mockResolvedValue(undefined);

vi.mock("@/transport", () => ({
  getTransport: () => ({ terminalPause }),
}));

import { useTerminalStore } from "../terminalStore";

describe("TerminalStore", () => {
  beforeEach(() => {
    terminalPause.mockClear();
    useTerminalStore.setState({
      terminals: {},
      activeTerminalByScope: {},
      ptyToThread: {},
      splitMode: false,
    });
  });

  describe("addTerminal", () => {
    it("should add a terminal and make it the thread's active terminal", () => {
      const { addTerminal } = useTerminalStore.getState();
      addTerminal("thread-1", "pty-1");

      const state = useTerminalStore.getState();
      expect(state.terminals["thread-1"]).toHaveLength(1);
      expect(state.terminals["thread-1"]![0]!.id).toBe("pty-1");

      expect(state.activeTerminalByScope["thread-1"]).toBe("pty-1");
    });

    it("should isolate the active terminal between threads", () => {
      const { addTerminal } = useTerminalStore.getState();
      addTerminal("thread-1", "pty-1");
      addTerminal("thread-2", "pty-2");

      const { activeTerminalByScope } = useTerminalStore.getState();
      expect(activeTerminalByScope["thread-1"]).toBe("pty-1");
      expect(activeTerminalByScope["thread-2"]).toBe("pty-2");
    });

    it("adds multiple terminals to the same thread", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");
      useTerminalStore.getState().addTerminal("thread-1", "pty-2");

      const terminals = useTerminalStore.getState().terminals["thread-1"];
      expect(terminals).toHaveLength(2);
    });

    it("adds terminals to different threads independently", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");
      useTerminalStore.getState().addTerminal("thread-2", "pty-2");

      expect(useTerminalStore.getState().terminals["thread-1"]).toHaveLength(1);
      expect(useTerminalStore.getState().terminals["thread-2"]).toHaveLength(1);
    });

    it("caps one scope at eight terminal records", () => {
      for (let index = 1; index <= 9; index += 1) {
        useTerminalStore.getState().addTerminal("thread-1", `pty-${index}`);
      }

      expect(useTerminalStore.getState().terminals["thread-1"]).toHaveLength(8);
    });
  });

  describe("label generation", () => {
    it("labels first terminal as 'Terminal 1'", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");

      const terminals = useTerminalStore.getState().terminals["thread-1"];
      expect(terminals![0].label).toBe("Terminal 1");
    });

    it("labels second terminal as 'Terminal 2'", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");
      useTerminalStore.getState().addTerminal("thread-1", "pty-2");

      const terminals = useTerminalStore.getState().terminals["thread-1"];
      expect(terminals![1].label).toBe("Terminal 2");
    });

    it("fills gaps in numbering by incrementing from max", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");
      useTerminalStore.getState().addTerminal("thread-1", "pty-2");
      useTerminalStore.getState().addTerminal("thread-1", "pty-3");

      // Remove Terminal 2
      useTerminalStore.getState().removeTerminal("pty-2");

      // Add another - should be Terminal 4 (max was 3, increment)
      useTerminalStore.getState().addTerminal("thread-1", "pty-4");

      const terminals = useTerminalStore.getState().terminals["thread-1"];
      const labels = terminals!.map((t) => t.label);
      expect(labels).toContain("Terminal 4");
    });
  });

  describe("removeTerminal", () => {
    it("removes a terminal by ptyId", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");
      useTerminalStore.getState().addTerminal("thread-1", "pty-2");

      useTerminalStore.getState().removeTerminal("pty-1");

      const terminals = useTerminalStore.getState().terminals["thread-1"];
      expect(terminals).toHaveLength(1);
      expect(terminals![0].id).toBe("pty-2");
    });

    it("should set activeTerminalId to first remaining when active is removed", () => {
      const { addTerminal, removeTerminal } = useTerminalStore.getState();
      addTerminal("thread-1", "pty-1");
      addTerminal("thread-1", "pty-2");
      removeTerminal("pty-2");

      expect(useTerminalStore.getState().activeTerminalByScope["thread-1"]).toBe("pty-1");
    });

    it("should set activeTerminalId to null when last terminal removed", () => {
      const { addTerminal, removeTerminal } = useTerminalStore.getState();
      addTerminal("thread-1", "pty-1");
      removeTerminal("pty-1");

      expect(useTerminalStore.getState().activeTerminalByScope["thread-1"] ?? null).toBeNull();
    });

    it("does nothing for unknown ptyId", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");

      useTerminalStore.getState().removeTerminal("pty-unknown");

      const terminals = useTerminalStore.getState().terminals["thread-1"];
      expect(terminals).toHaveLength(1);
    });

    it("should not affect other threads", () => {
      const { addTerminal, removeTerminal } = useTerminalStore.getState();
      addTerminal("thread-1", "pty-1");
      addTerminal("thread-2", "pty-2");
      removeTerminal("pty-1");

      expect(useTerminalStore.getState().activeTerminalByScope["thread-2"]).toBe("pty-2");
    });

    it("removes terminal from correct thread when multiple threads exist", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");
      useTerminalStore.getState().addTerminal("thread-2", "pty-2");

      useTerminalStore.getState().removeTerminal("pty-1");

      expect(useTerminalStore.getState().terminals["thread-1"]).toBeUndefined();
      expect(useTerminalStore.getState().terminals["thread-2"]).toHaveLength(1);
    });
  });

  describe("removeAllTerminals", () => {
    it("should remove terminals and clear the active terminal", () => {
      const { addTerminal, removeAllTerminals } = useTerminalStore.getState();
      addTerminal("thread-1", "pty-1");
      removeAllTerminals("thread-1");

      const state = useTerminalStore.getState();
      expect(state.terminals["thread-1"]).toBeUndefined();
      expect(state.activeTerminalByScope["thread-1"] ?? null).toBeNull();
    });

    it("should not affect other threads", () => {
      const { addTerminal, removeAllTerminals } = useTerminalStore.getState();
      addTerminal("thread-1", "pty-1");
      addTerminal("thread-2", "pty-2");
      removeAllTerminals("thread-1");

      expect(useTerminalStore.getState().activeTerminalByScope["thread-2"]).toBe("pty-2");
    });

    it("removes all terminals for a thread", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");
      useTerminalStore.getState().addTerminal("thread-1", "pty-2");

      useTerminalStore.getState().removeAllTerminals("thread-1");

      const terminals = useTerminalStore.getState().terminals["thread-1"];
      expect(terminals).toBeUndefined();
    });

    it("does not affect other threads terminals", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");
      useTerminalStore.getState().addTerminal("thread-2", "pty-2");

      useTerminalStore.getState().removeAllTerminals("thread-1");

      expect(useTerminalStore.getState().terminals["thread-2"]).toHaveLength(1);
    });
  });

  describe("clearThread", () => {
    it("should remove both terminals and the active terminal", () => {
      const { addTerminal, clearThread } = useTerminalStore.getState();
      addTerminal("thread-1", "pty-1");
      clearThread("thread-1");

      const state = useTerminalStore.getState();
      expect(state.terminals["thread-1"]).toBeUndefined();
      expect(state.activeTerminalByScope["thread-1"]).toBeUndefined();
    });

    it("should not affect other threads", () => {
      const { addTerminal, clearThread } = useTerminalStore.getState();
      addTerminal("thread-1", "pty-1");
      addTerminal("thread-2", "pty-2");
      clearThread("thread-1");

      expect(useTerminalStore.getState().activeTerminalByScope["thread-2"]).toBe("pty-2");
    });
  });

  describe("setActiveTerminal", () => {
    it("scopes the selection to one thread", () => {
      const { addTerminal, setActiveTerminal } = useTerminalStore.getState();
      addTerminal("thread-1", "pty-1");
      addTerminal("thread-1", "pty-2");
      addTerminal("thread-2", "pty-3");
      setActiveTerminal("thread-1", "pty-1");

      const { activeTerminalByScope } = useTerminalStore.getState();
      expect(activeTerminalByScope["thread-1"]).toBe("pty-1");
      expect(activeTerminalByScope["thread-2"]).toBe("pty-3");
    });
  });

  describe("toggleSplit", () => {
    it("toggles split mode on", () => {
      useTerminalStore.getState().toggleSplit();

      expect(useTerminalStore.getState().splitMode).toBe(true);
    });

    it("toggles split mode off", () => {
      useTerminalStore.getState().toggleSplit();
      useTerminalStore.getState().toggleSplit();

      expect(useTerminalStore.getState().splitMode).toBe(false);
    });
  });
});
