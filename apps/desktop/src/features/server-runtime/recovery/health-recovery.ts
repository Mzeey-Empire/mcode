import { consoleRecoveryLogger, type RecoveryLogger } from "./logger.js";

const SERVER_HEALTH_RESTART_WINDOW_MS = 60_000;

const SERVER_HEALTH_RESTART_LIMIT = 3;

/** Require several failed probes before killing a live server. */
const SERVER_HEALTH_FAILURE_CONFIRMATIONS = 3;

/** Delay between confirmation probes so a busy event loop can recover. */
const SERVER_HEALTH_RETRY_DELAY_MS = 750;

interface ServerHealthRecoveryDeps {
  isHealthy: () => Promise<boolean>;
  restart: () => Promise<void>;
  showError: () => Promise<void> | void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: RecoveryLogger;
}

/** Coalesces health checks and performs bounded silent server recovery. */
export class ServerHealthRecovery {
  private readonly isHealthy: () => Promise<boolean>;
  private readonly restart: () => Promise<void>;
  private readonly showError: () => Promise<void> | void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: RecoveryLogger;
  private silentRestartTimestamps: number[] = [];
  private inFlight: Promise<void> | null = null;

  constructor(deps: ServerHealthRecoveryDeps) {
    this.isHealthy = deps.isHealthy;
    this.restart = deps.restart;
    this.showError = deps.showError;
    this.now = deps.now ?? Date.now;
    this.sleep =
      deps.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.logger = deps.logger ?? consoleRecoveryLogger;
  }

  ensureServerRunning(): Promise<void> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      if (await this.confirmUnhealthy()) {
        await this.restartUnhealthyServer();
      }
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Returns true only after consecutive failed probes, not a single blip. */
  private async confirmUnhealthy(): Promise<boolean> {
    for (
      let attempt = 1;
      attempt <= SERVER_HEALTH_FAILURE_CONFIRMATIONS;
      attempt += 1
    ) {
      if (await this.isHealthy()) return false;
      this.logger.log(
        `[main] Server health probe failed (${attempt}/${SERVER_HEALTH_FAILURE_CONFIRMATIONS})`,
      );
      if (attempt < SERVER_HEALTH_FAILURE_CONFIRMATIONS) {
        await this.sleep(SERVER_HEALTH_RETRY_DELAY_MS);
      }
    }
    return true;
  }

  private async restartUnhealthyServer(): Promise<void> {
    const now = this.now();
    this.silentRestartTimestamps = this.silentRestartTimestamps.filter(
      (timestamp) => now - timestamp < SERVER_HEALTH_RESTART_WINDOW_MS,
    );
    if (this.silentRestartTimestamps.length >= SERVER_HEALTH_RESTART_LIMIT) {
      await this.showError();
      return;
    }
    this.silentRestartTimestamps.push(now);

    this.logger.log("[main] Server unhealthy, restarting silently");
    try {
      await this.restart();
    } catch (error) {
      this.logger.error("[main] Silent server restart failed:", error);
    }
  }
}
