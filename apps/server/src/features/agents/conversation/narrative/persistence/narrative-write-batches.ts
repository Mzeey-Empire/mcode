import * as NodePerfHooks from "node:perf_hooks";
import { z } from "zod";
import type { ApplicationDatabaseWriter } from "../../../../../runtime/persistence/sqlite/application-database-writer.js";
import type { DatabaseWriteOperation } from "../../../../../runtime/persistence/sqlite/database-write-operation.js";
import type { WriteBatchLimits, WriteBatchResult } from "../../../../../runtime/persistence/sqlite/bounded-write-batches.js";

/** Hard budgets validated before a batch reaches the worker. */
export const narrativeWriteBatchLimitsSchema = z.object({
  maxRows: z.number().int().positive(), maxBytes: z.number().int().positive(), maxElapsedMs: z.number().positive(),
}).strict();

/** A committed prefix, allowing the caller to continue after a worker time budget expires. */
export const narrativeWriteBatchResultSchema = z.object({
  batches: z.number().int().nonnegative(), rows: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(),
}).strict();

function inputBytes<T>(item: T): number {
  return Buffer.byteLength(JSON.stringify(item), "utf8");
}

function validateSizes<T>(items: readonly T[], limits: WriteBatchLimits): number[] {
  narrativeWriteBatchLimitsSchema.parse(limits);
  return items.map((item, index) => {
    const bytes = inputBytes(item);
    if (bytes > limits.maxBytes) {
      throw new Error(`Row ${index + 1} is ${bytes} bytes and exceeds the ${limits.maxBytes}-byte batch limit`);
    }
    return bytes;
  });
}

function candidateBatch<T>(items: readonly T[], sizes: readonly number[], cursor: number, limits: WriteBatchLimits): T[] {
  let bytes = 0;
  let end = cursor;
  while (end < items.length && end - cursor < limits.maxRows && bytes + sizes[end]! <= limits.maxBytes) {
    bytes += sizes[end]!;
    end += 1;
  }
  return items.slice(cursor, end);
}

/** Issue separately committed bounded commands, preserving progress after each acknowledgment. */
export async function commitNarrativeBatches<T>(
  writer: ApplicationDatabaseWriter,
  operation: DatabaseWriteOperation<[T[], WriteBatchLimits, boolean], WriteBatchResult>,
  items: readonly T[],
  limits: WriteBatchLimits,
  replaceExisting: boolean,
): Promise<WriteBatchResult> {
  const sizes = validateSizes(items, limits);
  const total = { batches: 0, rows: 0, bytes: 0 };
  while (total.rows < items.length) {
    const batch = candidateBatch(items, sizes, total.rows, limits);
    const result = await writer.execute(operation, [batch, limits, replaceExisting]);
    if (result.rows <= 0 || result.rows > batch.length || result.batches !== 1) {
      throw new Error("The narrative writer returned an invalid committed prefix");
    }
    total.rows += result.rows;
    total.batches += result.batches;
    total.bytes += result.bytes;
    if (total.rows < items.length) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return total;
}

/** Write one bounded prefix inside the owner's existing synchronous transaction. */
export function writeNarrativeBatch<T>(items: readonly T[], limits: WriteBatchLimits, write: (item: T) => void): WriteBatchResult {
  const sizes = validateSizes(items, limits);
  if (items.length > limits.maxRows || sizes.reduce((sum, bytes) => sum + bytes, 0) > limits.maxBytes) {
    throw new Error("The narrative command exceeds its row or byte budget");
  }
  const result = { batches: items.length > 0 ? 1 : 0, rows: 0, bytes: 0 };
  const startedAt = NodePerfHooks.performance.now();
  for (const item of items) {
    write(item);
    result.bytes += sizes[result.rows]!;
    result.rows += 1;
    if (NodePerfHooks.performance.now() - startedAt >= limits.maxElapsedMs) break;
  }
  return result;
}
