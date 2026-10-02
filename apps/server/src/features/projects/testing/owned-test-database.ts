import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { openDatabase } from "../../../runtime/persistence/sqlite/database.js";

/** Isolated file database and actual worker for asynchronous feature tests. */
export interface OwnedTestDatabase {
  readonly db: Database;
  readonly writer: ApplicationDatabaseWriter;
  close(): Promise<void>;
}

/** Creates a temporary database with a fixture-only connection and the real write owner. */
export function createOwnedTestDatabase(): OwnedTestDatabase {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-feature-owner-"));
  const dbPath = NodePath.join(directory, "app.sqlite");
  const db = openDatabase({ dbPath });
  const writer = new ApplicationDatabaseWriter(dbPath);
  return { db, writer, async close() { await writer.close(); db.close(true); NodeFS.rmSync(directory, { recursive: true, force: true }); } };
}
