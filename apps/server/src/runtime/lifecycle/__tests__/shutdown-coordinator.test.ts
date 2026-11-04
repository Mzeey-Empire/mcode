import { describe, expect, it, vi } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { diag, parseDiagLine } from "@mcode/shared/diagnostics";
import {
  createShutdownCoordinator,
  EXPLICIT_SHUTDOWN_DEADLINE_MS,
} from "../shutdown-coordinator.js";

describe("createShutdownCoordinator", () => {
  it("records the first trigger as accepted and later requests as rejected", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-shutdown-"));
    diag.configure({ dir, enabled: true });
    let finish = () => {};
    const coordinator = createShutdownCoordinator({ shutdown: () => new Promise<void>((resolve) => { finish = resolve; }) });
    try {
      const first = coordinator.requestShutdown({ trigger: "http", client: "desktop" });
      const second = coordinator.requestShutdown({ trigger: "signal", signal: "SIGTERM" });
      expect(second).toBe(first);
      finish();
      await first;
      diag.flushSync();
      const rows = NodeFS.readdirSync(NodePath.join(dir, "p")).flatMap((file) => NodeFS.readFileSync(NodePath.join(dir, "p", file), "utf8").split("\n").map(parseDiagLine));
      expect(rows.filter((row) => row?.ch === "app.shutdown").map((row) => row?.d)).toEqual([
        { trigger: "http", client: "desktop", accepted: true },
        { trigger: "signal", signal: "SIGTERM", accepted: false },
      ]);
    } finally {
      finish();
      diag.configure({ enabled: false });
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("records each shutdown phase as it begins", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-shutdown-phase-"));
    diag.configure({ dir, enabled: true });
    try {
      const coordinator = createShutdownCoordinator({ shutdown: async () => undefined });
      coordinator.setPhase("begin shutdown");
      coordinator.setPhase("stop agent sessions");
      diag.flushSync();
      const rows = NodeFS.readdirSync(NodePath.join(dir, "p")).flatMap((file) => NodeFS.readFileSync(NodePath.join(dir, "p", file), "utf8").split("\n").map(parseDiagLine));
      expect(rows.filter((row) => row?.ch === "app.phase").map((row) => row?.d)).toEqual([
        { phase: "begin shutdown" },
        { phase: "stop agent sessions" },
      ]);
    } finally {
      diag.configure({ enabled: false });
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits with the current phase when a shutdown phase exceeds the deadline", async () => {
    let trigger: (() => void) | undefined;
    const exit = vi.fn(() => undefined as never);
    const onDeadline = vi.fn();
    const shutdown = vi.fn(() => new Promise<void>(() => {}));
    const coordinator = createShutdownCoordinator({
      shutdown,
      exit,
      onDeadline,
      schedule: ((callback: () => void) => {
        trigger = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      cancel: vi.fn(),
    });

    coordinator.setPhase("shutdown cleanup worker");
    coordinator.requestShutdown({ trigger: "idle" });
    trigger?.();

    expect(shutdown).toHaveBeenCalledOnce();
    expect(onDeadline).toHaveBeenCalledWith("shutdown cleanup worker");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("clears the watchdog when shutdown completes normally", async () => {
    const cancel = vi.fn();
    const shutdown = vi.fn(async () => undefined);
    const coordinator = createShutdownCoordinator({
      shutdown,
      cancel,
      schedule: (() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
    });

    await coordinator.requestShutdown({ trigger: "idle" });

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("allows terminal cleanup beyond eight seconds but bounds a hung shutdown", async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn(() => undefined as never);
      const coordinator = createShutdownCoordinator({
        shutdown: () => new Promise<void>(() => {}),
        exit,
      });
      coordinator.requestShutdown({ trigger: "idle" });
      await vi.advanceTimersByTimeAsync(25_000);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(EXPLICIT_SHUTDOWN_DEADLINE_MS - 25_000);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
