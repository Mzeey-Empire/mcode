import { aggregate } from "./analysis.mjs";

const budgets = { A: 300, B: 1_000, C: 30, D: null, E: 250, F: 150, total: 2_000 };

/** Create a numerical receipt and its human-readable budget comparison. */
export function buildReceipt(variants, stats, warmupFailed = []) {
  const aggregates = Object.fromEntries(Object.entries(variants).map(([variant, rows]) => [variant, aggregate(rows)]));
  const receipt = {
    settings: "Default settings: fresh data directories have no settings.json, and the app inherits no NODE_ENV and no MCODE_, ELECTRON_ or VITE_ variables.",
    warmupFailed,
    variants,
    aggregates,
    fixtureStats: stats,
  };
  const lines = [
    "# Packaged startup receipt",
    "",
    receipt.settings,
    "",
    "One discarded warm-up per key.",
    ...warmupFailed.map((key) => `Warm-up failed: ${key}`),
  ];
  for (const [variant, summary] of Object.entries(aggregates)) {
    const threadReopened = variants[variant].some((row) => row.threadReopened);
    lines.push(
      "",
      `## Variant ${variant.replace(" ", ", ")}`,
      "",
      "| Segment | Measured | Unmeasured | p50 ms | p90 ms | p90 budget ms |",
      "| --- | --- | --- | --- | --- | --- |",
      ...segmentRows(summary),
      "",
      `${summary.launches} launches; ${summary.failed} failed and excluded from percentiles; settled ${summary.settled}; ` +
        `unsettled ${summary.unsettled}; settled unmeasured ${summary.settledUnmeasured}.`,
      `Total p50 budget: 1500 ms. Thread reopened: ${threadReopened}.`,
      `RPCs: at most ${summary.rpcsAnsweredMax} answered and ${summary.rpcsUnansweredMax} unanswered in one window; ${summary.rpcsDropped} dropped past the cap.`,
      "",
      "Server steps by p90:",
    );
    lines.push(...stepRows(summary));
    lines.push("", "Stalls and overlapping candidate causes (not proof):");
    lines.push(...stallRows(variants[variant]));
  }
  lines.push("", "Donor versus fixture statistics:", "", "| Table | Donor | A | B |", "| --- | --- | --- | --- |");
  lines.push(...statsRows(stats));
  return { receipt, markdown: lines.join("\n") + "\n" };
}

const ms = (value) => value == null ? "unmeasured" : Math.round(value);

function segmentRows(summary) {
  return Object.entries(summary.segments).map(([name, row]) =>
    `| ${name} | ${row.measured} | ${row.unmeasured} | ${ms(row.p50)} | ${ms(row.p90)} | ${budgets[name] ?? "inside B"} |`);
}

function stepRows(summary) {
  return Object.entries(summary.substeps).sort((a, b) => b[1].p90 - a[1].p90).map(([name, row]) =>
    `- ${name}: p50 ${ms(row.p50)} ms; p90 ${ms(row.p90)} ms; measured ${row.measured}; unmeasured ${row.unmeasured}`);
}

function stallRows(launches) {
  return launches.flatMap((row, index) => (row.stallAttribution ?? []).map((stall) =>
    `- Launch ${index + 1}: ${ms(stall.durationMs)} ms; offset ${ms(stall.startAfterT0Ms)} ms; before usable ${stall.beforeUsable}; ` +
      `RPCs ${stall.candidateRpcs.join(", ") || "none"}; tasks ${stall.candidateTasks.join(", ") || "none"}`));
}

function statsRows(stats) {
  const lines = [];
  const a = stats.A ?? { tables: {} };
  const b = stats.B ?? { tables: {} };
  for (const table of Object.keys(stats.donor.tables)) {
    lines.push(`| ${table} | ${stats.donor.tables[table]} | ${a.tables[table] ?? ""} | ${b.tables[table] ?? ""} |`);
  }
  for (const key of ["worktreeThreads", "openOrDraftPrThreads", "fileBytes", "freelistCount"]) {
    lines.push(`| ${key} | ${stats.donor[key]} | ${a[key] ?? ""} | ${b[key] ?? ""} |`);
  }
  return lines;
}
