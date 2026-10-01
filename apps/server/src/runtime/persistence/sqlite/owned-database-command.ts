import type { Database } from "bun:sqlite";

/** Validate transportability before the outer commit, including nested storage transactions. */
export function executeOwnedDatabaseCommand(
  db: Database,
  handler: (input: unknown) => unknown,
  input: unknown,
): unknown {
  return db.transaction(() => {
    const result = handler(input);
    if (result instanceof Promise) {
      throw new Error("An owned database command must finish synchronously");
    }
    return structuredClone(result);
  }).immediate();
}
