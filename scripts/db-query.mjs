/** Run one SQL query against a Mcode database opened read-only and print its rows as JSON. */
import { Database } from "bun:sqlite";
import { getRuntimePaths } from "./agent/runtime-contract.mjs";
import { scriptRoot } from "./utils.mjs";

const USAGE = 'Usage: bun run db:query -- "<sql>" [--db <path>]';

function fail(message) {
  console.error(`db:query: ${message}\n${USAGE}`);
  process.exit(1);
}

function parseArgs(argv) {
  let sql;
  let dbPath;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--db") {
      dbPath = argv[index + 1];
      index += 1;
      if (!dbPath) fail("--db needs a path");
    } else if (sql === undefined) {
      sql = arg;
    } else {
      fail(`unexpected argument ${arg}`);
    }
  }
  if (!sql?.trim()) fail("missing SQL");
  return { sql, dbPath: dbPath ?? process.env.MCODE_DB_PATH ?? getRuntimePaths(scriptRoot).dbPath };
}

// JSON.stringify would print a blob as a map of byte indexes; its size is what a reader needs.
function jsonValue(_key, value) {
  if (value instanceof Uint8Array) return `<blob ${value.byteLength} bytes>`;
  if (typeof value === "bigint") return value.toString();
  return value;
}

const { sql, dbPath } = parseArgs(process.argv.slice(2));
let db;
try {
  // A read-only connection makes SQLite refuse every write, so a mistyped statement cannot change the database.
  db = new Database(dbPath, { readonly: true, strict: true });
  console.log(JSON.stringify(db.query(sql).all(), jsonValue, 2));
} catch (error) {
  console.error(`db:query: ${error instanceof Error ? error.message : String(error)} (${dbPath})`);
  process.exitCode = 1;
} finally {
  db?.close();
}
