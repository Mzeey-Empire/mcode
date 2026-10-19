import { z } from "zod";
import { lazySchema } from "./utils/lazySchema.js";

/** File name, inside the data directory, in which a failed server start records why it failed. */
export const STARTUP_FAILURE_FILE_NAME = "startup-failure.json";

/** Process exit code the server uses when startup failed and `startup-failure.json` explains it (EX_CONFIG). */
export const STARTUP_FAILURE_EXIT_CODE = 78;

/** Largest `startup-failure.json` the desktop reads. The file is written by a process it does not fully trust. */
export const STARTUP_FAILURE_FILE_MAX_BYTES = 64 * 1024;

/**
 * A startup the build refuses on purpose, with enough data to explain it to the user. Kept as data
 * so the server, the writer worker, and the desktop shell can each describe the same refusal
 * without parsing text.
 */
export const StartupRefusalSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("database-newer"),
      databasePath: z.string(),
      /** The migration that raised the compatibility floor, or null when the database records none. */
      raisedBy: z.string().nullable(),
    }),
    z.object({ kind: z.literal("database-busy"), databasePath: z.string() }),
    z.object({ kind: z.literal("database-unreadable"), databasePath: z.string(), detail: z.string() }),
    z.object({ kind: z.literal("database-unknown-history"), databasePath: z.string(), detail: z.string() }),
    z.object({ kind: z.literal("migration-mismatch"), databasePath: z.string(), tag: z.string() }),
    z.object({ kind: z.literal("ledger-damaged"), databasePath: z.string(), tags: z.array(z.string()) }),
    z.object({
      kind: z.literal("migration-failed"),
      databasePath: z.string(),
      sqliteMessage: z.string(),
      backupPath: z.string().nullable(),
    }),
  ]),
);
/** A startup the build refuses on purpose, with enough data to explain it to the user. */
export type StartupRefusal = z.infer<ReturnType<typeof StartupRefusalSchema>>;

/**
 * The record a failed server start leaves for the desktop. `startupId` echoes the `MCODE_STARTUP_ID`
 * the desktop spawned the server with, so a file left by an earlier start is never mistaken for this one.
 */
export const StartupFailureFileSchema = lazySchema(() =>
  z.union([
    z.object({ version: z.literal(1), startupId: z.string().min(1), refusal: StartupRefusalSchema() }),
    z.object({
      version: z.literal(1),
      startupId: z.string().min(1),
      unexpected: z.object({ message: z.string() }),
    }),
  ]),
);
/** The record a failed server start leaves for the desktop. */
export type StartupFailureFile = z.infer<ReturnType<typeof StartupFailureFileSchema>>;

/** Plain-word explanation of a refusal. It always names the database path where one applies. */
export function describeRefusal(refusal: StartupRefusal): string {
  switch (refusal.kind) {
    case "database-newer":
      return describeNewer(refusal);
    case "database-busy":
      return `Another Mcode process is updating this database (${refusal.databasePath}). Wait a moment and start Mcode again.`;
    case "database-unreadable":
      return `Mcode cannot read this database file (${refusal.databasePath}), so it left it untouched. ${refusal.detail}`;
    case "database-unknown-history":
      return `Mcode cannot tell which version created this database, so it left the file untouched (${refusal.databasePath}). ${refusal.detail}`;
    case "migration-mismatch":
      return `Migration ${refusal.tag} was recorded in this database from different SQL than this version of Mcode ships (${refusal.databasePath}). The file was left untouched. Install the version that created it, or restore a backup.`;
    case "ledger-damaged":
      return `The update history of this database is damaged (${refusal.databasePath}). Mcode cannot tell whether ${refusal.tags.join(", ")} already ran, so it left the file untouched. Restore a backup, or contact support with this message.`;
    case "migration-failed":
      return `Updating the database failed (${refusal.databasePath}): ${refusal.sqliteMessage}. ${describeBackup(refusal)}`;
  }
}

function describeNewer(refusal: Extract<StartupRefusal, { kind: "database-newer" }>): string {
  const cause = refusal.raisedBy
    ? `a newer version of Mcode changed it in a way this version cannot read (change ${refusal.raisedBy})`
    : "it was saved by a newer version of Mcode that did not say whether this version can read it";
  return `This version of Mcode will not open this data (${refusal.databasePath}): ${cause}. Update Mcode, or start this version on a different data folder.`;
}

function describeBackup(refusal: Extract<StartupRefusal, { kind: "migration-failed" }>): string {
  return refusal.backupPath
    ? `A copy of your data from just before the update is at ${refusal.backupPath}.`
    : "There was no earlier data to copy.";
}
