import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach } from "vitest";
import { openDatabase } from "../../../runtime/persistence/sqlite/database.js";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { openReadOnlyDatabase } from "../../../runtime/persistence/sqlite/read-only-database.js";

const runtimes: Array<{
  directory: string;
  database: ReturnType<typeof openDatabase>;
  reader: ReturnType<typeof openReadOnlyDatabase>;
  writer: ApplicationDatabaseWriter;
}> = [];

/** Real temporary SQLite and worker owner for asynchronous service integration tests. */
export function createThreadPersistenceTestRuntime(createWorker?: () => Worker): {
  database: ReturnType<typeof openDatabase>;
  reader: ReturnType<typeof openReadOnlyDatabase>;
  writer: ApplicationDatabaseWriter;
} {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-thread-owner-"));
  const dbPath = NodePath.join(directory, "app.sqlite");
  const database = openDatabase({ dbPath });
  const reader = openReadOnlyDatabase(dbPath);
  const writer = new ApplicationDatabaseWriter(dbPath, createWorker);
  runtimes.push({ directory, database, reader, writer });
  return { database, reader, writer };
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.writer.close();
    runtime.database.close(true);
    runtime.reader.close(true);
    NodeFS.rmSync(runtime.directory, { recursive: true, force: true });
  }
});
