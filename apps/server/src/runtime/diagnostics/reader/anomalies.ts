import type { DiagRecord } from "@mcode/shared/diagnostics";
import { compareByTime, type DiagQuery, type Evidence, type Finding, type ThreadView } from "./model.js";

type Begin = Extract<DiagRecord, { k: "beg" }>;
type End = Extract<DiagRecord, { k: "end" }>;
type Marker = Extract<DiagRecord, { k: "run" }>;

const STALL_AFTER_MS = 60_000;

function secondsBetween(from: number, to: number): number {
  return Math.round((to - from) / 1000);
}

function collectMarkers(view: ThreadView, processRows: readonly DiagRecord[], until: number): Marker[] {
  const markers: Marker[] = [];
  for (const row of [...processRows, ...view.rows]) {
    if (row.k === "run" && row.t <= until) markers.push(row);
  }
  return markers.sort(compareByTime);
}

function coverageLostAfter(begin: Begin, markers: readonly Marker[]): boolean {
  const priorOn = markers.filter((marker) => marker.state === "on" && marker.t <= begin.t).at(-1);
  return markers.some((marker) => {
    if (marker.t <= begin.t) return false;
    if (marker.state !== "on") return true;
    return priorOn !== undefined && marker.run !== priorOn.run;
  });
}

function finding(
  view: ThreadView,
  rule: string,
  certainty: Finding["certainty"],
  t: number,
  message: string,
): Finding {
  return { thread: view.id, rule, certainty, t, message };
}

function inspectEnd(view: ThreadView, end: End, begin: Begin | undefined, markers: Marker[]): Finding[] {
  const found: Finding[] = [];
  const name = end.ch + "#" + end.sp;

  if (!begin) {
    const lastMarker = markers.filter((marker) => marker.t <= end.t).at(-1);
    const wasRecording = lastMarker?.state === "on";
    const certainty = wasRecording ? "observed" : "incomplete";
    found.push(finding(view, "orphan-end", certainty, end.t, name + " has no retained begin"));
  }

  if (begin && begin.exp !== null) {
    const elapsed = end.ms ?? end.t - begin.t;
    if (elapsed > begin.exp) {
      found.push(finding(view, "slow-span", "observed", end.t, name + " exceeded " + begin.exp + "ms"));
    }
  }

  if (end.ok === "error" || end.ok === "rejected") {
    found.push(finding(view, "error-end", "observed", end.t, name + " " + end.ok));
  }
  return found;
}

function inspectOpen(view: ThreadView, begin: Begin, markers: Marker[], until: number): Finding[] {
  const age = secondsBetween(begin.t, until);
  const message = begin.ch + "#" + begin.sp + " open " + age + "s";

  if (coverageLostAfter(begin, markers)) {
    return [finding(view, "incomplete", "incomplete", until, message + "; recording coverage lost")];
  }
  if (begin.exp === null) {
    return [finding(view, "waiting", "waiting", until, message)];
  }
  if (until - begin.t > begin.exp) {
    return [finding(view, "open-span", "observed", until, message)];
  }
  return [];
}

function inspectCheckpoint(view: ThreadView, markers: Marker[], until: number): Finding[] {
  const checkpoint = view.checkpoint;
  if (!checkpoint || checkpoint.terminal) return [];

  const lastRow = view.rows.filter((row) => row.t <= until && row.k !== "run").at(-1);
  const lastActivity = lastRow?.t ?? checkpoint.updated;
  const laterMarkers = markers.filter((marker) => marker.t > lastActivity);
  const switchedOff = laterMarkers.some((marker) => marker.state === "off");
  if (until - lastActivity <= STALL_AFTER_MS || switchedOff) return [];

  const quiet = secondsBetween(lastActivity, until);
  const found = [finding(view, "stall", "observed", until, "checkpoint=" + checkpoint.phase + " quiet " + quiet + "s")];

  const runBefore = markers.filter((marker) => marker.t <= lastActivity).at(-1)?.run;
  const restarted = runBefore !== undefined && laterMarkers.some((marker) => marker.run !== runBefore);
  if (restarted) {
    found.push(finding(view, "restart-mid-turn", "incomplete", until, "server restarted during nonterminal turn"));
  }
  return found;
}

function spanKey(row: Begin | End): string {
  return row.ch + ":" + row.sp;
}

function inspect(view: ThreadView, processRows: readonly DiagRecord[], q: DiagQuery): Finding[] {
  const findings: Finding[] = [];
  const open = new Map<string, Begin>();
  const markers = collectMarkers(view, processRows, q.until);

  for (const row of view.rows) {
    if (row.t > q.until) continue;
    if (row.k === "beg") {
      open.set(spanKey(row), row);
    }
    if (row.k === "end") {
      findings.push(...inspectEnd(view, row, open.get(spanKey(row)), markers));
      open.delete(spanKey(row));
    }
  }

  for (const begin of open.values()) {
    findings.push(...inspectOpen(view, begin, markers, q.until));
  }
  findings.push(...inspectCheckpoint(view, markers, q.until));
  return findings;
}

/** Pair across retained history before selecting findings in the requested window. */
export function findAnomalies(evidence: Evidence, q: DiagQuery): Finding[] {
  const processRows = evidence.records.filter((row) => row.k === "run" && !row.th);
  const findings = evidence.threads.flatMap((view) => inspect(view, processRows, q));

  for (const row of processRows) {
    if (row.k === "run" && row.state === "dropped") {
      findings.push({
        thread: "",
        rule: "dropped",
        certainty: "incomplete",
        t: row.t,
        message: String(row.dropped ?? 0) + " records lost",
      });
    }
  }
  return findings.filter((item) => item.t >= q.since && item.t <= q.until);
}
