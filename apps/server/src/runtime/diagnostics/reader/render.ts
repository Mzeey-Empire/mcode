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

/** Rows inside the window and on the requested channels; the JSON output prints all of them. */
export function selectTimelineRows(evidence: Evidence, q: DiagQuery): DiagRecord[] {
  const channels = q.channels;
  const rows = windowRows(evidence, q);
  if (!channels) return rows;
  return rows.filter((row) => channels.includes(row.ch));
}

function payloadOf(row: DiagRecord): Record<string, unknown> {
  const d = row.k === "run" ? undefined : row.d;
  return d !== null && typeof d === "object" && !Array.isArray(d) ? { ...d } : {};
}

const QUIET_CLAUDE_SYSTEM = new Set(["status", "thinking_tokens", "hook_progress"]);
const QUIET_CANONICAL = new Set(["publication.recorded", "item.content-appended"]);
const QUIET_CANONICAL_ITEMS = new Set(["system", "reasoning"]);

/**
 * Rows a turn produces by the hundred: stream deltas, status ticks, and push acknowledgements.
 * A two-minute delegated turn recorded about 2,600 of them, which pushed its tool calls and turn
 * events out of the default timeline. Naming a channel with --ch shows them again.
 */
const DETAIL_ROWS: Partial<Record<string, (d: Record<string, unknown>) => boolean>> = {
  "push.canonical": () => true,
  "claude.stream": (d) => {
    if (d.tools || d.results) return false;
    return d.type === "stream_event" || d.type === "assistant" || (d.type === "system" && QUIET_CLAUDE_SYSTEM.has(String(d.subtype)));
  },
  "db.canonical": (d) => {
    if (QUIET_CANONICAL.has(String(d.type))) return true;
    return d.type === "item.recorded" && QUIET_CANONICAL_ITEMS.has(String(d.item));
  },
};

function isDetailRow(row: DiagRecord): boolean {
  return DETAIL_ROWS[row.ch]?.(payloadOf(row)) ?? false;
}

/** The rows the text timeline numbers: every requested channel, or everything but detail rows. */
function displayedRows(rows: readonly DiagRecord[], q: DiagQuery): DiagRecord[] {
  return q.channels ? [...rows] : rows.filter((row) => !isDetailRow(row));
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

interface Displayed {
  rows: DiagRecord[];
  visible: DiagRecord[];
  /** Index in `visible` of the first printed row; the limit keeps the newest rows. */
  firstShown: number;
}

function displayed(evidence: Evidence, q: DiagQuery): Displayed {
  const rows = selectTimelineRows(evidence, q);
  const visible = displayedRows(rows, q);
  // A stuck thread shows its fault at the end, so the limit keeps the newest rows.
  return { rows, visible, firstShown: Math.max(0, visible.length - q.limit) };
}

/** Collapses consecutive identical rows into one line followed by an `xN` count. */
function repeatCollapser(lines: string[]) {
  let previousText = "";
  let repeats = 0;
  const flush = (): void => {
    if (repeats > 0) lines.push("x" + (repeats + 1));
    repeats = 0;
  };
  const push = (text: string, line: string): void => {
    if (text === previousText) {
      repeats += 1;
      return;
    }
    flush();
    lines.push(line);
    previousText = text;
  };
  return { flush, push };
}

function timeline(evidence: Evidence, lanes: Map<string, string>, q: DiagQuery, view: Displayed): string[] {
  const lines = ["TIMELINE"];
  const processMarkers = evidence.records.filter(isRunMarker).filter((row) => !row.th);
  const lastSeenByLane = new Map<string, number>();
  const shown = new Set(view.visible.slice(view.firstShown));
  const rows = repeatCollapser(lines);
  let lineNumber = view.firstShown;

  const origin = view.visible[view.firstShown]?.t ?? q.since;
  lines.push("from " + isoTime(origin));

  // Hidden rows still count as activity, so a quiet line means the lane really went silent.
  for (const row of view.rows) {
    if (row.t < origin) continue;
    const lane = lanes.get(row.th ?? "") ?? "-";
    const lastSeen = lastSeenByLane.get(lane);
    if (lastSeen !== undefined && row.t - lastSeen > QUIET_GAP_MS) {
      rows.flush();
      lines.push(quietLine(lane, lastSeen, row.t, processMarkers));
    }
    lastSeenByLane.set(lane, row.t);
    if (!shown.has(row)) continue;
    lineNumber += 1;
    const text = rowText(row, lane);
    rows.push(text, "L" + lineNumber + " +" + (row.t - origin) + "ms " + text);
  }
  rows.flush();

  lines.push(...quietTails(lastSeenByLane, q.until, processMarkers));
  lines.push(footer(view));
  return lines;
}

function footer(view: Displayed): string {
  const hidden = view.rows.length - view.visible.length;
  const detail = hidden > 0 ? "; " + hidden + " detail rows hidden, name their channel with --ch to show them" : "";
  return "(" + view.visible.length + " rows; " + view.firstShown + " earlier rows elided" + detail + ")";
}

/** Point a finding at the last displayed row of its thread at or before the finding's time. */
function reference(finding: Finding, view: Displayed): string {
  let index = -1;
  view.visible.forEach((row, position) => {
    if (row.th === finding.thread && row.t <= finding.t) index = position;
  });
  if (index < view.firstShown) return " [outside displayed rows]";
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
    const parentLane = view.coordinator ? lanes.get(view.coordinator) : undefined;
    const delegatedBy = parentLane ? " (delegated by " + parentLane + ")" : "";
    return lanes.get(view.id) + "=" + view.id + " " + lineText(view.title ?? "") + delegatedBy;
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
  const view = displayed(evidence, q);
  const ordered = [...findings].sort((a, b) => a.thread.localeCompare(b.thread));
  for (const item of ordered) {
    const lane = lanes.get(item.thread) ?? "-";
    lines.push(lane + " " + item.certainty + " " + item.rule + " " + item.message + reference(item, view));
  }
  return [...lines, ...timeline(evidence, lanes, q, view)].join("\n");
}

/** Coverage, findings, then raw rows as JSON lines, with no row hidden. */
export function renderJson(evidence: Evidence, findings: Finding[], q: DiagQuery): string {
  const coverage = {
    dataDir: q.dataDir,
    db: q.dbPath,
    status: evidence.database,
    since: q.since,
    until: q.until,
  };
  // Like the text timeline, keep the newest rows: a stuck thread shows its fault at the end.
  const rows = selectTimelineRows(evidence, q).slice(-q.limit);
  const lines = [
    JSON.stringify({ coverage }),
    ...findings.map((item) => JSON.stringify({ finding: item })),
    ...rows.map((row) => JSON.stringify(row)),
  ];
  return lines.join("\n");
}
