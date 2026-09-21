import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { appendDailyLogSync, recordFatalError } from "../server-diagnostics.js";

let dir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-diag-"));
  originalDataDir = process.env.MCODE_DATA_DIR;
  process.env.MCODE_DATA_DIR = dir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.MCODE_DATA_DIR;
  else process.env.MCODE_DATA_DIR = originalDataDir;
  NodeFS.rmSync(dir, { recursive: true, force: true });
});

function readJsonl(path: string): Array<Record<string, unknown>> {
  return NodeFS.readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function dailyLogFiles(): string[] {
  const logsDir = NodePath.join(dir, "logs");
  if (!NodeFS.existsSync(logsDir)) return [];
  return NodeFS.readdirSync(logsDir).filter((file) => file.startsWith("mcode.log."));
}

describe("recordFatalError", () => {
  it("writes the fatal record to today's log and server-fatal.log", () => {
    recordFatalError("uncaughtException", new Error("boom"));

    expect(dailyLogFiles()).toHaveLength(1);
    const daily = readJsonl(NodePath.join(dir, "logs", dailyLogFiles()[0]));
    const fatal = readJsonl(NodePath.join(dir, "server-fatal.log"));

    for (const records of [daily, fatal]) {
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        level: "fatal",
        kind: "uncaughtException",
        error: "boom",
        pid: process.pid,
      });
      expect(String(records[0].stack)).toContain("boom");
      expect(typeof records[0].timestamp).toBe("string");
    }
  });

  it("serializes non-Error rejection reasons", () => {
    recordFatalError("unhandledRejection", "plain string reason");

    const [record] = readJsonl(NodePath.join(dir, "server-fatal.log"));
    expect(record).toMatchObject({
      level: "fatal",
      kind: "unhandledRejection",
      error: "plain string reason",
    });
  });

  it("survives a failure writing one of the targets", () => {
    // A directory where server-fatal.log should be forces appendFileSync to fail.
    NodeFS.mkdirSync(NodePath.join(dir, "server-fatal.log"));

    expect(() => recordFatalError("uncaughtException", new Error("partial"))).not.toThrow();
    expect(dailyLogFiles()).toHaveLength(1);
  });
});

describe("appendDailyLogSync", () => {
  it("appends JSONL records to today's log file", () => {
    appendDailyLogSync({ level: "info", message: "one" });
    appendDailyLogSync({ level: "warn", message: "two" });

    const [file] = dailyLogFiles();
    const records = readJsonl(NodePath.join(dir, "logs", file));
    expect(records.map((record) => record.message)).toEqual(["one", "two"]);
    expect(typeof records[0].timestamp).toBe("string");
  });
});
