#!/usr/bin/env bun
/**
 * Print SQLite database location, schema version, and basic table stats.
 * Opens the database read-only; safe to run while the server is running.
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolveMainRoot } from './utils.mjs';
import { resolveCliDbPath } from './resolve-cli-db-path.mjs';

const require = createRequire(import.meta.url);
const root    = resolveMainRoot();

const dbPath  = resolveCliDbPath();

console.log(`Database : ${dbPath}`);

if (!existsSync(dbPath)) {
  console.log('Status   : not found (start the server to create it)');
  process.exit(0);
}

try {
  // Bun workspaces may hoist better-sqlite3 to the root or keep it in apps/server.
  const modulePaths = [
    resolve(root, 'node_modules/better-sqlite3'),
    resolve(root, 'apps/server/node_modules/better-sqlite3'),
  ];
  const modulePath = modulePaths.find(p => existsSync(p));
  if (!modulePath) throw new Error('better-sqlite3 not found — run bun install first');
  const Database = require(modulePath);
  const db       = new Database(dbPath, { readonly: true });

  const vRow = db.prepare('SELECT version FROM _migrations ORDER BY version DESC LIMIT 1').get();
  console.log(`Schema   : v${vRow ? vRow.version : 0}`);

  for (const table of ['workspaces', 'threads', 'messages']) {
    const { count } = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
    console.log(`${table.padEnd(10)}: ${count} rows`);
  }

  db.close();
} catch (err) {
  console.error(`Error    : ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
