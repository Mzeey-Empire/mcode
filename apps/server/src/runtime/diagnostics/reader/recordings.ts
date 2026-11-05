import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  APPEND_HEADER_PREFIX,
  parseAppendHeader,
  parseDiagLine,
  recordingFileId,
  type AppendHeader,
  type DiagRecord,
} from "@mcode/shared/diagnostics";
import { compareByTime } from "./model.js";

const SEGMENT_SUFFIX = ".jsonl";
const ROTATED_SUFFIX = ".1.jsonl";
const SEGMENT_NAME = /(?:\.1)?\.jsonl$/u;

/** Which thread files a read opens. Process files are always read. */
export type RecordingSelection =
  | { kind: "threads"; threadIds: readonly string[] }
  | { kind: "modified-since"; since: number };

function listNames(folder: string): string[] {
  if (!NodeFS.existsSync(folder)) return [];
  return NodeFS.readdirSync(folder).sort();
}

function segmentsOf(folder: string, fileId: string): string[] {
  const current = NodePath.join(folder, fileId + SEGMENT_SUFFIX);
  const rotated = NodePath.join(folder, fileId + ROTATED_SUFFIX);
  return [rotated, current].filter((file) => NodeFS.existsSync(file));
}

function fileIdsModifiedSince(folder: string, since: number): string[] {
  const fileIds: string[] = [];
  for (const name of listNames(folder)) {
    if (!name.endsWith(SEGMENT_SUFFIX) || name.endsWith(ROTATED_SUFFIX)) continue;
    const modifiedAtMs = NodeFS.statSync(NodePath.join(folder, name)).mtimeMs;
    if (modifiedAtMs >= since) fileIds.push(name.slice(0, -SEGMENT_SUFFIX.length));
  }
  return fileIds;
}

function threadRecordings(root: string, selection: RecordingSelection): string[][] {
  const folder = NodePath.join(root, "t");
  const fileIds = selection.kind === "modified-since"
    ? fileIdsModifiedSince(folder, selection.since)
    : selection.threadIds.map((threadId) => recordingFileId(threadId));
  return fileIds.map((fileId) => segmentsOf(folder, fileId));
}

function processRecordings(root: string): string[][] {
  const folder = NodePath.join(root, "p");
  const names = listNames(folder).filter((name) => name.endsWith(SEGMENT_SUFFIX));
  const fileIds = new Set(names.map((name) => name.replace(SEGMENT_NAME, "")));
  return [...fileIds].map((fileId) => segmentsOf(folder, fileId));
}

/** One copy of a batch: the records that followed its header, up to the header's count. */
interface BatchCopy {
  readonly header: AppendHeader;
  readonly records: DiagRecord[];
}

/** Every copy of one batch in a recording. */
interface Batch {
  readonly writer: string;
  readonly copies: BatchCopy[];
}

/**
 * Reads one recording's segments, oldest first, keeping one copy of each batch. A flush that
 * rewrites a batch whose append may not have landed writes the same (writer, batch) header again,
 * so a recording can hold a batch twice, in either order, and exit can tear the original. Records
 * are never compared by text: one batch, or two runs, can write identical lines that are separate
 * events.
 */
class RecordingReader {
  /** Headerless records and batches, each batch where its first copy appeared. */
  private readonly entries: Array<DiagRecord | Batch> = [];
  private readonly batches = new Map<string, Batch>();
  /**
   * Copies still short of their record count, newest last. A record joins the newest, because
   * the rest of an append another append split lands after that other append is complete.
   */
  private open: BatchCopy[] = [];
  /** Where headers are missing, the run whose records follow; see {@link readRecording}. */
  private markedRun: string | undefined;

  constructor(private readonly processRun: string | undefined) {
    this.markedRun = processRun;
  }

  readFile(file: string): void {
    for (const line of NodeFS.readFileSync(file, "utf8").split("\n")) this.readLine(line);
  }

  records(): DiagRecord[] {
    return this.entries.flatMap((entry) => ("copies" in entry ? keptRecords(entry) : [entry]));
  }

  private readLine(line: string): void {
    if (line === "") return;
    if (line.startsWith(APPEND_HEADER_PREFIX)) {
      this.openCopy(parseAppendHeader(line));
      return;
    }
    const record = parseDiagLine(line);
    if (record) {
      this.addRecord(record);
      return;
    }
    // When exit or a split append leaves a line unfinished, the next append's header lands on the
    // end of that fragment. The records after it still need that header.
    const headerAt = line.lastIndexOf(APPEND_HEADER_PREFIX);
    if (headerAt > 0) this.openCopy(parseAppendHeader(line.slice(headerAt)));
  }

  private openCopy(header: AppendHeader | undefined): void {
    if (!header || header.records <= 0) return;
    const key = header.batch + ":" + header.writer;
    let batch = this.batches.get(key);
    if (!batch) {
      batch = { writer: header.writer, copies: [] };
      this.batches.set(key, batch);
      this.entries.push(batch);
    }
    const copy: BatchCopy = { header, records: [] };
    batch.copies.push(copy);
    this.open.push(copy);
  }

  private addRecord(record: DiagRecord): void {
    if (record.k === "run") this.noteMarker(record.run);
    const copy = this.open.at(-1);
    if (!copy) {
      this.entries.push(attribute(record, this.markedRun));
      return;
    }
    copy.records.push(record);
    if (copy.records.length >= copy.header.records) this.open.pop();
  }

  private noteMarker(run: string): void {
    if (this.processRun === undefined) this.markedRun = run;
    // Only a build that writes no headers puts another run's marker here, so no open copy
    // continues past it.
    const copy = this.open.at(-1);
    if (copy && copy.header.writer !== run) this.open = [];
  }
}

/** A rewrite is complete and an original may be torn, so the copy with the most records wins. */
function keptRecords(batch: Batch): DiagRecord[] {
  const kept = batch.copies.reduce((best, copy) => (copy.records.length > best.records.length ? copy : best));
  return kept.records.map((record) => attribute(record, batch.writer));
}

/**
 * A record belongs to the run named by its batch header. Files written before headers existed
 * fall back to position: a process file is named for its run, and in a thread file each run
 * writes its marker before its first record there, so a record belongs to the marker above it.
 */
function readRecording(segments: readonly string[]): DiagRecord[] {
  const [first] = segments;
  if (first === undefined) return [];
  const processFile = NodePath.basename(NodePath.dirname(first)) === "p";
  const reader = new RecordingReader(processFile ? NodePath.basename(first).replace(SEGMENT_NAME, "") : undefined);
  for (const file of segments) reader.readFile(file);
  return reader.records();
}

function attribute(record: DiagRecord, run: string | undefined): DiagRecord {
  if (record.k === "run" || run === undefined) return record;
  // Readers carry the writer's run on every record; DiagRecord types only the wire fields.
  const attributed = { ...record, run };
  return attributed;
}

/** Read the selected thread files plus every process file, ordered by time. */
export function readRecordings(dataDir: string, selection: RecordingSelection): DiagRecord[] {
  const root = NodePath.join(dataDir, "diagnostics");
  const recordings = [...threadRecordings(root, selection), ...processRecordings(root)];
  const records = recordings.flatMap((segments) => readRecording(segments));
  return records.sort(compareByTime);
}
