import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { getMcodeDir } from "@mcode/shared/paths";
import { loadEvidence } from "./sources.js";
import { findAnomalies } from "./anomalies.js";
import { renderJson, renderText } from "./render.js";
import type { DiagQuery } from "./model.js";

const DEFAULT_WINDOW_MS = 15 * 60_000;
const DEFAULT_LIMIT = 400;
const DURATION_UNITS_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

interface DevPaths {
  devDir: string;
  dbPath: string;
}

function parseOptions(args: string[]) {
  const { values } = NodeUtil.parseArgs({
    args,
    options: {
      "data-dir": { type: "string" },
      db: { type: "string" },
      "no-db": { type: "boolean" },
      thread: { type: "string" },
      workspace: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      ch: { type: "string" },
      limit: { type: "string" },
      json: { type: "boolean" },
    },
    strict: true,
  });
  return values;
}

type Options = ReturnType<typeof parseOptions>;

function sinceTime(value: string | undefined, now: number): number {
  if (!value) return now - DEFAULT_WINDOW_MS;

  const duration = /^(\d+)(s|m|h|d)$/.exec(value);
  if (duration) {
    const unitMs = DURATION_UNITS_MS[duration[2]];
    if (unitMs) return now - Number(duration[1]) * unitMs;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("Invalid --since");
  return parsed;
}

async function devPaths(): Promise<DevPaths | undefined> {
  const contractPath = NodePath.resolve(import.meta.dirname, "../../../../../../scripts/agent/runtime-contract.mjs");
  if (!NodeFS.existsSync(contractPath)) return undefined;
  const runtime = await import(NodeURL.pathToFileURL(contractPath).href);
  return runtime.getRuntimePaths();
}

function resolveDataDir(values: Options, dev: DevPaths | undefined): string {
  return values["data-dir"] ?? process.env.MCODE_DATA_DIR ?? dev?.devDir ?? getMcodeDir();
}

function resolveDbPath(values: Options, dev: DevPaths | undefined): string | undefined {
  if (values["no-db"]) return undefined;
  return values.db ?? process.env.MCODE_DB_PATH ?? dev?.dbPath ?? NodePath.join(getMcodeDir(), "mcode.db");
}

async function buildQuery(values: Options): Promise<DiagQuery> {
  const dev = await devPaths();
  const now = Date.now();
  const until = values.until ? Date.parse(values.until) : now;
  const since = sinceTime(values.since, until);
  const limit = Number(values.limit ?? DEFAULT_LIMIT);
  if (!Number.isFinite(until) || since > until || !Number.isInteger(limit) || limit < 1) {
    throw new Error("Invalid window or limit");
  }

  return {
    dataDir: resolveDataDir(values, dev),
    dbPath: resolveDbPath(values, dev),
    noDb: values["no-db"],
    thread: values.thread,
    workspace: values.workspace,
    since,
    until,
    channels: values.ch?.split(","),
    limit,
    json: values.json,
  };
}

/** Execute the reader without bootstrapping the application or mutating its DB. */
export async function main(args: string[]): Promise<string> {
  const q = await buildQuery(parseOptions(args));
  const evidence = loadEvidence(q);
  const findings = findAnomalies(evidence, q);
  if (q.json) return renderJson(evidence, findings, q);
  return renderText(evidence, findings, q);
}

if (import.meta.main) {
  try {
    process.stdout.write((await main(process.argv.slice(2))) + "\n");
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}
