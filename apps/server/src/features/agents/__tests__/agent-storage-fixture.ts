import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { openMigratedTestDatabase } from "../../../runtime/persistence/sqlite/testing/migrated-test-database.js";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { leaseWriterWorker } from "../../../runtime/persistence/sqlite/testing/reusable-writer-worker.js";
import type { CanonicalAgentEventPublisher } from "../canonical/canonical-agent-store.js";
import { CanonicalParentTurnWrite } from "../canonical/canonical-parent-turn-write.js";
import type { TurnParentStartOwner } from "../turns/turn-admission-dispatch-coordinator.js";

const fixtures = new Map<Database, { writer: ApplicationDatabaseWriter; directory: string; producers: Set<() => Promise<void>> }>();

/** Commit parent starts on the fixture database without an execution worker. */
export function createTestParentStartOwner(
  db: Database,
  publish: CanonicalAgentEventPublisher = () => {},
): TurnParentStartOwner {
  const parents = new CanonicalParentTurnWrite(db, publish);
  return {
    start: async ({ parentTurn }) => {
      parents.start(parentTurn);
    },
  };
}

/** Temporary full-schema database with a real asynchronous writer for service integration tests. */
export function openAgentStorageTestDatabase(): Database {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-agent-service-"));
  const dbPath = NodePath.join(directory, "app.sqlite");
  const db = openMigratedTestDatabase(dbPath);
  fixtures.set(db, { writer: new ApplicationDatabaseWriter(dbPath, leaseWriterWorker), directory, producers: new Set() });
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
  const results = await Promise.allSettled([...fixtures].map(async ([db, fixture]) => {
    try {
      await Promise.all([...fixture.producers].map((drain) => drain()));
    } finally {
      try {
        await fixture.writer.close();
      } finally {
        db.close(true);
        fixtures.delete(db);
        NodeFS.rmSync(fixture.directory, { recursive: true, force: true });
      }
    }
  }));
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length > 0) throw new AggregateError(failures, "Agent storage fixture cleanup failed");
}
