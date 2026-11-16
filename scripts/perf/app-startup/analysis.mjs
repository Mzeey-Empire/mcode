import { LaunchRecordSchema } from "../../../packages/contracts/src/launch-telemetry.ts";

const difference = (end, start) => Number.isFinite(end) && Number.isFinite(start) ? end - start : null;
const overlaps = (start, end, otherStart, otherEnd) =>
  start < end && otherStart < otherEnd && start < otherEnd && end > otherStart;

/** Parse only launch candidates, reporting malformed candidates without retaining their contents. */
export function parseLogLines(text) {
  const records = [];
  let invalid = 0;
  for (const line of text.slice(0, text.lastIndexOf("\n") + 1).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      if (line.includes("Launch record")) invalid++;
      continue;
    }
    if (value?.message !== "Launch record") continue;
    const parsed = LaunchRecordSchema().safeParse(value);
    if (parsed.success) records.push(parsed.data);
    else invalid++;
  }
  return { records, invalid };
}

/** Nearest rank, with no estimate when the measured sample is empty. */
export function percentile(values, rank) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(rank * sorted.length) - 1] : null;
}

/**
 * Reduce a record to measurements only, dropping all launch identities and free text. Segments span A T0 to server
 * spawned, B spawned to listen, C listen to healthy, D window created to scripts evaluated, E URL received to the last
 * first-paint answer, and F that answer to the usable frame.
 */
export function analyzeRecord(record) {
  const { main, renderer, serverTelemetry: server } = record;
  const answers = [renderer.workspaceListAnswered, renderer.threadListAnswered, renderer.settingsAnswered];
  const answered = answers.every(Number.isFinite) ? Math.max(...answers) : null;
  const usable = renderer.usable;
  const segments = {
    A: difference(main.serverSpawned, record.t0),
    B: difference(server?.listenAt, main.serverSpawned),
    C: difference(main.serverHealthy, server?.listenAt),
    D: difference(renderer.scriptsEvaluated, main.windowCreated),
    E: difference(answered, renderer.urlReceived),
    F: difference(usable, answered),
    total: difference(usable, record.t0),
  };
  return {
    segments,
    substeps: durationsByEndingMark(main.serverSpawned, server?.marks ?? []),
    settled: settledStatus(server, usable),
    stallAttribution: attributeStalls(record),
    rpcs: server ? { answered: server.rpcs.length, unanswered: server.unansweredRpcs.length, dropped: server.rpcsDropped } : null,
    threadReopened: Number.isFinite(renderer.threadReopened),
  };
}

function durationsByEndingMark(spawnedAt, marks) {
  const durations = {};
  let previous = spawnedAt;
  for (const mark of marks) {
    const elapsed = difference(mark.at, previous);
    if (elapsed !== null) durations[mark.name] = (durations[mark.name] ?? 0) + elapsed;
    previous = mark.at;
  }
  return durations;
}

function settledStatus(server, usable) {
  if (!Number.isFinite(usable) || server === null || server.windowEndAt < usable + 10_000) return null;
  return !server.stalls.some((stall) => stall.endAt - stall.startAt > 250 &&
    overlaps(stall.startAt, stall.endAt, usable, usable + 10_000));
}

function attributeStalls(record) {
  const server = record.serverTelemetry;
  const usable = record.renderer.usable;
  return (server?.stalls ?? []).filter((stall) => stall.endAt - stall.startAt >= 100).map((stall) => ({
    startAfterT0Ms: difference(stall.startAt, record.t0),
    durationMs: stall.endAt - stall.startAt,
    beforeUsable: Number.isFinite(usable) ? stall.startAt < usable : null,
    candidateRpcs: [
      ...server.rpcs.filter((rpc) => overlaps(stall.startAt, stall.endAt, rpc.startAt, rpc.startAt + rpc.durationMs)),
      ...server.unansweredRpcs.filter((rpc) => overlaps(stall.startAt, stall.endAt, rpc.startAt, server.windowEndAt)),
    ].map((rpc) => rpc.method),
    candidateTasks: server.tasks.filter((task) => overlaps(stall.startAt, stall.endAt, task.startAt, task.endAt ?? server.windowEndAt))
      .map((task) => task.name),
  }));
}

/** Aggregate measured values independently for every segment and server step. */
export function aggregate(launches) {
  const accepted = launches.filter((row) => row.failed !== true);
  const result = { launches: launches.length, failed: launches.length - accepted.length };
  for (const field of ["segments", "substeps"]) {
    const names = new Set(field === "segments" ? ["A", "B", "C", "D", "E", "F", "total"] : []);
    for (const row of accepted) for (const name of Object.keys(row[field] ?? {})) names.add(name);
    result[field] = Object.fromEntries([...names].map((name) => {
      const values = accepted.map((row) => row[field]?.[name]).filter(Number.isFinite);
      return [name, {
        measured: values.length,
        unmeasured: accepted.length - values.length,
        p50: percentile(values, 0.5),
        p90: percentile(values, 0.9),
      }];
    }));
  }
  result.settled = accepted.filter((row) => row.settled === true).length;
  result.unsettled = accepted.filter((row) => row.settled === false).length;
  result.settledUnmeasured = accepted.filter((row) => row.settled == null).length;
  result.rpcsAnsweredMax = Math.max(0, ...accepted.map((row) => row.rpcs?.answered ?? 0));
  result.rpcsUnansweredMax = Math.max(0, ...accepted.map((row) => row.rpcs?.unanswered ?? 0));
  result.rpcsDropped = accepted.reduce((sum, row) => sum + (row.rpcs?.dropped ?? 0), 0);
  return result;
}

/** Classify and analyze records in launch order. */
export function classifyRecords(records) {
  const sorted = [...records].sort((a, b) => (a.t0 ?? a.main.mainModuleStart) - (b.t0 ?? b.main.mainModuleStart));
  return sorted.map((record) => ({ record, classification: classify(record), analysis: analyzeRecord(record) }));
}

function classify(record) {
  if (record.writtenBecause === "startup-failed") return "startup-failed";
  if (record.serverMode !== "spawned") return record.serverMode;
  if (record.serverTelemetry?.migrated) return "migrated";
  if (record.firstSinceBoot === null) return "unknown";
  if (record.firstSinceBoot) return "first-since-boot";
  return record.serverTelemetry?.migrated === false ? "normal" : "unknown";
}

/** Widen to include ten measured normal launches, or all available history. */
export function summarizeRecords(records, days = 7, now = Date.now()) {
  const rows = classifyRecords(records);
  const normal = rows.filter((row) => row.classification === "normal" && row.analysis.segments.total !== null);
  const initialCutoff = now - days * 86_400_000;
  const inWindow = normal.filter((row) => row.record.t0 >= initialCutoff);
  let cutoff = initialCutoff;
  if (inWindow.length < 10 && normal.length) cutoff = Math.min(cutoff, normal[Math.max(0, normal.length - 10)].record.t0);
  const selected = normal.filter((row) => row.record.t0 >= cutoff && row.record.t0 <= now);
  const settled = selected.filter((row) => row.analysis.settled === true).length;
  const p90 = percentile(selected.map((row) => row.analysis.segments.total), 0.9);
  const classifications = {};
  for (const row of rows) classifications[row.classification] = (classifications[row.classification] ?? 0) + 1;
  return {
    normalMeasured: selected.length,
    p90,
    settled,
    shareSettled: selected.length ? settled / selected.length : null,
    widened: cutoff < initialCutoff,
    days: Math.max(days, (now - cutoff) / 86_400_000),
    passed: selected.length >= 10 && p90 <= 2_000 && settled / selected.length >= 0.9,
    classifications,
    aggregates: aggregate(selected.map((row) => row.analysis)),
    stalls: selected.map((row) => row.analysis.stallAttribution),
  };
}
