# 0030: One shared database, guarded by the ledger and a compatibility floor

Status: Accepted

Date: 2026-10-19

## Context

Stable and nightly builds share one data directory, `~/.mcode`, and its
`mcode.db`. Users switch between them and expect to keep their data. Two
failures showed that the startup path could not survive that:

- A desktop build found a database whose Drizzle ledger had lost rows 0061 to
  0068 while their tables still existed. Drizzle's migrator applies everything
  newer than the newest receipt, so it replayed 0067 and crashed on
  `CREATE TABLE`.
- An older build opened a database that a newer one had migrated past 0068,
  which drops `threads.copilot_agent`. Drizzle had nothing to apply, so the
  build started and then failed on `no such column: copilot_agent`.

Startup also copied the whole database before every launch, ran ad hoc
repairs, called `migrate()` without checking the ledger, and restored the copy
on failure. The desktop user saw "Server process exited before becoming ready"
and a stderr tail.

## Decision

Keep one shared data directory, as T3 Code does. Make every build prove it can
use the database before it writes to it.

- **Inspect, then decide.** Startup reads the ledger, the schema, and the floor
  through a read-only connection, classifies the ledger against the catalogue
  the build ships, and turns the verdict into a plan: do nothing, migrate, or
  refuse. A refusal happens before any backup or writable connection.
- **Repairs are reviewed, never inferred.** A damaged ledger migrates only when
  an entry in `LEDGER_REPAIRS` matches its exact shape. The repair checks the
  shape again inside its own transaction. Anything else is refused.
- **A compatibility floor.** Table `mcode_schema_compatibility` holds one row:
  the `when` of the newest migration a build must ship to use the database,
  and the tag of the contract step that set it. Migration 0092 created it and
  seeded it with 0091. A build that finds receipts newer than its catalogue
  opens the database without migrating when the floor is at or below its newest
  migration, and refuses `database-newer` otherwise. A missing floor row also
  refuses.
- **Contract migrations raise the floor in their own SQL.** Each one names
  `expandedIn`, the newest migration that shipped in the release whose code no
  longer uses the removed shape, and ends with the upsert from
  `floorUpsertStatement`. The upsert raises `floor_when` to the `when` of
  `expandedIn` and records the contract step's own tag as `raised_by`. The
  floor moves in the same transaction as the break and never goes down. The
  build writes no floor after migrating, so no crash can leave a break
  recorded without its floor.
- **Additive by allowlist.** After 0092, the catalogue lint accepts a statement
  without review only if it is `CREATE TABLE`, a non-unique `CREATE INDEX`, or
  an `ADD COLUMN` that is nullable or has a default. Any other statement needs
  a `CONTRACT_STEPS` entry, which raises the floor, or a `COMPATIBLE_STEPS`
  entry with a reason. Migration 0088 passes drop and rename detection but
  breaks older builds, which is why detection alone is not enough.
- **One migrator at a time.** A migrating start takes a lock file next to the
  database, inspects again under it, and only then backs up and migrates. A
  lock is stale only when its process is no longer running; its owner is never
  signalled.

  > Amended 2026-10-19: the lock file was removed. A migrating start now
  > takes SQLite's own write lock with `BEGIN IMMEDIATE`, inspects and plans
  > again inside that transaction, and makes the backup there. A concurrent
  > start waits up to 30 seconds, then refuses `database-busy`. A start that
  > needs no migration also re-checks under the write lock before it opens.
  > The lock file could let two migrators in and left the `none` path acting
  > on a stale inspection. See
  > [Database migrations](../internals/persistence/db-migrations.md).
- **Back up only when migrating, never restore.** The backup is a `VACUUM INTO`
  copy made only when the plan migrates or repairs. Startup never restores it.
  The migration and any repair run in one transaction that rolls back on
  failure, and the refusal names the backup path for a person to use.
- **Typed refusals reach the user.** A refusal carries data, not only text. The
  server writes it to `startup-failure.json` and exits 78. The desktop trusts
  the file only for the startup it spawned and shows a dialog per refusal kind.
  No button in that dialog changes data.

Mcode now runs its own copy of Drizzle's migrator loop
(`applyPendingMigrations` in `database.ts`). Drizzle's `migrate()` opens its
own transaction, which the repair and the final ledger check cannot join. The
copy keeps Drizzle's table, statements, and timestamp watermark, so the
baseline step, the repair, the migrations, and the postcondition check share
one transaction. It still applies every migration newer than the newest
receipt. Applying by migration ID instead of by watermark is an open
follow-up.

## Alternatives rejected

- **Per-channel data directories with seeding.** Each channel would own its
  database and copy one from another channel on first launch. It isolates
  channels, but a user going from nightly back to stable would not find their
  data, which is the opposite of what users want. Seeding also needed its own
  locks, staging, and a refusal for "no compatible donor".
- **T3 Code's approach.** T3 refuses ledger gaps but only warns about unknown
  newer migrations. An older build then runs until its first query against a
  dropped column, which is the `copilot_agent` failure. The floor is T3's
  behaviour plus the check that makes it safe.
- **Inferring receipts from object existence.** A table being present does not
  prove its migration's data backfill ran, so a general "the table exists, so
  record the receipt" rule can mark work done that never happened. Object
  presence is used to refuse, and as evidence only inside a reviewed repair.

## Consequences

- **Builds released before migration 0092 are unprotected.** They do not read
  the floor. On a database a newer build migrated, they behave as before: they
  start and fail on the first missing column. The protection holds only
  between builds that ship 0092 or later.
- **Authors follow expand and contract.** The release that stops using an old
  shape stays additive. The drop or rename ships in a later release, as a
  migration with a `CONTRACT_STEPS` entry that ends with the floor upsert.
  The floor rises to the expand release, not to the contract step, so that
  release keeps opening the database and only builds older than it refuse.
  Contract steps should still be rare and batch cleanups.
- **Shipped SQL files are frozen.** Their hashes are in installed ledgers, and
  a changed hash refuses with `migration-mismatch`.
- **A new damaged-ledger shape refuses until reviewed.** Supporting it means a
  new `LEDGER_REPAIRS` entry with a test built from the real damaged shape.
- **A breaking rewrite gets a new database file.** When a change would raise
  the floor past what users can reasonably be asked to update for, the release
  copies the old file once to a new name and migrates the copy, so older
  builds keep reading the old file. This mechanism is not built yet; build it
  with the first rewrite that needs it.
- Startups that need no migration take no lock and make no backup, so a
  multi-gigabyte database no longer costs a full copy on every launch.
  (Amended 2026-10-19: they now take the write lock briefly to re-check, but
  still make no backup.)

See [Database migrations](../internals/persistence/db-migrations.md) for the
author rules.
