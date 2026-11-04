/** Tests the Bun db:query command against a real temporary SQLite database. */
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

function bun(args, env) {
  const result = NodeChildProcess.spawnSync("bun", args, { cwd: process.cwd(), env, encoding: "utf8", timeout: 60_000 });
  NodeAssertStrict.default.equal(result.error, undefined);
  return result;
}

function withDatabase(run) {
  const dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-db-query-"));
  const env = { ...process.env, MCODE_DB_PATH: NodePath.join(dataDir, "mcode.db") };
  try {
    const created = bun(
      ["-e", "import { Database } from 'bun:sqlite'; const db = new Database(process.env.MCODE_DB_PATH); db.exec(\"CREATE TABLE turn_steers (id TEXT, state TEXT, body BLOB); INSERT INTO turn_steers VALUES ('s1', 'queued', x'0102');\"); db.close();"],
      env,
    );
    NodeAssertStrict.default.equal(created.status, 0, created.stderr);
    run(env);
  } finally {
    NodeFS.rmSync(dataDir, { recursive: true, force: true });
  }
}

NodeTest.test("db:query prints a query's rows as JSON", { timeout: 75_000 }, () => {
  withDatabase((env) => {
    const result = bun(["scripts/db-query.mjs", "--", "SELECT id, state, body FROM turn_steers"], env);
    NodeAssertStrict.default.equal(result.status, 0, result.stderr);
    NodeAssertStrict.default.deepEqual(JSON.parse(result.stdout), [{ id: "s1", state: "queued", body: "<blob 2 bytes>" }]);
  });
});

NodeTest.test("db:query refuses to write and leaves the database unchanged", { timeout: 75_000 }, () => {
  withDatabase((env) => {
    const write = bun(["scripts/db-query.mjs", "UPDATE turn_steers SET state = 'answered'"], env);
    NodeAssertStrict.default.equal(write.status, 1);
    NodeAssertStrict.default.match(write.stderr, /readonly/i);
    const read = bun(["scripts/db-query.mjs", "SELECT state FROM turn_steers"], env);
    NodeAssertStrict.default.deepEqual(JSON.parse(read.stdout), [{ state: "queued" }]);
  });
});
