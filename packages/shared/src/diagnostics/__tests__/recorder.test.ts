import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../logging/index.js";
import { DiagRecorder, parseDiagLine, type DiagRecord } from "../index.js";
import { Sink } from "../internal/sink.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFS>();
  return { ...actual, write: vi.fn(actual.write) };
});

const SEGMENT_BYTES = 4 * 1024 * 1024;
const MAX_OPEN_SPANS = 10_000;
const FLUSH_INTERVAL_MS = 250;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("diagnostics recorder", () => {
  let dir: string;
  let recorder: DiagRecorder;

  beforeEach(() => {
    dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-diag-"));
    recorder = new DiagRecorder();
  });

  afterEach(() => {
    recorder.configure({ enabled: false });
    recorder.flushSync();
    vi.useRealTimers();
    vi.restoreAllMocks();
    NodeFS.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function threadFile(threadId: string): string {
    return NodePath.join(dir, "t", threadId + ".jsonl");
  }

  function parseFile(file: string): DiagRecord[] {
    const lines = NodeFS.readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line !== "");
    return lines.map((line) => {
      const record = parseDiagLine(line);
      if (!record) throw new Error("Unparseable recording line: " + line.slice(0, 80));
      return record;
    });
  }

  function processRecords(): DiagRecord[] {
    const folder = NodePath.join(dir, "p");
    if (!NodeFS.existsSync(folder)) return [];
    return NodeFS.readdirSync(folder).flatMap((name) => parseFile(NodePath.join(folder, name)));
  }

  function threadEvents(threadId: string): DiagRecord[] {
    const segments = [NodePath.join(dir, "t", threadId + ".1.jsonl"), threadFile(threadId)];
    const existing = segments.filter((file) => NodeFS.existsSync(file));
    return existing.flatMap(parseFile).filter((record) => record.k === "ev");
  }

  function runStates(records: readonly DiagRecord[]): string[] {
    return records.flatMap((record) => (record.k === "run" ? [record.state] : []));
  }

  function setModifiedTime(file: string, modifiedAtMs: number): void {
    const seconds = modifiedAtMs / 1000;
    NodeFS.utimesSync(file, seconds, seconds);
  }

  it("off skips payload evaluation and all filesystem output", () => {
    recorder.configure({ dir, enabled: false });
    const payload = vi.fn(() => ({ operation: "start" }));

    recorder.emit("cursor.session", { th: "a" }, payload);
    recorder.flushSync();

    expect(payload).not.toHaveBeenCalled();
    expect(NodeFS.readdirSync(dir)).toEqual([]);
  });

  it("writes records from several threads to separate files readable after flushSync", () => {
    recorder.configure({ dir, enabled: true });

    for (const threadId of ["a", "b", "c"]) {
      recorder.emit("cursor.session", { th: threadId }, () => ({ operation: "from-" + threadId }));
    }
    recorder.flushSync();

    for (const threadId of ["a", "b", "c"]) {
      const events = parseFile(threadFile(threadId)).filter((record) => record.k === "ev");
      expect(events.map((record) => record.th)).toEqual([threadId]);
      expect(events.map((record) => record.d)).toEqual([{ operation: "from-" + threadId }]);
    }
  });

  it("preserves every pre-fatal record when flushSync is followed immediately by exit", () => {
    const moduleUrl = new URL("../recorder.ts", import.meta.url).href;
    const child = NodeChildProcess.spawnSync("bun", ["--eval", `
      import { DiagRecorder } from ${JSON.stringify(moduleUrl)};
      const recorder = new DiagRecorder();
      recorder.configure({ dir: process.argv[1], enabled: true });
      for (let i = 0; i < 1000; i++) {
        recorder.emit("cursor.session", { th: "crash" }, () => ({ operation: "burst-" + i }));
      }
      recorder.emit("cursor.session", { th: "crash" }, () => ({ operation: "fatal" }));
      recorder.flushSync();
      process.exit(17);
    `, dir], { encoding: "utf8" });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(17);
    expect(threadEvents("crash").map((record) => record.d)).toEqual([
      ...Array.from({ length: 1000 }, (_, i) => ({ operation: "burst-" + i })),
      { operation: "fatal" },
    ]);
  });

  it.each([false, true])("does not repeat a synchronous takeover when async preparation settles (failure=%s)", async (fails) => {
    NodeFS.mkdirSync(NodePath.join(dir, "t"));
    let settle = (_error?: Error): void => { throw new Error("Preparation not started"); };
    const preparation = new Promise<string | undefined>((resolve, reject) => {
      settle = (error) => error ? reject(error) : resolve(undefined);
    });
    const mkdir = vi.spyOn(NodeFS.promises, "mkdir").mockReturnValueOnce(preparation);
    const onFailure = vi.fn();
    const sink = new Sink({ dir, runId: "test", onFailure, onDropped: vi.fn() });
    for (let n = 0; n < 1000; n += 1) {
      sink.write({ t: n, n, ch: "test", k: "ev", th: "a", d: "x".repeat(100) });
    }
    sink.flushSync();
    expect(threadEvents("a").map((record) => record.n)).toEqual(Array.from({ length: 1000 }, (_, n) => n));
    settle(fails ? new Error("late mkdir failure") : undefined);
    await preparation.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    mkdir.mockRestore();
    sink.write({ t: 1000, n: 1000, ch: "test", k: "ev", th: "a" });
    sink.flushSync();
    expect(threadEvents("a").map((record) => record.n)).toEqual(Array.from({ length: 1001 }, (_, n) => n));
    expect(onFailure).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps one copy when an active write settles after flushSync (failure=%s)", async (fails) => {
    const { write: originalWrite } = await vi.importActual<typeof NodeFS>("node:fs");
    const write = vi.mocked(NodeFS.write).mockClear().mockImplementationOnce(() => {});
    const onFailure = vi.fn();
    const sink = new Sink({ dir, runId: "test", onFailure, onDropped: vi.fn() });
    for (let n = 0; n < 1000; n += 1) {
      sink.write({ t: n, n, ch: "test", k: "ev", th: "a", d: "x".repeat(100) });
    }
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    sink.flushSync();
    expect(threadEvents("a").map((record) => record.n)).toEqual(Array.from({ length: 1000 }, (_, n) => n));
    const args = write.mock.calls[0];
    if (!args) throw new Error("No active filesystem write");
    write.mockImplementation(originalWrite);
    await new Promise<void>((resolve) => {
      const callback = args.at(-1);
      if (typeof callback !== "function") throw new Error("No filesystem callback");
      const finish = (...result: unknown[]): void => {
        Reflect.apply(callback, undefined, result);
        resolve();
      };
      if (fails) finish(new Error("late write failure"));
      else Reflect.apply(originalWrite, NodeFS, [...args.slice(0, -1), finish]);
    });
    sink.write({ t: 1000, n: 1000, ch: "test", k: "ev", th: "a" });
    sink.flushSync();
    expect(threadEvents("a").map((record) => record.n)).toEqual(Array.from({ length: 1001 }, (_, n) => n));
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("rotates a noisy thread to a previous segment without touching another thread", async () => {
    recorder.configure({ dir, enabled: true });
    recorder.emit("cursor.session", { th: "quiet" }, () => ({ operation: "start" }));
    recorder.flushSync();
    const quietBefore = NodeFS.readFileSync(threadFile("quiet"), "utf8");

    for (let batch = 0; batch < 10; batch += 1) {
      for (let i = 0; i < 1000; i += 1) {
        recorder.emit("cursor.session", { th: "noisy" }, () => ({ operation: "x".repeat(512) }));
      }
      recorder.flushSync();
    }

    await vi.waitFor(() => expect(threadEvents("noisy")).toHaveLength(10_000), { interval: 5 });
    const previous = NodePath.join(dir, "t", "noisy.1.jsonl");
    expect(NodeFS.statSync(previous).size).toBeLessThanOrEqual(SEGMENT_BYTES);
    expect(NodeFS.statSync(threadFile("noisy")).size).toBeLessThanOrEqual(SEGMENT_BYTES);
    expect(NodeFS.readFileSync(threadFile("quiet"), "utf8")).toBe(quietBefore);
  });

  describe("background flushing", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    });

    async function fakeMsUntilFirstEvent(threadId: string): Promise<number> {
      const startedAt = Date.now();
      await vi.waitFor(
        () => {
          expect(parseFile(threadFile(threadId)).some((record) => record.k === "ev")).toBe(true);
        },
        { interval: 5, timeout: 2000 },
      );
      return Date.now() - startedAt;
    }

    it("holds a small record until the flush interval has passed", async () => {
      recorder.configure({ dir, enabled: true });

      recorder.emit("cursor.session", { th: "a" }, () => ({ operation: "start" }));
      const waitedMs = await fakeMsUntilFirstEvent("a");

      expect(waitedMs).toBeGreaterThanOrEqual(FLUSH_INTERVAL_MS);
    });

    it("flushes early once 64 KB are pending", async () => {
      recorder.configure({ dir, enabled: true });

      for (let i = 0; i < 200; i += 1) {
        recorder.emit("cursor.session", { th: "a" }, () => ({ operation: "x".repeat(500) }));
      }
      const waitedMs = await fakeMsUntilFirstEvent("a");

      expect(waitedMs).toBeLessThan(FLUSH_INTERVAL_MS);
    });
  });

  it("copies ids and elapsed time to an end, and keeps an end that has no begin", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    recorder.configure({ dir, enabled: true });

    recorder.begin("approval", "request", { th: "a", turn: "turn" }, () => ({ provider: "codex" }));
    vi.setSystemTime(1250);
    recorder.end("approval", "request", "ok", () => ({ status: "accepted" }));
    recorder.end("approval", "unknown", "rejected");
    recorder.flushSync();

    const matched = parseFile(threadFile("a")).find((record) => record.k === "end");
    expect(matched).toMatchObject({ th: "a", turn: "turn", sp: "request", ms: 250 });
    const unmatched = processRecords().find((record) => record.k === "end");
    expect(unmatched).toMatchObject({ sp: "unknown", ok: "rejected" });
    expect(unmatched).not.toHaveProperty("ms");
  });

  it("evicts the oldest open span once 10000 are open", () => {
    recorder.configure({ dir, enabled: true });
    for (let i = 0; i <= MAX_OPEN_SPANS; i += 1) {
      recorder.begin("approval", "span-" + i, { th: "a" });
    }

    recorder.end("approval", "span-0", "ok");
    recorder.end("approval", "span-1", "ok");
    recorder.end("approval", "span-" + MAX_OPEN_SPANS, "ok");
    recorder.flushSync();

    const threadEnds = parseFile(threadFile("a")).filter((record) => record.k === "end");
    expect(threadEnds.map((record) => (record.k === "end" ? record.sp : ""))).toEqual([
      "span-1",
      "span-" + MAX_OPEN_SPANS,
    ]);
    const orphanEnds = processRecords().filter((record) => record.k === "end");
    expect(orphanEnds.map((record) => (record.k === "end" ? record.sp : ""))).toEqual(["span-0"]);
  });

  it("drops records past the pending cap and reports the count", async () => {
    recorder.configure({ dir, enabled: true });
    const emitted = 10_000;

    for (let i = 0; i < emitted; i += 1) {
      recorder.emit("cursor.session", { th: "a" }, () => ({ operation: "x".repeat(512) }));
    }
    recorder.flushSync();

    await vi.waitFor(
      () => {
        const written = threadEvents("a").length;
        const markers = processRecords().filter((record) => record.k === "run" && record.state === "dropped");
        expect(written).toBeLessThan(emitted);
        expect(markers).toHaveLength(1);
        expect(markers[0]).toMatchObject({ dropped: emitted - written });
      },
      { interval: 5 },
    );
  });

  it("marks off and on transitions", () => {
    recorder.configure({ dir, enabled: true });
    recorder.configure({ enabled: false });
    recorder.configure({ enabled: true });
    recorder.flushSync();

    expect(runStates(processRecords())).toEqual(["on", "off", "on"]);
  });

  describe("after a write failure", () => {
    function blockThreadFolder(): void {
      NodeFS.writeFileSync(NodePath.join(dir, "t"), "");
    }

    function unblockThreadFolder(): void {
      NodeFS.rmSync(NodePath.join(dir, "t"), { force: true });
    }

    it("stops recording and logs the failure once, however many records follow", () => {
      const warn = vi.spyOn(logger, "warn").mockReturnValue(logger);
      recorder.configure({ dir, enabled: true });
      blockThreadFolder();

      recorder.emit("cursor.session", { th: "a" }, () => ({ operation: "lost" }));
      recorder.flushSync();
      const payload = vi.fn(() => ({ operation: "ignored" }));
      for (let i = 0; i < 5; i += 1) {
        recorder.emit("cursor.session", { th: "a" }, payload);
        recorder.flushSync();
      }

      expect(payload).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(processRecords().filter((record) => record.k === "run" && record.state === "dropped"))
        .toMatchObject([{ dropped: 2 }]);
    });

    it("writes again when recording is turned back on", () => {
      vi.spyOn(logger, "warn").mockReturnValue(logger);
      recorder.configure({ dir, enabled: true });
      blockThreadFolder();
      recorder.emit("cursor.session", { th: "a" }, () => ({ operation: "lost" }));
      recorder.flushSync();

      unblockThreadFolder();
      recorder.configure({ enabled: true });
      recorder.emit("cursor.session", { th: "a" }, () => ({ operation: "after-retry" }));
      recorder.flushSync();

      const events = parseFile(threadFile("a")).filter((record) => record.k === "ev");
      expect(events.map((record) => record.d)).toEqual([{ operation: "after-retry" }]);
    });
  });

  describe("retention", () => {
    function writeOldRecording(name: string, ageMs: number): string {
      const file = NodePath.join(dir, "t", name + ".jsonl");
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(file, "");
      setModifiedTime(file, Date.now() - ageMs);
      return file;
    }

    async function flushThread(threadId: string): Promise<void> {
      recorder.emit("cursor.session", { th: threadId }, () => ({ operation: "start" }));
      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
      await vi.waitFor(() => {
        expect(parseFile(threadFile(threadId)).some((record) => record.k === "ev")).toBe(true);
      });
    }

    it("deletes week-old recordings when recording turns on, then only once an hour", async () => {
      vi.useFakeTimers();
      const firstExpired = writeOldRecording("expired-1", 8 * DAY_MS);
      recorder.configure({ dir, enabled: true });
      await vi.waitFor(() => {
        expect(NodeFS.existsSync(firstExpired)).toBe(false);
      });

      const secondExpired = writeOldRecording("expired-2", 8 * DAY_MS);
      await flushThread("a");
      expect(NodeFS.existsSync(secondExpired)).toBe(true);

      vi.setSystemTime(Date.now() + HOUR_MS + 1000);
      await flushThread("b");
      await vi.waitFor(() => {
        expect(NodeFS.existsSync(secondExpired)).toBe(false);
      });
    });
  });

  it("run preserves the original rejection and bounds and redacts the recorded error", async () => {
    recorder.configure({ dir, enabled: true });
    const failure = new Error("Bearer xyz " + "x".repeat(1000));

    await expect(recorder.run("agent.send", { th: "a" }, () => Promise.reject(failure))).rejects.toBe(failure);
    recorder.flushSync();

    const end = parseFile(threadFile("a")).find((record) => record.k === "end");
    const redacted = ("Bearer [redacted] " + "x".repeat(1000)).slice(0, 512);
    expect(end).toMatchObject({ ok: "error", d: { error: redacted } });
  });

  it("ignores torn lines", () => {
    expect(parseDiagLine('{"k":"ev"')).toBeUndefined();
  });
});
