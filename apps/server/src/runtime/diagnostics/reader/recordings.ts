import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { parseDiagLine, recordingFileId, type DiagRecord } from "@mcode/shared/diagnostics";
import { compareByTime } from "./model.js";

const SEGMENT_SUFFIX = ".jsonl";
const ROTATED_SUFFIX = ".1.jsonl";

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

function threadFiles(root: string, selection: RecordingSelection): string[] {
  const folder = NodePath.join(root, "t");
  if (selection.kind === "modified-since") {
    const fileIds = fileIdsModifiedSince(folder, selection.since);
    return fileIds.flatMap((fileId) => segmentsOf(folder, fileId));
  }
  const fileIds = selection.threadIds.map((threadId) => recordingFileId(threadId));
  return fileIds.flatMap((fileId) => segmentsOf(folder, fileId));
}

function processFiles(root: string): string[] {
  const folder = NodePath.join(root, "p");
  const names = listNames(folder).filter((name) => name.endsWith(SEGMENT_SUFFIX));
  return names.map((name) => NodePath.join(folder, name));
}

function readRecordingFile(file: string): DiagRecord[] {
  const records: DiagRecord[] = [];
  const processFile = NodePath.basename(NodePath.dirname(file)) === "p";
  // A process file is named for its run. A thread file is shared by runs, and each run writes its
  // marker before its first record there, so a record belongs to the marker above it.
  let run: string | undefined = processFile ? NodePath.basename(file).replace(/(?:\.1)?\.jsonl$/u, "") : undefined;
  for (const line of NodeFS.readFileSync(file, "utf8").split("\n")) {
    const record = parseDiagLine(line);
    if (!record) continue;
    if (record.k === "run") {
      if (!processFile) run = record.run;
      records.push(record);
    } else {
      const attributed = run === undefined ? record : { ...record, run };
      records.push(attributed);
    }
  }
  return records;
}

/** Read the selected thread files plus every process file, ordered by time. */
export function readRecordings(dataDir: string, selection: RecordingSelection): DiagRecord[] {
  const root = NodePath.join(dataDir, "diagnostics");
  const files = [...threadFiles(root, selection), ...processFiles(root)];
  const records = files.flatMap((file) => readRecordingFile(file));
  return records.sort(compareByTime);
}
