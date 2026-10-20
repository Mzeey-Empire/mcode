/** Print read-only SQLite schema and table statistics with Bun SQLite. */
import * as NodeFS from "node:fs";
import { Database } from "bun:sqlite";
import { getRuntimePaths } from "./agent/runtime-contract.mjs";
import { scriptRoot } from "./utils.mjs";

const dbPath = process.env.MCODE_DB_PATH ?? getRuntimePaths(scriptRoot).dbPath;
console.log(`Database : ${dbPath}`);
if (!NodeFS.existsSync(dbPath)) {
  console.log("Status   : not found (start the server to create it)");
  process.exit(0);
}

try {
  const db = new Database(dbPath, { readonly: true, strict: true });
  const version = db.query("SELECT version FROM _migrations ORDER BY version DESC LIMIT 1").get();
  console.log(`Schema   : v${version?.version ?? 0}`);
  for (const table of ["workspaces", "threads", "messages"]) {
    const row = db.query(`SELECT COUNT(*) AS count FROM ${table}`).get();
    console.log(`${table.padEnd(10)}: ${row.count} rows`);
  }
  db.close(true);
} catch (error) {
  console.error(`Error    : ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
