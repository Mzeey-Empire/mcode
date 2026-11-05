import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { parseDiagLine, recordingFileId, type DiagRecord } from "@mcode/shared/diagnostics";
import { compareByTime } from "./model.js";

const SEGMENT_SUFFIX = ".jsonl";
const ROTATED_SUFFIX = ".1.jsonl";
const SEGMENT_NAME = /(?:\.1)?\.jsonl$/u;
/** Splits `<thread>.<run>`, the name `threadRecordingFileId` gives one run's thread file. */
const RUN_SEPARATOR = ".";

/** Which thread files a read opens. Process files are always read. */
export type RecordingSelection =
  | { kind: "threads"; threadIds: readonly string[] }
  | { kind: "modified-since"; since: number };

/** One recording's segments, oldest first, and the run that wrote it when only one did. */
interface Recording {
  readonly segments: string[];
  /** Undefined for the thread file older builds share between runs. */
  readonly run: string | undefined;
}

function listNames(folder: string): string[] {
  if (!NodeFS.existsSync(folder)) return [];
  return NodeFS.readdirSync(folder).sort();
}

function segmentsOf(folder: string, fileId: string): string[] {
  const current = NodePath.join(folder, fileId + SEGMENT_SUFFIX);
  const rotated = NodePath.join(folder, fileId + ROTATED_SUFFIX);
  return [rotated, current].filter((file) => NodeFS.existsSync(file));
}

/** Every recording in a folder, once whether or not it has rotated. */
function fileIdsIn(folder: string): string[] {
  const names = listNames(folder).filter((name) => name.endsWith(SEGMENT_SUFFIX));
  return [...new Set(names.map((name) => name.replace(SEGMENT_NAME, "")))];
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

function threadPartOf(fileId: string): string {
  const separatorAt = fileId.indexOf(RUN_SEPARATOR);
  return separatorAt < 0 ? fileId : fileId.slice(0, separatorAt);
}

function runPartOf(fileId: string): string | undefined {
  const separatorAt = fileId.indexOf(RUN_SEPARATOR);
  return separatorAt < 0 ? undefined : fileId.slice(separatorAt + 1);
}

function selectedThreadFileIds(folder: string, selection: RecordingSelection): string[] {
  if (selection.kind === "modified-since") return fileIdsModifiedSince(folder, selection.since);
  const wanted = new Set(selection.threadIds.map((threadId) => recordingFileId(threadId)));
  return fileIdsIn(folder).filter((fileId) => wanted.has(threadPartOf(fileId)));
}

function threadRecordings(root: string, selection: RecordingSelection): Recording[] {
  const folder = NodePath.join(root, "t");
  return selectedThreadFileIds(folder, selection).map((fileId) => ({
    segments: segmentsOf(folder, fileId),
    run: runPartOf(fileId),
  }));
}

function processRecordings(root: string): Recording[] {
  const folder = NodePath.join(root, "p");
  return fileIdsIn(folder).map((fileId) => ({ segments: segmentsOf(folder, fileId), run: fileId }));
}

function linesOf(file: string): string[] {
  return NodeFS.readFileSync(file, "utf8").split("\n");
}

function attribute(record: DiagRecord, run: string | undefined): DiagRecord {
  if (record.k === "run" || run === undefined) return record;
  // Readers carry the writer's run on every record; DiagRecord types only the wire fields.
  const attributed = { ...record, run };
  return attributed;
}

/**
 * A file one run wrote alone. A flush that rewrites a batch whose append may not have landed can
 * leave a record in it twice, in either order, with the original copy torn. A rewrite repeats the
 * record's line exactly, so only an exact repeat is dropped: a sink handed a run id it does not
 * own could write a different record under a number already used, and that record is kept.
 */
function readOwnRecording(segments: readonly string[], run: string): DiagRecord[] {
  const records: DiagRecord[] = [];
  const keptLines: string[] = [];
  let newest = -Infinity;
  // Built only once a number repeats or goes backwards, which only a rewrite causes, so a file
  // without one reads at the cost of a shared file.
  let seen: Set<string> | undefined;
  for (const file of segments) {
    for (const line of linesOf(file)) {
      const record = parseDiagLine(line);
      if (!record) continue;
      if (record.n <= newest) {
        seen ??= new Set(keptLines);
        if (seen.has(line)) continue;
      }
      newest = Math.max(newest, record.n);
      seen?.add(line);
      keptLines.push(line);
      records.push(attribute(record, run));
    }
  }
  return records;
}

/**
 * A thread file older builds share between runs. They never rewrite a batch, and each run writes
 * its marker before its first record there, so a record belongs to the marker above it.
 */
function readSharedRecording(segments: readonly string[]): DiagRecord[] {
  const records: DiagRecord[] = [];
  for (const file of segments) {
    let run: string | undefined;
    for (const line of linesOf(file)) {
      const record = parseDiagLine(line);
      if (!record) continue;
      if (record.k === "run") run = record.run;
      records.push(attribute(record, run));
    }
  }
  return records;
}

function readRecording({ segments, run }: Recording): DiagRecord[] {
  return run === undefined ? readSharedRecording(segments) : readOwnRecording(segments, run);
}

/** Read the selected thread files plus every process file, ordered by time. */
export function readRecordings(dataDir: string, selection: RecordingSelection): DiagRecord[] {
  const root = NodePath.join(dataDir, "diagnostics");
  const recordings = [...threadRecordings(root, selection), ...processRecordings(root)];
  const records = recordings.flatMap((recording) => readRecording(recording));
  return records.sort(compareByTime);
}
