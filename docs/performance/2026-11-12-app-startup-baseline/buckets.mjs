// Regroups a perf:startup receipt into the cost buckets and per-launch rows that the startup decision note cites.
// Usage: bun docs/performance/2026-11-12-app-startup-baseline/buckets.mjs <receipt.json>
import * as NodeFS from "node:fs";
import { percentile } from "../../../scripts/perf/app-startup/analysis.mjs";

const BUCKETS = {
  "process load": ["bootstrap entered"],
  container: [
    "auth token resolved", "runtime flags resolved", "configuration resolved and shutdown marker inspected",
    "migration plan read", "schema patches applied", "database writer ready", "read-only database opened",
    "snapshot store ID ensured", "dependency container initialized", "services resolved",
  ],
  "late setup and orphan cleanup": ["orphan cleanup completed"],
  "execution workers": ["execution workers ready"],
  recovery: [
    "conversation display materialization completed", "stale startup work recovery completed", "journal import",
    "terminal checkpoint reopening", "terminal checkpoint retirement", "family child interruption",
    "checkpoint interrupted", "turn reconciliation", "abandoned evidence resolved", "native questions recovered",
    "interrupted plans recovered", "resume scheduler started", "coordinator wake recovered", "turn recovery completed",
    "orphaned background tools settled", "approval recovery completed", "external thread control reconciled",
    "automatic workspace setup reconciled",
  ],
  listeners: ["IPC listener opened", "HTTP listener opened"],
};
const bucketOf = new Map(Object.entries(BUCKETS).flatMap(([bucket, steps]) => steps.map((step) => [step, bucket])));
const MAX_BUCKET_GAP_MS = 5;

const sum = (values) => values.reduce((total, value) => total + value, 0);
const row = (cells) => `| ${cells.join(" | ")} |`;
const rounded = (value) => value === null || value === undefined ? "none" : String(Math.round(value));
const ranks = (values) => [0.5, 0.9].map((rank) => rounded(percentile(values, rank)));

function bucketLaunch(launch, label) {
  const sums = Object.fromEntries(Object.keys(BUCKETS).map((bucket) => [bucket, 0]));
  for (const [step, ms] of Object.entries(launch.substeps)) {
    const bucket = bucketOf.get(step);
    if (!bucket) throw new Error(`Server step "${step}" has no bucket; add it to BUCKETS`);
    sums[bucket] += ms;
  }
  const gap = Math.abs(sum(Object.values(sums)) - launch.segments.B);
  if (gap > MAX_BUCKET_GAP_MS) throw new Error(`Launch ${label}: buckets sum to ${gap} ms away from segment B`);
  return { sums, gap };
}

function stalledMs(launch, [start, end]) {
  return sum(launch.stallAttribution.map((stall) =>
    Math.max(0, Math.min(end, stall.startAfterT0Ms + stall.durationMs) - Math.max(start, stall.startAfterT0Ms))));
}

function windows({ A, B, C, E, F, total }) {
  const answered = total - F;
  return { C: [A + B, A + B + C], E: [answered - E, answered], F: [answered, total] };
}

function bucketLines(buckets) {
  const lines = [row(["Segment B bucket", "p50 ms", "p90 ms"]), row(["---", "---", "---"])];
  for (const bucket of Object.keys(BUCKETS)) lines.push(row([bucket, ...ranks(buckets.map(({ sums }) => sums[bucket]))]));
  const largestGap = Math.max(...buckets.map(({ gap }) => gap));
  return [...lines, "", `Largest gap between a launch's bucket sum and its segment B: ${rounded(largestGap)} ms.`, ""];
}

function stallLines(launches) {
  const lines = [row(["Check", "p50 ms", "p90 ms"]), row(["---", "---", "---"])];
  for (const segment of ["C", "E"]) {
    lines.push(row([`segment ${segment}`, ...ranks(launches.map((launch) => launch.segments[segment]))]));
    lines.push(row([`stall time inside ${segment}`,
      ...ranks(launches.map((launch) => stalledMs(launch, windows(launch.segments)[segment])))]));
  }
  const dInsideB = launches.filter((launch) => launch.segments.D < launch.segments.B).length;
  const reopened = launches.filter((launch) => launch.threadReopened).length;
  return [...lines, "",
    `Launches whose D is shorter than their B, so scripts finish before listen: ${dInsideB} of ${launches.length}.`,
    `Launches with a thread reopened: ${reopened}.`, ""];
}

function launchLines(variant, launches) {
  const steps = ["execution workers ready", "checkpoint interrupted"];
  const stallSegments = ["C", "E", "F"];
  const header = ["Launch", "total", "A", "B", "C", "D", "E", "F", ...steps,
    ...stallSegments.map((segment) => `stall in ${segment}`), "settled"];
  const lines = [row(header), row(header.map(() => "---"))];
  launches.forEach((launch, index) => {
    const segments = ["total", "A", "B", "C", "D", "E", "F"].map((name) => rounded(launch.segments[name]));
    const stalls = stallSegments.map((segment) => rounded(stalledMs(launch, windows(launch.segments)[segment])));
    lines.push(row([`${variant}-${index + 1}`, ...segments, ...steps.map((step) => rounded(launch.substeps[step])),
      ...stalls, String(launch.settled)]));
  });
  return [...lines, ""];
}

function longStallLines(launches) {
  const long = launches.flatMap((launch) => launch.stallAttribution.filter((stall) => stall.durationMs > 250));
  const tasks = new Map();
  for (const stall of long) for (const task of new Set(stall.candidateTasks)) tasks.set(task, (tasks.get(task) ?? 0) + 1);
  return [`Stalls over 250 ms: ${long.length}, of which ${long.filter((stall) => stall.beforeUsable).length} began before usable.`,
    "Candidate tasks overlapping them, by count:",
    ...[...tasks].sort((a, b) => b[1] - a[1]).map(([task, count]) => `- ${task}: ${count}`), ""];
}

function report(variant, launches) {
  const accepted = launches.filter((launch) => !launch.failed);
  const buckets = accepted.map((launch, index) => bucketLaunch(launch, `${variant}-${index + 1}`));
  return [`## Variant ${variant}`, "", `${accepted.length} accepted launches.`, "", ...bucketLines(buckets),
    ...stallLines(accepted), ...launchLines(variant, accepted), ...longStallLines(accepted)];
}

const receipt = JSON.parse(NodeFS.readFileSync(process.argv[2], "utf8"));
console.log(Object.entries(receipt.variants).flatMap(([variant, launches]) => report(variant, launches)).join("\n"));
