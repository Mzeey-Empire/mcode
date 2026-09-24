import type { Changes } from "bun:sqlite";

/**
 * drizzle's bun-sqlite driver types `run()` as void on both query builders and
 * prepared statements, but the underlying bun:sqlite statement still returns
 * Changes at runtime. Params are forwarded for prepared statements.
 */
export function runChanges<TArgs extends unknown[]>(
  statement: { run(...args: TArgs): unknown },
  ...args: TArgs
): Changes {
  return statement.run(...args) as Changes;
}
