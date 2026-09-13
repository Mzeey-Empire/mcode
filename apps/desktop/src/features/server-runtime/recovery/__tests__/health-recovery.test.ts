import { describe, expect, it, vi } from "vitest";
import { ServerHealthRecovery } from "../health-recovery.js";

const healthRestartLimit = 3;
const healthRestartWindowMs = 60_000;
const healthFailureConfirmations = 3;

function createRecovery(overrides: {
  isHealthy?: () => Promise<boolean>;
  restart?: () => Promise<void>;
  showError?: () => Promise<void> | void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
} = {}) {
  return new ServerHealthRecovery({
    isHealthy: overrides.isHealthy ?? vi.fn().mockResolvedValue(false),
    restart: overrides.restart ?? vi.fn().mockResolvedValue(undefined),
    showError: overrides.showError ?? vi.fn(),
    now: overrides.now,
    sleep: overrides.sleep ?? (async () => undefined),
    logger: overrides.logger,
  });
}

describe("ServerHealthRecovery", () => {
  it("does not restart a healthy server", async () => {
    const isHealthy = vi.fn().mockResolvedValue(true);
    const restart = vi.fn().mockResolvedValue(undefined);

    await createRecovery({ isHealthy, restart }).ensureServerRunning();

    expect(isHealthy).toHaveBeenCalledOnce();
    expect(restart).not.toHaveBeenCalled();
  });

  it("does not restart after a single failed probe that recovers", async () => {
    const isHealthy = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const restart = vi.fn().mockResolvedValue(undefined);
    const logger = { log: vi.fn(), error: vi.fn() };

    await createRecovery({ isHealthy, restart, logger }).ensureServerRunning();

    expect(isHealthy).toHaveBeenCalledTimes(2);
    expect(restart).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      "[main] Server health probe failed (1/3)",
    );
  });

  it("coalesces concurrent health recovery requests", async () => {
    let resolveHealth!: (healthy: boolean) => void;
    const isHealthy = vi.fn(
      () => new Promise<boolean>((resolve) => (resolveHealth = resolve)),
    );
    const restart = vi.fn().mockResolvedValue(undefined);
    const recovery = createRecovery({ isHealthy, restart });

    const first = recovery.ensureServerRunning();
    const second = recovery.ensureServerRunning();
    resolveHealth(false);
    // Remaining confirmation probes after the first unresolved probe.
    isHealthy.mockResolvedValue(false);
    await Promise.all([first, second]);

    expect(first).toBe(second);
    expect(isHealthy).toHaveBeenCalledTimes(healthFailureConfirmations);
    expect(restart).toHaveBeenCalledOnce();
  });

  it("restarts only after consecutive failed probes and logs the attempt", async () => {
    const restart = vi.fn().mockResolvedValue(undefined);
    const logger = { log: vi.fn(), error: vi.fn() };
    const sleep = vi.fn().mockResolvedValue(undefined);

    await createRecovery({ restart, logger, sleep }).ensureServerRunning();

    expect(sleep).toHaveBeenCalledTimes(healthFailureConfirmations - 1);
    expect(logger.log).toHaveBeenCalledWith(
      "[main] Server health probe failed (1/3)",
    );
    expect(logger.log).toHaveBeenCalledWith(
      "[main] Server health probe failed (2/3)",
    );
    expect(logger.log).toHaveBeenCalledWith(
      "[main] Server health probe failed (3/3)",
    );
    expect(logger.log).toHaveBeenCalledWith(
      "[main] Server unhealthy, restarting silently",
    );
    expect(restart).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("escalates after the silent restart limit", async () => {
    const restart = vi.fn().mockResolvedValue(undefined);
    const showError = vi.fn();
    let now = 1_000;
    const recovery = createRecovery({
      restart,
      showError,
      now: () => now,
    });

    for (let attempt = 0; attempt < healthRestartLimit; attempt += 1) {
      await recovery.ensureServerRunning();
      now += 1_000;
    }
    await recovery.ensureServerRunning();

    expect(restart).toHaveBeenCalledTimes(healthRestartLimit);
    expect(showError).toHaveBeenCalledOnce();
  });

  it("logs and swallows restart failures", async () => {
    const failure = new Error("restart failed");
    const restart = vi.fn().mockRejectedValue(failure);
    const logger = { log: vi.fn(), error: vi.fn() };

    await expect(createRecovery({ restart, logger }).ensureServerRunning()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      "[main] Silent server restart failed:",
      failure,
    );
  });

  it("forgets silent restarts outside the sliding window", async () => {
    const restart = vi.fn().mockResolvedValue(undefined);
    const showError = vi.fn();
    let now = 1_000;
    const recovery = createRecovery({ restart, showError, now: () => now });

    for (let attempt = 0; attempt < healthRestartLimit; attempt += 1) {
      await recovery.ensureServerRunning();
      now += 1_000;
    }
    now += healthRestartWindowMs;
    await recovery.ensureServerRunning();

    expect(restart).toHaveBeenCalledTimes(healthRestartLimit + 1);
    expect(showError).not.toHaveBeenCalled();
  });
});
