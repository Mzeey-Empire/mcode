import type { DiagRecord } from "@mcode/shared/diagnostics";

/** Reader scope and bounded output window. */
export interface DiagQuery {
  dataDir: string;
  dbPath?: string;
  noDb?: boolean;
  thread?: string;
  workspace?: string;
  since: number;
  until: number;
  channels?: string[];
  limit: number;
  json?: boolean;
}

/** Latest durable ingest state of a thread, read from the canonical database. */
export interface ThreadCheckpoint {
  phase: string;
  terminal: string | null;
  updated: number;
}

/** Durable metadata attached to a recorded thread. */
export interface ThreadView {
  id: string;
  workspace?: string;
  title?: string;
  /** The thread that delegated this one. */
  coordinator?: string;
  rows: DiagRecord[];
  checkpoint?: ThreadCheckpoint;
}

/** Certainty distinguishes witnessed failures from missing evidence and human waits. */
export interface Finding {
  thread: string;
  rule: string;
  certainty: "observed" | "waiting" | "incomplete";
  t: number;
  message: string;
}

/** Inputs retain all records so span pairing precedes window filtering. */
export interface Evidence {
  records: DiagRecord[];
  threads: ThreadView[];
  database: "available" | "missing" | "not used";
  dbError?: string;
}

/** Orders records by wall clock, then by the recorder's sequence number. */
export function compareByTime(a: { t: number; n: number }, b: { t: number; n: number }): number {
  if (a.t !== b.t) return a.t - b.t;
  return a.n - b.n;
}
