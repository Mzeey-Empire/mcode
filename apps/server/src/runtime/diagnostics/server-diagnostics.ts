/**
 * Crash-time diagnostics for the Bun server process.
 *
 * Winston writes through a buffered stream, so an uncaught error never reaches
 * mcode.log.* — the process only gets Bun's bare stderr dump. These handlers
 * synchronously append a JSONL record to today's log and to a dedicated
 * server-fatal.log before exiting, so every crash leaves a full stack trace
 * on disk. The module deliberately avoids project imports: the failure being
 * recorded may live inside them.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Dedicated crash log, beside the rotated server-stderr logs under the data dir. */
const FATAL_LOG_NAME = "server-fatal.log";

/** Poll interval for the event-loop lag watch. */
const LAG_CHECK_MS = 250;

/** Stall duration beyond the check interval that warrants a log entry. */
const LAG_WARN_MS = 500;

function mcodeDir(): string {
  if (process.env.MCODE_DATA_DIR) return process.env.MCODE_DATA_DIR;
  const dirName = process.env.NODE_ENV !== "production" ? ".mcode-dev" : ".mcode";
  return NodePath.join(NodeOS.homedir(), dirName);
}

function dailyLogPath(date: Date): string {
  // Local calendar date, matching winston-daily-rotate-file's default naming.
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  return NodePath.join(mcodeDir(), "logs", `mcode.log.${stamp}`);
}

function appendJsonlSync(path: string, record: Record<string, unknown>): void {
  try {
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.appendFileSync(path, JSON.stringify(record) + "\n");
  } catch {
    // A diagnostics write must never take the process down with it.
  }
}

/** Append one record to today's log without going through winston's stream. */
export function appendDailyLogSync(record: Record<string, unknown>): void {
  appendJsonlSync(dailyLogPath(new Date()), {
    timestamp: new Date().toISOString(),
    ...record,
  });
}

function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const errno = error as NodeJS.ErrnoException;
    return {
      errorName: error.name,
      error: error.message,
      stack: error.stack,
      ...(errno.code !== undefined ? { code: errno.code } : {}),
      ...(errno.errno !== undefined ? { errno: errno.errno } : {}),
      ...(errno.syscall !== undefined ? { syscall: errno.syscall } : {}),
    };
  }
  return { error: String(error) };
}

/**
 * Write a fatal record to today's log and to server-fatal.log, then let the
 * caller exit. The second file keeps a stable crash history even when the
 * daily file rotates or is the component that failed.
 */
export function recordFatalError(
  kind: "uncaughtException" | "unhandledRejection",
  error: unknown,
): void {
  const record = {
    timestamp: new Date().toISOString(),
    level: "fatal",
    message: `Fatal ${kind}`,
    kind,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime() * 100) / 100,
    ...describeError(error),
  };
  appendJsonlSync(dailyLogPath(new Date()), record);
  appendJsonlSync(NodePath.join(mcodeDir(), FATAL_LOG_NAME), record);
}

/**
 * Warn-log event-loop stalls so synchronous work blocking Bun's single
 * thread becomes visible in the daily log with a duration attached.
 */
function startEventLoopLagWatch(): void {
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const stalledMs = now - last;
    last = now;
    if (stalledMs - LAG_CHECK_MS >= LAG_WARN_MS) {
      appendDailyLogSync({
        level: "warn",
        message: "Event loop stalled",
        stalledMs,
      });
    }
  }, LAG_CHECK_MS);
  // Never let a diagnostics timer keep a shutdown process alive.
  timer.unref();
}

let installed = false;

/**
 * Install fatal-error capture, an exit record, and the event-loop lag watch.
 * Handlers preserve Bun's fatal semantics — uncaught errors still exit 1 —
 * but the stack now lands on disk first.
 */
export function installServerDiagnostics(): void {
  if (installed) return;
  installed = true;

  process.on("uncaughtException", (error) => {
    recordFatalError("uncaughtException", error);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    recordFatalError("unhandledRejection", reason);
    process.exit(1);
  });
  process.on("exit", (code) => {
    appendDailyLogSync({
      level: "info",
      message: "Server process exiting",
      exitCode: code,
      uptimeSeconds: Math.round(process.uptime() * 100) / 100,
    });
  });

  startEventLoopLagWatch();
}
