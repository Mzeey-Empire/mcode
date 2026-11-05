import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { parseDiagLine, recordingFileId, type DiagRecord } from "@mcode/shared/diagnostics";
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

/**
 * Reads one recording's segments, oldest first, keeping one copy of each line. A fatal flush
 * rewrites the batch a background append had taken, so a crash can leave that batch twice, with a
 * torn copy before it. The torn line fails to parse. A repeated line is the same record, because
 * the rewrite appends the same text. The record stamp alone is not an identity: two processes can
 * share a thread file and stamp different records with the same `t` and `n`.
 */
function readRecording(segments: readonly string[]): DiagRecord[] {
  const seen = new Set<string>();
  return segments.flatMap((file) => readRecordingFile(file, seen));
}

function readRecordingFile(file: string, seen: Set<string>): DiagRecord[] {
  const records: DiagRecord[] = [];
  const processFile = NodePath.basename(NodePath.dirname(file)) === "p";
  // A process file is named for its run. A thread file is shared by runs, and each run writes its
  // marker before its first record there, so a record belongs to the marker above it.
  let run: string | undefined = processFile ? NodePath.basename(file).replace(SEGMENT_NAME, "") : undefined;
  for (const line of NodeFS.readFileSync(file, "utf8").split("\n")) {
    const record = parseDiagLine(line);
    if (!record) continue;
    // A repeated marker still sets the run for the records written after it.
    if (record.k === "run" && !processFile) run = record.run;
    if (seen.has(line)) continue;
    seen.add(line);
    const attributed = record.k === "run" || run === undefined ? record : { ...record, run };
    records.push(attributed);
  }
  return records;
}

/** Read the selected thread files plus every process file, ordered by time. */
export function readRecordings(dataDir: string, selection: RecordingSelection): DiagRecord[] {
  const root = NodePath.join(dataDir, "diagnostics");
  const recordings = [...threadRecordings(root, selection), ...processRecordings(root)];
  const records = recordings.flatMap((segments) => readRecording(segments));
  return records.sort(compareByTime);
}
