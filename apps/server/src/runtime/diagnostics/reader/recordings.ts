import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
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

/** The lines one recording has shown so far, by the run whose append wrote them. */
type LinesByWriter = Map<string, Set<string>>;

/**
 * Reads one recording's segments, oldest first. A fatal flush rewrites the batch a background
 * append had taken, under a replay header, so a crash can leave that batch twice, with a torn copy
 * before it. The torn line fails to parse. A replayed line is dropped only when the same writer
 * already wrote the same text: two processes can share a thread file and write byte-identical
 * lines, and those are two events.
 */
function readRecording(segments: readonly string[]): DiagRecord[] {
  const seen: LinesByWriter = new Map();
  return segments.flatMap((file) => readRecordingFile(file, seen));
}

function readRecordingFile(file: string, seen: LinesByWriter): DiagRecord[] {
  const records: DiagRecord[] = [];
  const processFile = NodePath.basename(NodePath.dirname(file)) === "p";
  // A record belongs to the run named by its append's header. Files written before headers existed
  // fall back to position: a process file is named for its run, and in a thread file each run
  // writes its marker before its first record there, so a record belongs to the marker above it.
  let markedRun: string | undefined = processFile ? NodePath.basename(file).replace(SEGMENT_NAME, "") : undefined;
  // Nothing in a file without headers is a replay.
  let append: AppendHeader = { writer: "" };
  for (const line of NodeFS.readFileSync(file, "utf8").split("\n")) {
    const record = parseDiagLine(line);
    if (!record) {
      append = parseAppendHeader(line) ?? append;
      continue;
    }
    // A repeated marker still sets the run for the records written after it.
    if (record.k === "run" && !processFile) markedRun = record.run;
    if (!shouldKeepLine(seen, append, line)) continue;
    records.push(attribute(record, append.writer || markedRun));
  }
  return records;
}

function attribute(record: DiagRecord, run: string | undefined): DiagRecord {
  if (record.k === "run" || run === undefined) return record;
  // Readers carry the writer's run on every record; DiagRecord types only the wire fields.
  const attributed = { ...record, run };
  return attributed;
}

/** Keeps every written line, and a replayed line unless its own writer already wrote it. */
function shouldKeepLine(seen: LinesByWriter, append: AppendHeader, line: string): boolean {
  let lines = seen.get(append.writer);
  if (!lines) {
    lines = new Set();
    seen.set(append.writer, lines);
  }
  if (append.replay && lines.has(line)) return false;
  lines.add(line);
  return true;
}

/** Read the selected thread files plus every process file, ordered by time. */
export function readRecordings(dataDir: string, selection: RecordingSelection): DiagRecord[] {
  const root = NodePath.join(dataDir, "diagnostics");
  const recordings = [...threadRecordings(root, selection), ...processRecordings(root)];
  const records = recordings.flatMap((segments) => readRecording(segments));
  return records.sort(compareByTime);
}
