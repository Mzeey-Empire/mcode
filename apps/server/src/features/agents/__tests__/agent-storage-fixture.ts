import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../../../runtime/persistence/sqlite/database.js";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";

const fixtures = new Map<Database, { writer: ApplicationDatabaseWriter; directory: string; producers: Set<() => Promise<void>> }>();

/** Temporary full-schema database with a real asynchronous writer for service integration tests. */
export function openAgentStorageTestDatabase(): Database {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-agent-service-"));
  const dbPath = NodePath.join(directory, "app.sqlite");
  const db = openDatabase({ dbPath });
  fixtures.set(db, { writer: new ApplicationDatabaseWriter(dbPath), directory, producers: new Set() });
  return db;
}

/** Resolve the actual owner paired with one fixture database. */
export function agentStorageTestWriter(db: Database): ApplicationDatabaseWriter {
  const fixture = fixtures.get(db);
  if (!fixture) throw new Error("The agent storage fixture has no writer");
  return fixture.writer;
}

/** Register cleanup when this factory owns the database; other fixture owners drain explicitly. */
export function registerAgentStorageTestProducer(db: Database, drain: () => Promise<void>): boolean {
  const fixture = fixtures.get(db);
  if (!fixture) return false;
  fixture.producers.add(drain);
  return true;
}

/** Drain producers before closing readers and removing only this test's temporary directories. */
export async function closeAgentStorageTestDatabases(): Promise<void> {
  for (const [db, fixture] of fixtures) {
    await Promise.all([...fixture.producers].map((drain) => drain()));
    await fixture.writer.close();
    db.close(true);
    NodeFS.rmSync(fixture.directory, { recursive: true, force: true });
    fixtures.delete(db);
  }
}
