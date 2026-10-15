import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { lazySchema } from "@mcode/contracts";
import { z } from "zod";

const journalSchema = lazySchema(() => z.object({
  entries: z.array(z.object({
    idx: z.number().int().nonnegative(),
    tag: z.string().regex(/^\d{4}_[a-z0-9_]+$/),
    when: z.number().int().positive(),
  })),
}));
const snapshotSchema = lazySchema(() => z.object({ id: z.string(), prevId: z.string() }));

/**
 * Irregularities that shipped before this lint existed. Each is keyed to the entry it
 * excuses so a new migration cannot hide behind it.
 */
const LEGACY_EXCEPTIONS = {
  repeatedNumbers: new Set(["0009"]),
  outOfOrderWhen: new Set(["0009_fancy_ben_urich"]),
  brokenSnapshotChain: new Set(["0009"]),
  missingSnapshots: new Set([
    "0012_bound_tool_output",
    "0013_thread_perf_indexes",
    "0014_message_mentions",
    "0015_branchless_checkout_state",
    "0016_branchless_base_branch",
    "0017_message_preview_annotations",
    "0032_external_thread_control",
    "0033_external_thread_control_active_integration",
    "0059_lively_auto_review",
  ]),
};

type CatalogueEntry = Readonly<{ idx: number; tag: string; when: number; number: number }>;

function numberOf(tag: string): number {
  return Number(tag.slice(0, 4));
}

function snapshotName(number: number): string {
  return `${String(number).padStart(4, "0")}_snapshot.json`;
}

function readJson(path: string, problems: string[]): unknown {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch (error) {
    // Unresolved merge markers are the usual cause, and name the file to fix.
    const reason = error instanceof Error ? error.message : String(error);
    problems.push(`${NodePath.basename(path)} could not be read as JSON: ${reason}`);
    return undefined;
  }
}

function readEntries(directory: string, problems: string[]): CatalogueEntry[] {
  const raw = readJson(NodePath.join(directory, "meta", "_journal.json"), problems);
  if (raw === undefined) return [];
  return journalSchema().parse(raw).entries.map((entry) => ({ ...entry, number: numberOf(entry.tag) }));
}

function lintSqlFiles(directory: string, entries: readonly CatalogueEntry[], problems: string[]): void {
  const tags = new Set<string>();
  for (const entry of entries) {
    if (tags.has(entry.tag)) problems.push(`${entry.tag} is listed twice in the journal`);
    tags.add(entry.tag);
  }
  const files = NodeFS.readdirSync(directory);
  for (const tag of tags) {
    if (!files.includes(`${tag}.sql`)) problems.push(`${tag} is in the journal but ${tag}.sql is missing`);
  }
  for (const file of files.filter((name) => name.endsWith(".sql"))) {
    if (!tags.has(file.slice(0, -".sql".length))) problems.push(`${file} has no journal entry`);
  }
}

function lintSnapshotFiles(directory: string, entries: readonly CatalogueEntry[], problems: string[]): void {
  const snapshots = new Set(NodeFS.readdirSync(NodePath.join(directory, "meta")));
  const numbers = new Set(entries.map((entry) => entry.number));
  for (const name of snapshots) {
    const match = /^(\d{4})_snapshot\.json$/.exec(name);
    if (match && !numbers.has(Number(match[1]))) problems.push(`${name} has no journal entry`);
  }
  for (const entry of entries) {
    if (!snapshots.has(snapshotName(entry.number)) && !LEGACY_EXCEPTIONS.missingSnapshots.has(entry.tag)) {
      problems.push(`${entry.tag} has no ${snapshotName(entry.number)}; generate migrations with drizzle-kit`);
    }
  }
}

function lintSequence(entries: readonly CatalogueEntry[], problems: string[]): void {
  let previousNumber = -1;
  let latestWhen = 0;
  for (const entry of entries) {
    const tagNumber = entry.tag.slice(0, 4);
    const repeatsLegacyNumber = entry.number === previousNumber && LEGACY_EXCEPTIONS.repeatedNumbers.has(tagNumber);
    if (entry.number !== previousNumber + 1 && !repeatsLegacyNumber) {
      problems.push(`${entry.tag} follows number ${previousNumber}; numbers must rise by one with no repeats or gaps`);
    }
    if (entry.idx !== entry.number) problems.push(`${entry.tag} has journal idx ${entry.idx}, expected ${entry.number}`);
    // Drizzle skips any migration whose timestamp is older than the newest one a database applied.
    if (entry.when <= latestWhen && !LEGACY_EXCEPTIONS.outOfOrderWhen.has(entry.tag)) {
      problems.push(`${entry.tag} has a timestamp not newer than an earlier migration, so installs that applied the later one would skip it`);
    }
    previousNumber = entry.number;
    latestWhen = Math.max(latestWhen, entry.when);
  }
}

function lintSnapshotChain(directory: string, entries: readonly CatalogueEntry[], problems: string[]): void {
  let previousId: string | undefined;
  for (const number of new Set(entries.map((entry) => entry.number))) {
    const path = NodePath.join(directory, "meta", snapshotName(number));
    if (!NodeFS.existsSync(path)) continue;
    const raw = readJson(path, problems);
    if (raw === undefined) continue;
    const snapshot = snapshotSchema().parse(raw);
    const excused = LEGACY_EXCEPTIONS.brokenSnapshotChain.has(String(number).padStart(4, "0"));
    if (previousId !== undefined && snapshot.prevId !== previousId && !excused) {
      problems.push(`${snapshotName(number)} was generated from a different parent than the snapshot before it`);
    }
    previousId = snapshot.id;
  }
}

/**
 * Statically checks the generated Drizzle catalogue for the damage parallel branches do to it:
 * repeated or skipped migration numbers, timestamps that go backwards, and snapshots that
 * do not chain. Returns one message per problem and an empty list when the catalogue is sound.
 *
 * @param directory Path to `apps/server/drizzle`.
 */
export function lintMigrationCatalogue(directory: string): string[] {
  const problems: string[] = [];
  const entries = readEntries(directory, problems);
  // Without a readable journal every file would also be reported as unlisted, burying the real cause.
  if (problems.length > 0) return problems;
  lintSqlFiles(directory, entries, problems);
  lintSnapshotFiles(directory, entries, problems);
  lintSequence(entries, problems);
  lintSnapshotChain(directory, entries, problems);
  return problems;
}
