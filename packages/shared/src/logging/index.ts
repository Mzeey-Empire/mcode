/**
 * Application logger with daily rotation and console output.
 * Provides a pre-configured Winston logger that writes JSON-formatted
 * entries to rotating files under `<MCODE_DIR>/logs/`.
 */

import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { getMcodeDir } from "../paths/index.js";

const MAX_LINES = 1000;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

/** Resolve (and create) the log directory. Throws when no data dir is configured. */
function resolveLogDir(): string {
  const dir = NodePath.join(getMcodeDir(), "logs");
  NodeFS.mkdirSync(dir, { recursive: true });
  return dir;
}

let fileTransportAttached = false;

// The rotating file is attached on the first log call, not at import. Resolving the
// data dir at import would make merely importing this module throw in tools and tests
// that have no MCODE_DATA_DIR; now only a process that actually logs needs one.
const attachFileTransportOnFirstLog = winston.format((info) => {
  if (!fileTransportAttached) {
    logger.add(
      new DailyRotateFile({
        dirname: resolveLogDir(),
        filename: "mcode.log.%DATE%",
        datePattern: "YYYY-MM-DD",
        maxFiles: "14d",
      }),
    );
    fileTransportAttached = true;
  }
  return info;
});

/** Pre-configured application logger with daily file rotation and console output. */
export const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    attachFileTransportOnFirstLog(),
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple(),
      ),
    }),
  ],
});

/** Get the absolute path to the log directory. */
export function getLogPath(): string {
  return resolveLogDir();
}

/**
 * Read the most recent log file and return the last N lines.
 * Enforces a 10 MB file-size guard and a 1000-line cap.
 */
export function getRecentLogs(lines: number): string {
  const logDir = resolveLogDir();
  const cappedLines = Math.min(Math.max(lines, 0), MAX_LINES);

  const files = NodeFS.readdirSync(logDir)
    .filter((f) => f.startsWith("mcode.log"))
    .map((f) => ({
      name: f,
      mtime: NodeFS.statSync(NodePath.join(logDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) return "";

  const latestPath = NodePath.join(logDir, files[0].name);
  const stat = NodeFS.statSync(latestPath);

  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(
      `Log file exceeds 10MB, please check ${logDir} directly`,
    );
  }

  const content = NodeFS.readFileSync(latestPath, "utf-8");
  const allLines = content.split("\n");

  return allLines.slice(-cappedLines).join("\n");
}
