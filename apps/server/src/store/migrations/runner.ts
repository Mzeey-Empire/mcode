/**
 * MigrationRunner: manages forward and backward SQLite migrations using
 * pre-loaded migration modules. Takes a Map of version -> module so the
 * runner is fully testable without filesystem coupling.
 */

import type Database from "better-sqlite3";
import { LEGACY_VERSION_MAP } from "./legacy-version-map.js";

/** A row from the _migrations tracking table. */
export interface MigrationRecord {
  version: string;
  name: string;
  appliedAt: string;
}

/**
 * Result of a schema consistency check between the applied versions in the DB
 * and the migration modules available in memory.
 */
export interface ValidationResult {
  valid: boolean;
  /** Applied DB versions that have no corresponding migration module. */
  gaps: string[];
}

/**
 * A single migration module. Each migration must implement both directions so
 * rollback is always possible.
 */
export interface MigrationModule {
  description: string;
  up(db: Database.Database): void;
  down(db: Database.Database): void;
}

/**
 * Reads the _migrations table and maps rows to MigrationRecord shape.
 * Centralises the snake_case -> camelCase mapping in one place.
 */
function rowToRecord(row: { version: string; name: string; applied_at: string }): MigrationRecord {
  return {
    version: row.version,
    name: row.name,
    appliedAt: row.applied_at,
  };
}

/**
 * Orchestrates forward and backward SQLite migrations for a pre-loaded set of
 * migration modules. Owns the _migrations tracking table lifecycle.
 */
export class MigrationRunner {
  constructor(
    private db: Database.Database,
    private migrations: Map<string, MigrationModule>,
  ) {
    this.ensureTable();
  }

  /**
   * Ensures the _migrations table exists with the TEXT-keyed schema.
   *
   * Three cases handled:
   * 1. No table yet → create it with TEXT version column.
   * 2. Table has INTEGER version column (legacy) → one-shot upgrade via
   *    upgradeLegacyMigrationsTable(), then backfill empty names so
   *    descriptions are populated on the same open.
   * 3. Table already has TEXT version column → backfill name column if absent,
   *    then backfill empty name values from loaded modules.
   */
  private ensureTable(): void {
    // Create table with the new TEXT-keyed schema if it does not exist at all.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    interface PragmaRow {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }

    const columns = this.db.pragma("table_info(_migrations)") as PragmaRow[];
    const versionCol = columns.find((c) => c.name === "version");
    const hasNameColumn = columns.some((c) => c.name === "name");

    // Legacy schema: INTEGER version column. Rewrite to TEXT and translate
    // keys. The recreated table has a `name` column with default '', so we
    // fall through to the backfill below to populate descriptions on first
    // open rather than waiting for the next process restart.
    if (versionCol?.type === "INTEGER") {
      this.upgradeLegacyMigrationsTable();
    } else if (!hasNameColumn) {
      this.db.exec("ALTER TABLE _migrations ADD COLUMN name TEXT NOT NULL DEFAULT ''");
    }

    // Backfill descriptions for rows applied before the name column existed.
    const emptyCount = (
      this.db
        .prepare("SELECT COUNT(*) as n FROM _migrations WHERE name = ''")
        .get() as { n: number }
    ).n;

    if (emptyCount > 0) {
      const updateStmt = this.db.prepare(
        "UPDATE _migrations SET name = ? WHERE version = ? AND name = ''",
      );
      for (const [version, module] of this.migrations) {
        updateStmt.run(module.description, version);
      }
    }
  }

  /**
   * One-shot migration of the `_migrations` tracking table from the legacy
   * INTEGER `version` schema to the new TEXT schema. Translates each row's
   * integer version into the corresponding 14-char zero-padded string using
   * LEGACY_VERSION_MAP. Wrapped in a transaction so the original table is
   * untouched if anything fails.
   */
  private upgradeLegacyMigrationsTable(): void {
    this.db.transaction(() => {
      // The legacy table may or may not have the name column — read only what exists.
      interface PragmaRow { name: string; type: string; notnull: number; dflt_value: string | null; pk: number; }
      const legacyCols = this.db.pragma("table_info(_migrations)") as PragmaRow[];
      const hasName = legacyCols.some((c) => c.name === "name");
      const selectSql = hasName
        ? "SELECT version, name, applied_at FROM _migrations"
        : "SELECT version, '' AS name, applied_at FROM _migrations";

      const oldRows = this.db
        .prepare(selectSql)
        .all() as Array<{ version: number; name: string; applied_at: string }>;

      this.db.exec("DROP TABLE _migrations");
      this.db.exec(`
        CREATE TABLE _migrations (
          version TEXT PRIMARY KEY,
          name TEXT NOT NULL DEFAULT '',
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);

      const insertStmt = this.db.prepare(
        "INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)",
      );

      for (const row of oldRows) {
        const newKey = LEGACY_VERSION_MAP.get(row.version);
        if (!newKey) {
          throw new Error(
            `Cannot upgrade _migrations row: no legacy mapping for integer version ${row.version}. ` +
            `If this version was added by a feature branch outside the main lineage, you must add it to LEGACY_VERSION_MAP before opening this database.`,
          );
        }
        insertStmt.run(newKey, row.name, row.applied_at);
      }
    })();
  }

  /**
   * Applies pending migrations in ascending version order. Stops after
   * `steps` migrations when provided; applies all pending when omitted.
   */
  up(steps?: number): { applied: number; migrations: MigrationRecord[] } {
    const appliedVersions = new Set(
      (this.db.prepare("SELECT version FROM _migrations").all() as Array<{ version: string }>).map(
        (r) => r.version,
      ),
    );

    const pending = [...this.migrations.entries()]
      .filter(([version]) => !appliedVersions.has(version))
      .sort(([a], [b]) => a.localeCompare(b));

    const toApply = steps !== undefined ? pending.slice(0, steps) : pending;
    const records: MigrationRecord[] = [];

    const insertStmt = this.db.prepare(
      "INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)",
    );

    for (const [version, module] of toApply) {
      // Capture the timestamp before the transaction so the INSERT and the
      // returned record agree on the value without a SELECT round-trip.
      const appliedAt = new Date().toISOString();

      this.db.transaction(() => {
        module.up(this.db);
        insertStmt.run(version, module.description, appliedAt);
      })();

      records.push({ version, name: module.description, appliedAt });
    }

    return { applied: records.length, migrations: records };
  }

  /**
   * Reverts the most-recently applied migrations in descending version order.
   * Defaults to rolling back 1 migration when `steps` is omitted.
   *
   * If `steps` exceeds the number of applied migrations, only the available
   * applied migrations are reverted (no error is thrown for the excess).
   */
  down(steps = 1): { reverted: number; migrations: MigrationRecord[] } {
    if (steps <= 0) {
      throw new Error("steps must be a positive integer");
    }

    const appliedRows = this.db
      .prepare("SELECT version, name, applied_at FROM _migrations ORDER BY version DESC")
      .all() as Array<{ version: string; name: string; applied_at: string }>;

    if (appliedRows.length === 0) {
      return { reverted: 0, migrations: [] };
    }

    const toRevert = appliedRows.slice(0, steps);
    const records: MigrationRecord[] = [];

    const deleteStmt = this.db.prepare("DELETE FROM _migrations WHERE version = ?");

    for (const row of toRevert) {
      const module = this.migrations.get(row.version);
      if (!module) {
        throw new Error(
          `Cannot revert migration v${row.version}: no migration module loaded for that version`,
        );
      }

      const record = rowToRecord(row);

      this.db.transaction(() => {
        module.down(this.db);
        deleteStmt.run(row.version);
      })();

      records.push(record);
    }

    return { reverted: records.length, migrations: records };
  }

  /**
   * Returns all pending migrations (in map but not applied), sorted ascending.
   */
  pending(): { version: string; name: string }[] {
    const appliedVersions = new Set(
      (this.db.prepare("SELECT version FROM _migrations").all() as Array<{ version: string }>).map(
        (r) => r.version,
      ),
    );

    return [...this.migrations.entries()]
      .filter(([version]) => !appliedVersions.has(version))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([version, module]) => ({ version, name: module.description }));
  }

  /**
   * Returns all applied migrations from _migrations, sorted ascending by
   * version.
   */
  applied(): MigrationRecord[] {
    const rows = this.db
      .prepare("SELECT version, name, applied_at FROM _migrations ORDER BY version ASC")
      .all() as Array<{ version: string; name: string; applied_at: string }>;
    return rows.map(rowToRecord);
  }

  /**
   * Checks that every version recorded in _migrations has a corresponding
   * migration module loaded. Versions with no module are reported as `gaps`.
   */
  validate(): ValidationResult {
    const appliedVersions = (
      this.db.prepare("SELECT version FROM _migrations").all() as Array<{ version: string }>
    ).map((r) => r.version);

    const gaps = appliedVersions.filter((v) => !this.migrations.has(v));

    return {
      valid: gaps.length === 0,
      gaps,
    };
  }
}
