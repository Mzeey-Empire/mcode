import { Database } from "bun:sqlite";
import { z } from "zod";
import { applySQLiteCacheBudget } from "./sqlite-connection-policy.js";
const walJournalSchema = z.object({ journal_mode: z.literal("wal") });

/** Open a physically read-only runtime reader after the owner has initialized the WAL database. */
export function openReadOnlyDatabase(dbPath: string): Database {
  const db = new Database(dbPath, { strict: true, readonly: true });
  try {
    const journal = walJournalSchema.parse(db.query("PRAGMA journal_mode").get());
    if (journal.journal_mode !== "wal") throw new Error("Read-only database requires WAL");
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA synchronous = FULL");
    db.run("PRAGMA mmap_size = 0");
    db.run("PRAGMA query_only = ON");
    applySQLiteCacheBudget(db, "active");
    return db;
  } catch (error) {
    db.close(true);
    throw error;
  }
}
