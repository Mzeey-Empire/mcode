import type { Database } from "bun:sqlite";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import { DiagRecorder, recordingFileId, threadRecordingFileId, type DiagRecord } from "@mcode/shared/diagnostics";
import { openMigratedTestDatabase } from "../../../persistence/sqlite/testing/migrated-test-database.js";
import { readRecordings } from "../recordings.js";
import { loadEvidence } from "../sources.js";
import { findAnomalies } from "../anomalies.js";
import { renderJson, renderText } from "../render.js";
import type { DiagQuery } from "../model.js";

const WINDOW_START = 1000;
const WINDOW_END = 200_000;

describe("diagnostics reader", () => {
  let dir: string;
  let q: DiagQuery;

  beforeEach(() => {
    dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-reader-"));
    NodeFS.mkdirSync(NodePath.join(dir, "diagnostics/t"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(dir, "diagnostics/p"), { recursive: true });
    q = { dataDir: dir, noDb: true, since: WINDOW_START, until: WINDOW_END, limit: 400 };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    NodeFS.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function recordingPath(folder: "t" | "p", name: string): string {
    return NodePath.join(dir, "diagnostics", folder, name);
  }

  function writeLines(file: string, rows: DiagRecord[]): void {
    NodeFS.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n"));
  }

  function write(threadId: string, rows: DiagRecord[]): void {
    writeLines(recordingPath("t", recordingFileId(threadId) + ".jsonl"), rows);
  }

  function begin(threadId: string, channel = "approval", budgetMs: number | null = null): DiagRecord {
    return { t: 2000, n: 1, th: threadId, k: "beg", ch: channel, sp: "request", exp: budgetMs };
  }

  function render(): string {
    const evidence = loadEvidence(q);
    return renderText(evidence, findAnomalies(evidence, q), q);
  }

  function recordedThreadIds(): string[] {
    const evidence = loadEvidence(q);
    const ids = evidence.records.flatMap((record) => (record.th ? [record.th] : []));
    return [...new Set(ids)].sort();
  }

  it("summarizes a clean exit with its accepted HTTP shutdown request", () => {
    writeLines(recordingPath("p", "server-one.jsonl"), [
      { t: 1500, n: 1, k: "ev", ch: "app.run", d: { pid: 42, previous: "clean" } },
      { t: 2000, n: 2, k: "ev", ch: "app.shutdown", d: { trigger: "http", client: "desktop", accepted: true } },
      { t: 2100, n: 3, k: "ev", ch: "app.shutdown", d: { trigger: "signal", signal: "SIGTERM", accepted: false } },
      { t: 3000, n: 4, k: "ev", ch: "app.exit", d: { code: 0, phase: "complete", uptimeMs: 1500 } },
    ]);
    expect(render()).toContain("run server-one pid 42: started 1970-01-01T00:00:01.500Z (previous clean); ended exit code 0 at 1970-01-01T00:00:03.000Z after complete, shutdown requested by http desktop at 1970-01-01T00:00:02.000Z");
  });

  it("reports the last record of a run without an exit, keeping reused PIDs separate", () => {
    writeLines(recordingPath("p", "missing-exit.jsonl"), [
      { t: 1500, n: 1, k: "ev", ch: "app.run", d: { pid: 42, previous: "first" } },
      { t: 4000, n: 2, k: "ev", ch: "app.control", d: { control: "server-hang" } },
    ]);
    writeLines(recordingPath("p", "other-run.jsonl"), [
      { t: 5000, n: 1, k: "ev", ch: "app.run", d: { pid: 42, previous: "unclean" } },
      { t: 6000, n: 2, k: "ev", ch: "app.exit", d: { code: 0, phase: "complete", uptimeMs: 1000 } },
    ]);
    expect(render()).toContain("run missing-exit pid 42: started 1970-01-01T00:00:01.500Z (previous first); ended no exit record; last record at 1970-01-01T00:00:04.000Z (killed or crashed, or still running at capture)");
  });

  it("names the last shutdown phase a run reached when it has no exit record", () => {
    writeLines(recordingPath("p", "killed-in-shutdown.jsonl"), [
      { t: 1500, n: 1, k: "ev", ch: "app.run", d: { pid: 42, previous: "clean" } },
      { t: 2000, n: 2, k: "ev", ch: "app.shutdown", d: { trigger: "http", client: "desktop", accepted: true } },
      { t: 2001, n: 3, k: "ev", ch: "app.phase", d: { phase: "begin shutdown" } },
      { t: 2002, n: 4, k: "ev", ch: "app.phase", d: { phase: "stop agent sessions" } },
      { t: 2500, n: 5, k: "ev", ch: "app.stall", d: { lastOnTimeAt: 2000, lateCallbackAt: 2500, intervalMs: 500, lateMs: 250 } },
    ]);
    expect(render()).toContain("ended no exit record; last record at 1970-01-01T00:00:02.500Z (killed or crashed, or still running at capture), last shutdown phase stop agent sessions began at 1970-01-01T00:00:02.002Z, shutdown requested by http desktop");
  });

  it("dates a run's last record from its thread records and says whether provider processes end with it", () => {
    writeLines(recordingPath("p", "contained.jsonl"), [
      { t: 1500, n: 1, k: "ev", ch: "app.run", d: { pid: 42, previous: "clean", children: "job" } },
      { t: 2000, n: 2, k: "ev", ch: "rpc.request", d: { method: "agent.send", outcome: "ok" } },
    ]);
    write("a", [
      { t: 1900, n: 3, th: "a", k: "run", ch: "diag", run: "earlier", pid: 41, state: "on" },
      { t: 1950, n: 4, th: "a", k: "ev", ch: "agent.created", d: { provider: "claude" } },
      { t: 2100, n: 5, th: "a", k: "run", ch: "diag", run: "contained", pid: 42, state: "on" },
      { t: 2600, n: 6, th: "a", k: "ev", ch: "agent.created", d: { provider: "claude" } },
    ]);
    q.thread = "a";
    const text = render();
    expect(text).toContain("run contained pid 42: started 1970-01-01T00:00:01.500Z (previous clean; provider processes end with it); ended no exit record; last record at 1970-01-01T00:00:02.600Z");
    expect(text).toContain("run earlier pid 41: started unknown (previous unknown); ended no exit record; last record at 1970-01-01T00:00:01.950Z");
  });

  /** The text one sink append writes. */
  function appended(rows: DiagRecord[], rewrite = false): string {
    // A flush's rewrite starts on a fresh line, after any torn copy.
    return (rewrite ? "\n" : "") + rows.map((row) => JSON.stringify(row) + "\n").join("");
  }

  function marker(run: string, t: number): DiagRecord {
    return { t, n: 1, th: "a", k: "run", ch: "diag", run, pid: 41, state: "on" };
  }

  function runFile(threadId: string, run: string, rotated = false): string {
    return recordingPath("t", threadRecordingFileId(threadId, run) + (rotated ? ".1.jsonl" : ".jsonl"));
  }

  it("reads a batch a fatal flush rewrote once, skipping its torn copy in the rotated segment", () => {
    const before: DiagRecord = { t: 2000, n: 2, th: "a", k: "ev", ch: "agent.created", d: "before" };
    const middle: DiagRecord = { t: 2100, n: 3, th: "a", k: "ev", ch: "agent.created", d: "middle" };
    const fatal: DiagRecord = { t: 2500, n: 4, th: "a", k: "ev", ch: "agent.created", d: "fatal" };
    const original = appended([before, middle]);
    NodeFS.writeFileSync(runFile("a", "crashed", true), appended([marker("crashed", 1500)]) + original.slice(0, -20));
    NodeFS.writeFileSync(runFile("a", "crashed"), appended([before, middle], true) + appended([fatal]));
    NodeFS.writeFileSync(runFile("a", "other"), appended([marker("other", 1600)]));
    q.thread = "a";
    expect(loadEvidence(q).records).toEqual([
      marker("crashed", 1500),
      marker("other", 1600),
      { ...before, run: "crashed" },
      { ...middle, run: "crashed" },
      { ...fatal, run: "crashed" },
    ]);
  });

  it("keeps byte-identical records that different runs wrote for one thread", () => {
    const event: DiagRecord = { t: 2000, n: 2, th: "a", k: "ev", ch: "agent.created", d: "same" };
    NodeFS.writeFileSync(runFile("a", "first"), appended([marker("first", 1500), event]));
    NodeFS.writeFileSync(runFile("a", "second"), appended([marker("second", 1600), event]));
    // A third run crashed before its background append landed, so its rewrite is its only copy.
    NodeFS.writeFileSync(runFile("a", "third"), appended([event], true));
    q.thread = "a";
    expect(loadEvidence(q).records).toEqual([
      marker("first", 1500),
      marker("second", 1600),
      { ...event, run: "first" },
      { ...event, run: "second" },
      { ...event, run: "third" },
    ]);
  });

  it("finds every run's file for a thread, by thread id and by modification time, beside an older build's file", () => {
    const event = (d: string): DiagRecord => ({ t: 2000, n: 2, th: "a", k: "ev", ch: "agent.created", d });
    write("a", [marker("old-build", 1500), event("old")]);
    NodeFS.writeFileSync(runFile("a", "first"), appended([event("first")]));
    NodeFS.writeFileSync(runFile("a", "second"), appended([event("second")]));
    NodeFS.writeFileSync(runFile("b", "first"), appended([{ ...event("other thread"), th: "b" }]));
    const threadA = (records: DiagRecord[]) => records
      .filter((record) => record.th === "a" && record.k === "ev")
      .map((record) => [Reflect.get(record, "run"), record.d])
      .sort();
    const expected = [["first", "first"], ["old-build", "old"], ["second", "second"]];

    expect(threadA(readRecordings(dir, { kind: "threads", threadIds: ["a"] }))).toEqual(expected);
    expect(threadA(readRecordings(dir, { kind: "modified-since", since: 0 }))).toEqual(expected);
    expect(readRecordings(dir, { kind: "threads", threadIds: ["a"] }).some((record) => record.th === "b")).toBe(false);
  });

  describe("records the real recorder appended", () => {
    interface HeldAppend {
      /** Settles once the first part has landed and the rest is held. */
      readonly entered: Promise<void>;
      /** Settles once the rest has landed. */
      readonly landed: Promise<void>;
      release(): void;
      /** Lets an append held with `reply: "when-answered"` report back. */
      answer(): void;
    }

    interface HoldOptions {
      /** Holds only an append whose text contains this, so two recorders' appends are held apart. */
      from?: string;
      firstPart?: (text: string) => string;
      /** "never" is a process that exits after the bytes land but before the callback runs. */
      reply?: "at-once" | "when-answered" | "never";
    }

    /** Each held append, in the order it was asked for; one spy serves them all. */
    let holds: Array<{ matches(file: string, text: string): boolean; run(file: string, text: string): Promise<void> }> = [];

    beforeEach(() => {
      holds = [];
    });

    function diagDir(): string {
      return NodePath.join(dir, "diagnostics");
    }

    /** Any recording file of the thread, whatever the layout names it. */
    function isThreadFile(file: string, threadId: string): boolean {
      if (NodePath.basename(NodePath.dirname(file)) !== "t") return false;
      return NodePath.basename(file).startsWith(recordingFileId(threadId) + ".");
    }

    // Bound before any spy replaces it, so a held append writes its parts for real.
    const realAppend = NodeFS.promises.appendFile.bind(NodeFS.promises);

    /**
     * Holds the first background append to one thread file, as a slow disk does: `firstPart` lands
     * at once and the rest after release().
     */
    function holdThreadAppend(threadId: string, options: HoldOptions = {}): HeldAppend {
      const [release, gate] = signal();
      const [answer, answered] = signal();
      const [enter, entered] = signal();
      const [land, landed] = signal();
      let used = false;
      holds.push({
        matches: (file, text) => !used && isThreadFile(file, threadId) && text.includes(options.from ?? ""),
        async run(file, text) {
          used = true;
          const first = options.firstPart?.(text) ?? "";
          if (first) await realAppend(file, first);
          enter();
          await gate;
          await realAppend(file, text.slice(first.length));
          land();
          if (options.reply === "never") await new Promise<never>(() => {});
          if (options.reply === "when-answered") await answered;
        },
      });
      if (!vi.isMockFunction(NodeFS.promises.appendFile)) {
        vi.spyOn(NodeFS.promises, "appendFile").mockImplementation(async (file, data, appendOptions) => {
          const hold = holds.find((candidate) => candidate.matches(String(file), String(data)));
          return hold ? hold.run(String(file), String(data)) : realAppend(file, data, appendOptions);
        });
      }
      return { entered, landed, release, answer };
    }

    function signal(): [() => void, Promise<void>] {
      let settle = (): void => {};
      const settled = new Promise<void>((resolve) => { settle = resolve; });
      return [() => settle(), settled];
    }

    function startRecorder(): DiagRecorder {
      const recorder = new DiagRecorder();
      recorder.configure({ dir: diagDir(), enabled: true });
      return recorder;
    }

    function runIds(): string[] {
      return NodeFS.readdirSync(NodePath.join(diagDir(), "p")).map((name) => name.replace(/\.jsonl$/u, ""));
    }

    function threadEvents(threadId: string): DiagRecord[] {
      const records = readRecordings(dir, { kind: "threads", threadIds: [threadId] });
      return records.filter((record) => record.th === threadId && record.k === "ev");
    }

    function runOf(record: DiagRecord): unknown {
      return Reflect.get(record, "run");
    }

    function operationOf(record: DiagRecord): unknown {
      return Reflect.get(Object(record.d), "operation");
    }

    it("reads each record once when recording stops while a background append is still pending", async () => {
      const held = holdThreadAppend("a");
      const recorder = startRecorder();
      for (let i = 0; i < 500; i++) {
        recorder.emit("cursor.session", { th: "a" }, () => ({ operation: "event-" + i }));
      }
      await held.entered;
      // Stopping flushes synchronously, so the pending batch is rewritten before its append lands.
      recorder.configure({ enabled: false });
      held.release();
      await held.landed;

      expect(threadEvents("a").map(operationOf)).toEqual(
        Array.from({ length: 500 }, (_, i) => "event-" + i),
      );
    });

    it("attributes an older build's records after its marker to that build, below a newer build's append", () => {
      const nightly = startRecorder();
      nightly.emit("cursor.session", { th: "a" }, () => ({ operation: "nightly" }));
      nightly.flushSync();
      const [nightlyRun] = runIds();
      // An older build writes no append headers: its marker, then its record.
      const olderBuild: DiagRecord[] = [
        { t: Date.now(), n: 1, th: "a", k: "run", ch: "diag", run: "old-build", pid: 41, state: "on" },
        { t: Date.now(), n: 2, th: "a", k: "ev", ch: "cursor.session", d: { operation: "old" } },
      ];
      NodeFS.appendFileSync(
        recordingPath("t", "a.jsonl"),
        olderBuild.map((row) => JSON.stringify(row) + "\n").join(""),
      );

      expect(threadEvents("a").map((record) => [runOf(record), operationOf(record)])).toEqual([
        [nightlyRun, "nightly"],
        ["old-build", "old"],
      ]);
    });

    it("keeps each run's records when another run's append lands inside a split append that crashed", async () => {
      // One clock makes the two runs' second records byte-identical, as two builds can write them.
      vi.spyOn(Date, "now").mockReturnValue(2000);
      const held = holdThreadAppend("a", {
        // The first part ends 20 bytes into the record both runs write alike.
        firstPart: (text) => text.slice(0, text.lastIndexOf("\n", text.indexOf('"same"')) + 1 + 20),
        reply: "never",
      });
      const first = startRecorder();
      first.emit("cursor.session", { th: "a" }, () => ({ operation: "same" }));
      first.emit("cursor.session", { th: "a" }, () => ({ operation: "later" }));
      await held.entered;
      const [firstRun] = runIds();

      const second = startRecorder();
      second.emit("cursor.session", { th: "a" }, () => ({ operation: "same" }));
      second.flushSync();
      const secondRun = runIds().find((run) => run !== firstRun);

      held.release();
      await held.landed;
      first.flushSync();

      const read = threadEvents("a").map((record) => [runOf(record), record.n, operationOf(record)]);
      expect(read.sort()).toEqual([
        [firstRun, 2, "same"],
        [firstRun, 4, "later"],
        [secondRun, 2, "same"],
      ].sort());
    });

    it("reads each run's records once when two runs' torn appends and rewrites interleave on one thread", async () => {
      const first = startRecorder();
      // The first run's append lands up to the end of its first event and holds the rest.
      const firstHeld = holdThreadAppend("a", {
        from: '"first-1"',
        firstPart: (text) => text.slice(0, text.indexOf("\n", text.indexOf('"first-1"')) + 1),
      });
      for (const i of [1, 2, 3]) first.emit("cursor.session", { th: "a" }, () => ({ operation: "first-" + i }));
      await firstHeld.entered;
      const [firstRun] = runIds();

      const second = startRecorder();
      // The second run's append tears its second event and does not report back until told.
      const secondHeld = holdThreadAppend("a", {
        from: '"second-1"',
        firstPart: (text) => text.slice(0, text.indexOf('"second-2"')),
        reply: "when-answered",
      });
      for (const i of [1, 2, 3]) second.emit("cursor.session", { th: "a" }, () => ({ operation: "second-" + i }));
      await secondHeld.entered;
      const secondRun = runIds().find((run) => run !== firstRun);

      first.flushSync();
      secondHeld.release();
      await secondHeld.landed;
      firstHeld.release();
      await firstHeld.landed;
      second.flushSync();
      secondHeld.answer();

      expect(threadEvents("a").map((record) => [runOf(record), operationOf(record)]).sort()).toEqual([
        [firstRun, "first-1"], [firstRun, "first-2"], [firstRun, "first-3"],
        [secondRun, "second-1"], [secondRun, "second-2"], [secondRun, "second-3"],
      ].sort());
    });

    it("attributes an older build's records to it when it resumes without a new marker after a newer build", () => {
      const olderBuild = (rows: DiagRecord[]): void => {
        NodeFS.appendFileSync(recordingPath("t", "a.jsonl"), rows.map((row) => JSON.stringify(row) + "\n").join(""));
      };
      // An older build marks a thread once, on its first record there.
      olderBuild([
        { t: Date.now(), n: 1, th: "a", k: "run", ch: "diag", run: "stable", pid: 41, state: "on" },
        { t: Date.now(), n: 2, th: "a", k: "ev", ch: "cursor.session", d: { operation: "stable-1" } },
      ]);
      const nightly = startRecorder();
      nightly.emit("cursor.session", { th: "a" }, () => ({ operation: "nightly" }));
      nightly.flushSync();
      olderBuild([{ t: Date.now(), n: 3, th: "a", k: "ev", ch: "cursor.session", d: { operation: "stable-2" } }]);

      expect(threadEvents("a").map((record) => [runOf(record), operationOf(record)]).sort()).toEqual([
        [runIds()[0], "nightly"],
        ["stable", "stable-1"],
        ["stable", "stable-2"],
      ].sort());
    });

    it("never takes a header-shaped payload at the end of a torn line for a writer", async () => {
      const forged = '{"writer":"forged","batch":7,"records":1}';
      NodeFS.appendFileSync(recordingPath("t", "a.jsonl"), [
        { t: Date.now(), n: 1, th: "a", k: "run", ch: "diag", run: "stable", pid: 41, state: "on" },
        { t: Date.now(), n: 2, th: "a", k: "ev", ch: "cursor.session", d: { operation: "stable-1" } },
      ].map((row) => JSON.stringify(row) + "\n").join(""));
      // The append tears right after the payload object, and the process exits after flushing.
      const held = holdThreadAppend("a", {
        firstPart: (text) => text.slice(0, text.indexOf(forged) + forged.length),
        reply: "never",
      });
      const nightly = startRecorder();
      nightly.emit("cursor.wire", { th: "a" }, () => ({ raw: { writer: "forged", batch: 7, records: 1 } }));
      await held.entered;
      nightly.flushSync();
      NodeFS.appendFileSync(recordingPath("t", "a.jsonl"), JSON.stringify(
        { t: Date.now(), n: 3, th: "a", k: "ev", ch: "cursor.session", d: { operation: "stable-2" } },
      ) + "\n");

      expect(threadEvents("a").map((record) => [runOf(record), record.ch]).sort()).toEqual([
        [runIds()[0], "cursor.wire"],
        ["stable", "cursor.session"],
        ["stable", "cursor.session"],
      ].sort());
    });
  });

  it("includes process records on lane - in a scoped timeline, including channel and JSON selection", () => {
    write("a", [begin("a")]);
    const row: DiagRecord = { t: 3000, n: 2, k: "ev", ch: "rpc.request", d: { approval: "request", outcome: "ok" } };
    writeLines(recordingPath("p", "run.jsonl"), [row, { ...row, t: WINDOW_END + 1, n: 3 }]);
    q.thread = "a";
    expect(render()).toContain("L2 +1000ms - ev rpc.request");
    const evidence = loadEvidence(q);
    const jsonRows = renderJson(evidence, [], { ...q, channels: ["rpc.request"], json: true }).split("\n").slice(1).map((line) => JSON.parse(line));
    expect(jsonRows).toEqual([{ ...row, run: "run" }]);
    expect(renderText(evidence, [], { ...q, channels: ["approval"] })).not.toContain("ev rpc.request");
  });

  it("keeps run markers in the coverage header without rendering timeline rows", () => {
    write("a", [begin("a")]);
    writeLines(recordingPath("p", "run.jsonl"), [{ t: 1500, n: 1, k: "run", ch: "diag", run: "run-1", pid: 1, state: "on" }]);
    q.thread = "a";
    expect(render()).toContain("run=run-1");
    expect(render().split("\n").filter((line) => /^L\d+ /.test(line))).toHaveLength(1);
    expect(renderJson(loadEvidence(q), [], q).split("\n").slice(1).map((line) => JSON.parse(line))).toEqual([begin("a")]);
  });

  it("distinguishes a human wait from an overdue action and sorts the summary", () => {
    write("waiting", [begin("waiting")]);
    write("stuck", [begin("stuck", "agent.send", 30_000)]);

    const evidence = loadEvidence(q);
    const findings = findAnomalies(evidence, q);

    expect(findings.map((f) => [f.thread, f.rule, f.certainty]).sort()).toEqual([
      ["stuck", "open-span", "observed"],
      ["waiting", "waiting", "waiting"],
    ]);
    const text = renderText(evidence, findings, q);
    expect(text.indexOf("stuck  unknown")).toBeLessThan(text.indexOf("waiting  unknown"));
    expect(text).not.toContain("TIMELINE");
  });

  it("keeps the newest rows when the timeline exceeds the limit, timed from the first shown row", () => {
    const created: DiagRecord[] = Array.from({ length: 5 }, (_, i) => ({
      t: 5000 + i * 100, n: i + 1, th: "a", k: "ev", ch: "agent.created", d: { mode: "m" + i },
    }));
    write("a", [
      ...created,
      { t: 6000, n: 6, th: "a", k: "beg", ch: "agent.stop", sp: "stop", exp: 10_000 },
      { t: 6250, n: 7, th: "a", k: "end", ch: "agent.stop", sp: "stop", ok: "ok", ms: 250 },
    ]);
    q.thread = "a";
    q.limit = 3;

    const text = render();

    expect(text).toContain("(7 rows; 4 earlier rows elided)");
    expect(text).toContain("L5 +0ms A ev agent.created");
    expect(text).toContain("L7 +850ms A end agent.stop#stop ok 250ms");
    expect(text).not.toContain('{"mode":"m0"}');
  });

  it("hides high-volume rows from the default timeline but still counts them as lane activity", () => {
    const pushes: DiagRecord[] = Array.from({ length: 20 }, (_, i) => ({
      t: 3000 + i * 1000, n: i + 2, th: "a", k: "ev", ch: "push.canonical", d: { phase: "running", events: 1, children: 0 },
    }));
    write("a", [
      { t: 2000, n: 1, th: "a", k: "ev", ch: "agent.created" },
      ...pushes,
      { t: 23_000, n: 30, th: "a", k: "ev", ch: "claude.stream", d: { type: "stream_event", eventType: "content_block_delta" } },
      { t: 23_100, n: 31, th: "a", k: "ev", ch: "claude.stream", d: { type: "assistant", tools: [{ name: "Agent", id: "toolu_1" }] } },
    ]);
    q.thread = "a";

    const text = render();

    expect(text).not.toContain("push.canonical");
    expect(text).not.toContain("content_block_delta");
    expect(text).toContain('L2 +21100ms A ev claude.stream {"type":"assistant","tools":[{"name":"Agent","id":"toolu_1"}]}');
    expect(text).toMatch(/\nL1 [^\n]*\nL2 /);
    expect(text).toContain("(2 rows; 0 earlier rows elided; 21 detail rows hidden");

    q.channels = ["push.canonical"];
    expect(render()).toContain("(20 rows; 0 earlier rows elided)");
  });

  it("points a finding at the line number the timeline prints when older rows are elided", () => {
    write("a", [
      begin("a", "agent.send", 30_000),
      ...[3000, 4000, 5000].map((t, i): DiagRecord => ({ t, n: i + 2, th: "a", k: "ev", ch: "agent.created", d: { mode: "m" + i } })),
    ]);
    q.thread = "a";
    q.limit = 2;

    const text = render();

    expect(text).toContain("A observed open-span");
    expect(text).toMatch(/open-span .* \[L4\]/);
    expect(text).toContain('L4 +1000ms A ev agent.created {"mode":"m2"}');
  });

  it("prints every row as JSON, hidden ones included, keeping the newest under the limit", () => {
    write("a", [
      { t: 2000, n: 1, th: "a", k: "ev", ch: "agent.created" },
      { t: 3000, n: 2, th: "a", k: "ev", ch: "push.canonical", d: { phase: "running", events: 1, children: 0 } },
      { t: 4000, n: 3, th: "a", k: "ev", ch: "agent.created", d: { mode: "last" } },
    ]);

    q.thread = "a";
    q.limit = 2;
    const evidence = loadEvidence(q);
    const output = renderJson(evidence, findAnomalies(evidence, q), q);

    const rows = output.split(String.fromCharCode(10)).map((line) => JSON.parse(line)).filter((line) => "ch" in line);
    expect(rows.map((row) => [row.t, row.ch])).toEqual([[3000, "push.canonical"], [4000, "agent.created"]]);
  });

  it("names the recording state of each run marker in the timeline", () => {
    write("a", [
      { t: 2000, n: 1, k: "run", ch: "diag", run: "r1", pid: 1, state: "off", th: "a" },
      { t: 3000, n: 2, k: "run", ch: "diag", run: "r1", pid: 1, state: "on", th: "a" },
    ]);
    q.thread = "a";

    const text = render();

    expect(text).toContain("L1 +0ms A recording off run=r1");
    expect(text).toContain("L2 +1000ms A recording on run=r1");
  });

  it("marks a quiet gap as unrecorded when the process switched recording off during it", () => {
    write("a", [
      { t: 2000, n: 1, th: "a", k: "ev", ch: "agent.created" },
      { t: 60_000, n: 9, th: "a", k: "ev", ch: "agent.created" },
    ]);
    writeLines(recordingPath("p", "run.jsonl"), [
      { t: 30_000, n: 5, k: "run", ch: "diag", run: "r2", pid: 1, state: "off" },
    ]);
    q.thread = "a";

    const text = render();

    expect(text).toContain("---- 58s quiet on A (recording off at 1970-01-01T00:00:30.000Z) ----");
  });

  it("pairs begins outside the window and recognizes completed slow spans", () => {
    write("a", [
      begin("a", "agent.send", 30_000),
      { t: 50_000, n: 2, th: "a", k: "end", ch: "agent.send", sp: "request", ok: "ok", ms: 48_000 },
    ]);
    q.since = 10_000;

    const findings = findAnomalies(loadEvidence(q), q);

    expect(findings.map((f) => f.rule)).toEqual(["slow-span"]);
  });

  it.each(["off", "dropped", "on"] as const)("reports incomplete coverage after %s", (state) => {
    const laterRun = state === "on" ? "new" : "old";
    write("a", [
      { t: 1000, n: 0, k: "run", ch: "diag", run: "old", pid: 1, state: "on", th: "a" },
      begin("a", "agent.send", 30_000),
      { t: 3000, n: 2, k: "run", ch: "diag", run: laterRun, pid: 1, state, th: "a" },
    ]);

    const findings = findAnomalies(loadEvidence(q), q);

    expect(findings.map((f) => [f.rule, f.certainty])).toEqual([["incomplete", "incomplete"]]);
  });

  it("reports a stale nonterminal checkpoint unless recording was switched off", () => {
    write("a", [begin("a")]);
    const evidence = loadEvidence(q);
    evidence.threads[0].checkpoint = { phase: "streaming", terminal: null, updated: 2000 };

    const stalls = findAnomalies(evidence, q).filter((f) => f.rule === "stall");
    expect(stalls.map((f) => f.certainty)).toEqual(["observed"]);

    evidence.records.push({ t: 3000, n: 2, k: "run", ch: "diag", run: "one", pid: 1, state: "off" });
    expect(findAnomalies(evidence, q).filter((f) => f.rule === "stall")).toEqual([]);
  });

  it("continues reading when the canonical DB is missing", () => {
    write("a", [begin("a")]);
    q = { ...q, noDb: false, dbPath: NodePath.join(dir, "missing.db"), thread: "a" };

    const text = render();

    expect(text).toContain("canonical DB: missing");
    expect(text).toContain("A beg approval");
  });

  describe("scoped reads", () => {
    it("opens only the named thread's current and rotated files for --thread", () => {
      write("a", [begin("a")]);
      write("b", [begin("b")]);
      writeLines(recordingPath("t", "a.1.jsonl"), [{ ...begin("a"), t: 1500, n: 0, sp: "older" }]);
      q = { ...q, thread: "a" };

      expect(recordedThreadIds()).toEqual(["a"]);
      const text = render();
      expect(text).toContain("older");
      expect(text).not.toContain("B=");
    });

    it("never builds a file path from raw query text", () => {
      NodeFS.writeFileSync(
        NodePath.join(dir, "diagnostics", "outside.jsonl"),
        JSON.stringify({ ...begin("outside") }),
      );
      q = { ...q, thread: "../outside" };

      expect(recordedThreadIds()).toEqual([]);
    });

    it("keeps process records for a thread query", () => {
      write("a", [begin("a")]);
      writeLines(recordingPath("p", "run.jsonl"), [
        { t: 1500, n: 0, k: "run", ch: "diag", run: "one", pid: 1, state: "on" },
      ]);
      q = { ...q, thread: "a" };

      const evidence = loadEvidence(q);

      expect(evidence.records.filter((record) => record.k === "run")).toHaveLength(1);
    });

    it("reads only files modified since the window opened when no scope is given", () => {
      write("recent", [begin("recent")]);
      write("stale", [begin("stale")]);
      NodeFS.utimesSync(recordingPath("t", "stale.jsonl"), 0, 0);

      expect(recordedThreadIds()).toEqual(["recent"]);
    });
  });

  describe("with a canonical database", () => {
    let db: Database;
    let dbPath: string;

    beforeEach(() => {
      dbPath = NodePath.join(dir, "app.sqlite");
      db = openMigratedTestDatabase(dbPath);
      q = { ...q, noDb: false, dbPath };
    });

    afterEach(() => {
      db.close(true);
    });

    function seedWorkspace(id: string): void {
      const workspace = createMockWorkspace({ id, path: dir });
      db.run("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)", [id, workspace.name, id + dir]);
    }

    function seedThread(id: string, workspaceId: string): void {
      const thread = createMockThread({ id, workspaceId });
      db.run("INSERT INTO threads (id, workspace_id, title, branch) VALUES (?, ?, ?, ?)", [
        id,
        workspaceId,
        thread.title,
        thread.branch,
      ]);
    }

    function seedCanonicalThread(id: string, workspaceId: string): void {
      const stamp = new Date(WINDOW_START).toISOString();
      db.run(
        `INSERT INTO canonical_agent_threads
           (id, workspace_id, root_thread_id, provider_id, activity_state, created_at, updated_at)
         VALUES (?, ?, ?, 'codex', 'idle', ?, ?)`,
        [id, workspaceId, id, stamp, stamp],
      );
      db.run(
        `INSERT INTO canonical_agent_turns
           (id, thread_id, execution_id, status, trigger_json, permission_mode, created_at, updated_at)
         VALUES (?, ?, ?, 'running', '{}', 'default', ?, ?)`,
        ["turn-" + id, id, "exec-" + id, stamp, stamp],
      );
    }

    function seedCheckpoint(threadId: string, updatedAt: number): void {
      db.run(
        `INSERT INTO canonical_agent_ingest_checkpoints
           (execution_id, thread_id, turn_id, last_accepted_sequence, last_durable_sequence, phase, updated_at)
         VALUES (?, ?, ?, 0, 0, 'streaming', ?)`,
        ["exec-" + threadId, threadId, "turn-" + threadId, new Date(updatedAt).toISOString()],
      );
    }

    function seedEvent(
      threadId: string,
      sequence: number,
      acceptedAt: number,
      envelope = '{"payload":{"type":"textDelta"}}',
    ): void {
      const stamp = new Date(acceptedAt).toISOString();
      db.run(
        `INSERT INTO canonical_agent_events
           (event_id, thread_id, execution_id, accepted_sequence, durable_revision, envelope_json, accepted_at, persisted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [`event-${threadId}-${sequence}`, threadId, "exec-" + threadId, sequence, sequence, envelope, stamp, stamp],
      );
    }

    function seedActiveThread(id: string, workspaceId: string): void {
      seedThread(id, workspaceId);
      seedCanonicalThread(id, workspaceId);
    }

    function delegate(childId: string, coordinatorId: string): void {
      db.run("UPDATE threads SET delegation_coordinator_thread_id = ? WHERE id = ?", [coordinatorId, childId]);
    }

    it("follows delegation from a thread query into child lanes in any workspace", () => {
      seedWorkspace("ws");
      seedWorkspace("ws-child-worktree");
      seedThread("parent", "ws");
      seedThread("child", "ws-child-worktree");
      seedThread("grandchild", "ws-child-worktree");
      seedThread("bystander", "ws");
      delegate("child", "parent");
      delegate("grandchild", "child");
      write("grandchild", [begin("grandchild", "mcp.tool", 60_000)]);
      write("child", [begin("child", "delegate.launch", 60_000)]);
      write("parent", [{ t: 1500, n: 1, th: "parent", k: "ev", ch: "delegate.task", d: { step: "claimed" } }]);
      write("bystander", [begin("bystander")]);
      q = { ...q, thread: "parent" };

      const text = render();

      expect(text).toContain("A=parent");
      expect(text).toMatch(/B=child .*\(delegated by A\)/);
      expect(text).toMatch(/C=grandchild .*\(delegated by B\)/);
      expect(text).toContain("C observed open-span mcp.tool#request");
      expect(text).not.toContain("bystander");
    });

    it("names the item kind of a recorded item", () => {
      seedWorkspace("ws");
      seedActiveThread("a", "ws");
      seedEvent("a", 1, 3000, '{"payload":{"type":"item.recorded","item":{"kind":"tool-call"}}}');
      q = { ...q, thread: "a" };

      expect(render()).toContain('db.canonical {"type":"item.recorded","item":"tool-call","sequence":1}');
    });

    it("joins workspace membership and interleaves lanes", () => {
      seedWorkspace("ws");
      for (const id of ["a", "b"]) {
        seedThread(id, "ws");
        write(id, [begin(id)]);
      }
      q = { ...q, workspace: "ws" };

      const text = render();

      expect(text).toContain("canonical DB: available");
      expect(text).toContain("A=a");
      expect(text).toContain("B=b");
      expect(text).toContain("A beg approval");
      expect(text).toContain("B beg approval");
    });

    it("opens only the files of the workspace's threads for --workspace", () => {
      seedWorkspace("ws-1");
      seedWorkspace("ws-2");
      seedThread("a", "ws-1");
      seedThread("b", "ws-1");
      seedThread("c", "ws-2");
      for (const id of ["a", "b", "c"]) write(id, [begin(id)]);
      q = { ...q, workspace: "ws-1" };

      expect(recordedThreadIds()).toEqual(["a", "b"]);
    });

    it("lists only threads active in the window when no scope is given", () => {
      seedWorkspace("ws");
      seedActiveThread("recorded", "ws");
      seedActiveThread("checkpointed", "ws");
      seedActiveThread("idle", "ws");
      write("recorded", [begin("recorded")]);
      seedCheckpoint("checkpointed", 5000);
      seedCheckpoint("idle", WINDOW_END + 60_000);

      const evidence = loadEvidence(q);

      expect(evidence.threads.map((view) => view.id).sort()).toEqual(["checkpointed", "recorded"]);
    });

    it("bounds canonical events by the window", () => {
      seedWorkspace("ws");
      seedActiveThread("a", "ws");
      seedEvent("a", 1, WINDOW_START - 500);
      seedEvent("a", 2, 5000);
      seedEvent("a", 3, WINDOW_END + 500);
      q = { ...q, thread: "a" };

      const evidence = loadEvidence(q);

      const canonical = evidence.threads[0].rows.filter((row) => row.ch === "db.canonical");
      expect(canonical.map((row) => row.d)).toEqual([{ type: "textDelta", sequence: 2 }]);
    });

    it("reads each thread's newest checkpoint, with its title and workspace, in a workspace query", () => {
      seedWorkspace("ws");
      seedActiveThread("a", "ws");
      seedCheckpoint("a", 5000);
      q = { ...q, workspace: "ws" };

      const view = loadEvidence(q).threads[0];

      expect(view).toMatchObject({ id: "a", workspace: "ws", checkpoint: { phase: "streaming", updated: 5000 } });
    });
  });
});
