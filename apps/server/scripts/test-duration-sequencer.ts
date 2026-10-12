/**
 * Shards the server suite by recorded file durations.
 *
 * Vitest's default `--shard` splits files by count after hashing their paths, so
 * one shard can draw most of the slow files and finish minutes after the other.
 * This sequencer reads per-file durations recorded by `test-duration-reporter.ts`
 * and assigns files to shards so each shard gets a similar total duration.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/** Per-file durations in milliseconds, keyed by POSIX path relative to the Vitest root. */
export type TestFileDurations = Record<string, number>;

/** The file name the reporter writes and the sequencer reads, in the Vitest root. */
export const TEST_DURATIONS_FILE = "test-durations.json";

/** Reads the recorded durations, or an empty map when none are recorded yet. */
export function readTestFileDurations(root: string): TestFileDurations {
  const path = NodePath.join(root, TEST_DURATIONS_FILE);
  if (!NodeFS.existsSync(path)) return {};
  return JSON.parse(NodeFS.readFileSync(path, "utf8")) as TestFileDurations;
}

/** Returns a spec's path relative to `root`, with forward slashes on every platform. */
export function relativeTestPath(root: string, moduleId: string): string {
  return NodePath.relative(root, moduleId).split(NodePath.sep).join("/");
}

/**
 * Splits `paths` into `count` shards with similar total duration.
 * Every shard computes the same split independently, so the result must depend only on
 * the inputs: files are placed longest first, ties broken by path, each onto the shard
 * with the least total so far. A file with no recorded duration counts as the median one.
 */
export function assignShards(paths: readonly string[], durations: TestFileDurations, count: number): string[][] {
  const known = paths.map((path) => durations[path]).filter((ms): ms is number => ms !== undefined).sort((a, b) => a - b);
  const fallback = known.length > 0 ? known[Math.floor(known.length / 2)]! : 1;
  const weighted = paths
    .map((path) => ({ path, ms: durations[path] ?? fallback }))
    .sort((a, b) => b.ms - a.ms || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const shards = Array.from({ length: count }, () => ({ paths: [] as string[], total: 0 }));
  for (const file of weighted) {
    const lightest = shards.reduce((min, shard) => (shard.total < min.total ? shard : min));
    lightest.paths.push(file.path);
    lightest.total += file.ms;
  }
  return shards.map((shard) => shard.paths);
}

/** A Vitest sequencer whose `shard` balances recorded durations instead of file counts. */
export class DurationSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (!shard) return files;
    const durations = readTestFileDurations(root);
    const paths = files.map((spec) => relativeTestPath(root, spec.moduleId));
    const selected = new Set(assignShards(paths, durations, shard.count)[shard.index - 1]);
    return files.filter((spec, i) => selected.has(paths[i]!));
  }
}
