import type { DiagRecord } from "@mcode/shared/diagnostics";
import { compareByTime, type DiagQuery, type Evidence, type Finding } from "./model.js";

type RunMarker = Extract<DiagRecord, { k: "run" }>;

const QUIET_GAP_MS = 5000;

function age(ms: number): string {
  return Math.round(ms / 1000) + "s";
}

function lineText(value: string): string {
  return value.replace(/[\r\n\x1b]/g, " ");
}

function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

function isRunMarker(row: DiagRecord): row is RunMarker {
  return row.k === "run";
}

function inWindow(row: DiagRecord, q: DiagQuery): boolean {
  return row.t >= q.since && row.t <= q.until;
}

function windowRows(evidence: Evidence, q: DiagQuery): DiagRecord[] {
  const rows = evidence.threads.flatMap((view) => view.rows);
  return rows.filter((row) => inWindow(row, q)).sort(compareByTime);
}

/** Rows the timeline and the JSON output show: inside the window and on the requested channels. */
export function selectTimelineRows(evidence: Evidence, q: DiagQuery): DiagRecord[] {
  const channels = q.channels;
  const rows = windowRows(evidence, q);
  if (!channels) return rows;
  return rows.filter((row) => channels.includes(row.ch));
}

function describeIntervals(markers: readonly RunMarker[]): string {
  return markers.map((row) => isoTime(row.t) + " " + row.state + " run=" + row.run).join(", ");
}

function coverageHeader(evidence: Evidence, q: DiagQuery): string[] {
  const retained = evidence.records.filter((row) => row.t <= q.until);
  const recordedInWindow = retained.filter((row) => row.t >= q.since);
  const markers = retained.filter(isRunMarker).filter((row) => !row.th);
  const droppedTotal = markers.reduce((sum, row) => sum + (row.dropped ?? 0), 0);
  const first = recordedInWindow.at(0);
  const last = recordedInWindow.at(-1);

  const lines = [
    "data dir: " + q.dataDir,
    "DB: " + (q.dbPath ?? "none") + "; canonical DB: " + evidence.database,
    "window: " + isoTime(q.since) + " .. " + isoTime(q.until),
    "records: first=" + (first ? isoTime(first.t) : "none") + " last=" + (last ? isoTime(last.t) : "none"),
    "recording intervals: " + describeIntervals(markers),
    "dropped: " + droppedTotal,
  ];
  if (evidence.dbError) lines.push("DB unavailable: " + lineText(evidence.dbError));
  return lines;
}

function spanSuffix(row: DiagRecord): string {
  if (row.k === "beg" || row.k === "end") return "#" + row.sp;
  return "";
}

function outcomeSuffix(row: DiagRecord): string {
  if (row.k !== "end") return "";
  return " " + row.ok + " " + (row.ms ?? "?") + "ms";
}

function rowText(row: DiagRecord, lane: string): string {
  if (isRunMarker(row)) {
    const dropped = row.dropped === undefined ? "" : " dropped=" + row.dropped;
    return lane + " recording " + row.state + " run=" + row.run + dropped;
  }
  const head = lane + " " + row.k + " " + row.ch + spanSuffix(row) + outcomeSuffix(row);
  return head + " " + JSON.stringify(row.d ?? {});
}

/** A thread file only holds markers from runs that wrote to it, so the process markers decide whether a gap was unrecorded. */
function quietLine(lane: string, from: number, to: number, processMarkers: readonly RunMarker[]): string {
  const off = processMarkers.find((marker) => marker.state !== "on" && marker.t > from && marker.t < to);
  const reason = off ? " (recording " + off.state + " at " + isoTime(off.t) + ")" : "";
  return "---- " + age(to - from) + " quiet on " + lane + reason + " ----";
}

function quietTails(lastSeenByLane: Map<string, number>, until: number, processMarkers: readonly RunMarker[]): string[] {
  const lines: string[] = [];
  for (const [lane, lastSeen] of lastSeenByLane) {
    if (until - lastSeen > QUIET_GAP_MS) lines.push(quietLine(lane, lastSeen, until, processMarkers));
  }
  return lines;
}

function timeline(evidence: Evidence, lanes: Map<string, string>, q: DiagQuery): string[] {
  const lines = ["TIMELINE"];
  const rows = selectTimelineRows(evidence, q);
  const processMarkers = evidence.records.filter(isRunMarker).filter((row) => !row.th);
  const lastSeenByLane = new Map<string, number>();
  let previousText = "";
  let repeats = 0;

  const flushRepeats = (): void => {
    if (repeats > 0) lines.push("x" + (repeats + 1));
    repeats = 0;
  };

  // A stuck thread shows its fault at the end, so the limit keeps the newest rows.
  const firstShown = Math.max(0, rows.length - q.limit);
  const shown = rows.slice(firstShown);
  const origin = shown[0]?.t ?? q.since;
  lines.push("from " + isoTime(origin));

  for (const [offset, row] of shown.entries()) {
    const lane = lanes.get(row.th ?? "") ?? "-";
    const lastSeen = lastSeenByLane.get(lane);
    if (lastSeen !== undefined && row.t - lastSeen > QUIET_GAP_MS) {
      flushRepeats();
      lines.push(quietLine(lane, lastSeen, row.t, processMarkers));
    }
    lastSeenByLane.set(lane, row.t);

    const text = rowText(row, lane);
    if (text === previousText) {
      repeats += 1;
      continue;
    }
    flushRepeats();
    lines.push("L" + (firstShown + offset + 1) + " +" + (row.t - origin) + "ms " + text);
    previousText = text;
  }
  flushRepeats();

  lines.push(...quietTails(lastSeenByLane, q.until, processMarkers));
  lines.push("(" + rows.length + " rows; " + firstShown + " earlier rows elided)");
  return lines;
}

function reference(finding: Finding, rows: readonly DiagRecord[], q: DiagQuery): string {
  let index = -1;
  rows.forEach((row, position) => {
    if (row.th === finding.thread && row.t <= finding.t) index = position;
  });
  if (index < 0 || index >= q.limit) return " [outside displayed rows]";
  return " [L" + (index + 1) + "]";
}

interface ThreadSummaryItem {
  anomalies: number;
  last: number;
}

function byAnomaliesThenRecency(a: ThreadSummaryItem, b: ThreadSummaryItem): number {
  if (a.anomalies !== b.anomalies) return b.anomalies - a.anomalies;
  return b.last - a.last;
}

function summary(evidence: Evidence, findings: Finding[], q: DiagQuery): string[] {
  const items = evidence.threads.map((view) => {
    const rows = view.rows.filter((row) => row.t <= q.until);
    const last = rows.at(-1)?.t ?? view.checkpoint?.updated ?? 0;
    const own = findings.filter((item) => item.thread === view.id);
    const anomalies = own.filter((item) => item.certainty === "observed").length;
    const waiting = own.filter((item) => item.certainty === "waiting").length;
    return { view, last, anomalies, waiting };
  });

  const active = items.filter((item) => {
    return item.last >= q.since || findings.some((found) => found.thread === item.view.id);
  });
  const ranked = active.sort(byAnomaliesThenRecency);

  return ranked.slice(0, q.limit).map(({ view, last, anomalies, waiting }) => {
    return [
      view.id,
      view.workspace ?? "unknown",
      lineText(view.title ?? "unknown"),
      age(q.until - last),
      view.checkpoint?.phase ?? "unknown",
      "anomalies=" + anomalies,
      "waiting=" + waiting,
    ].join("  ");
  });
}

function laneLegend(evidence: Evidence, lanes: Map<string, string>): string {
  const entries = evidence.threads.map((view) => {
    return lanes.get(view.id) + "=" + view.id + " " + lineText(view.title ?? "");
  });
  return "lanes: " + entries.join("; ");
}

/** Render a per-thread summary, or an interleaved, lane-labelled timeline for a scoped query. */
export function renderText(evidence: Evidence, findings: Finding[], q: DiagQuery): string {
  const lines = coverageHeader(evidence, q);
  if (!q.thread && !q.workspace) {
    return [...lines, ...summary(evidence, findings, q)].join("\n");
  }

  const lanes = new Map(evidence.threads.map((view, index) => [view.id, String.fromCharCode(65 + index)]));
  lines.push(laneLegend(evidence, lanes));
  lines.push("FINDINGS");
  const referenceRows = windowRows(evidence, q);
  const ordered = [...findings].sort((a, b) => a.thread.localeCompare(b.thread));
  for (const item of ordered) {
    const lane = lanes.get(item.thread) ?? "-";
    lines.push(lane + " " + item.certainty + " " + item.rule + " " + item.message + reference(item, referenceRows, q));
  }
  return [...lines, ...timeline(evidence, lanes, q)].join("\n");
}
