import * as NodeFS from "node:fs";
import type { Database } from "bun:sqlite";
import { openDatabase, openMemoryDatabase } from "../database.js";

// Vitest isolates each test file in its own module graph, so this image is built once per file.
let migratedImage: Uint8Array | undefined;

/**
 * Opens a new file database at `dbPath`, seeded from a schema image that ran every migration once.
 * Replaying every migration per test dominated fixture setup. The image is a serialized in-memory
 * database, so no copy shares a template file, WAL, or SHM with another test. `openDatabase` still
 * applies the production connection policy; its migration pass finds nothing left to run.
 */
export function openMigratedTestDatabase(dbPath: string): Database {
  migratedImage ??= serializeMigratedSchema();
  NodeFS.writeFileSync(dbPath, migratedImage, { flag: "wx" });
  return openDatabase({ dbPath });
}

function serializeMigratedSchema(): Uint8Array {
  const db = openMemoryDatabase();
  try {
    return db.serialize();
  } finally {
    db.close(true);
  }
}
