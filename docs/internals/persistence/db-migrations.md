# Database Migrations

Migrations are managed by [Drizzle Kit](https://orm.drizzle.team/docs/kit-overview).
The declarative schema lives in `apps/server/src/runtime/persistence/sqlite/schema.ts`. Generated SQL
files live under `apps/server/drizzle/`.

```sh
cd apps/server

bun run db:generate    # Emit SQL from schema edits (review before commit)
bun run db:migrate     # Apply pending migrations via drizzle-kit (needs DB URL config for CLI)
bun run db:push        # Push schema directly (dev only; can be destructive)
bun run db:studio      # Drizzle Studio (visual browser)
```

Stable and nightly builds open the same `~/.mcode/mcode.db`, and users switch
between them. Every migration must therefore be safe for the builds on either
side of it. [ADR-0030](../../adr/0030-shared-database-with-ledger-guard-and-compatibility-floor.md)
records why.

## How startup opens the database

[`openDatabase`](../../../apps/server/src/runtime/persistence/sqlite/database.ts)
reads the file read-only first.
[`ledger-guard.ts`](../../../apps/server/src/runtime/persistence/sqlite/ledger-guard.ts)
compares the Drizzle ledger (`__drizzle_migrations`) with the catalogue the
build ships and returns a verdict:

| Verdict | Meaning | Startup |
|---|---|---|
| `fresh` | No file, or no tables | Migrates |
| `legacy-unledgered` | Exactly the schema 0000 creates, and no receipts | Records 0000, then migrates |
| `current` | Every shipped migration is recorded | Opens, no migration |
| `behind` | Some newer shipped migrations are not recorded yet | Migrates |
| `compatible-ahead` | A newer build migrated it, and the floor allows this build | Opens, no migration |
| `ahead` | A newer build migrated it, and the floor is above this build or missing. A floor above this build refuses whatever receipts remain | Refuses `database-newer` |
| `hash-mismatch` | A receipt's hash matches no spelling of the shipped SQL | Refuses `migration-mismatch` |
| `gap` | A shipped migration is missing below a recorded one | Repairs if reviewed, else refuses `ledger-damaged` |
| `schema-ahead-of-ledger` | An unrecorded migration's objects already exist | Repairs if reviewed, else refuses `ledger-damaged` |
| `unknown-history` | Anything else, such as duplicate or unknown receipts inside this build's range | Refuses `database-unknown-history` |

Damage to the receipts the build knows is reported before newer receipts, so a
broken prefix never passes as `compatible-ahead`. A file SQLite cannot read
refuses `database-unreadable`.

A refusal on the read-only check happens before any write. After it, the start
opens the file for writing and begins one `BEGIN IMMEDIATE` transaction. That
takes SQLite's write lock, so only one migrator runs at a time. There is no
lock file. Under the write lock the start inspects again on the same
connection and plans again, because another process may have changed the file
since the read-only check. If the new plan refuses, startup refuses.

If the new plan migrates, the start makes a `VACUUM INTO` backup
(`mcode.db.bak-*`, five kept) from a separate read-only connection. In WAL
mode that reader sees the last committed state, which is the database before
the migration. Then the same transaction runs the baseline, any repair, the
pending migrations, the schema patches, and a final ledger check. If any of
that fails, the transaction rolls back and startup refuses `migration-failed`
with SQLite's message and the backup path. Startup never restores a backup. A
start that needs no migration makes no backup and only runs the schema patches.

A second process that cannot get the write lock waits up to 30 seconds, then
refuses `database-busy`. Only failures inside the transaction become
`migration-failed`. A failure in the optimize or backup pruning after commit
does not, because the database did migrate. A pruning failure is logged and
startup continues.

The migrations run through Mcode's copy of Drizzle's loop
(`applyPendingMigrations`), because Drizzle's `migrate()` opens a transaction
the repair cannot join. Like Drizzle, it applies every migration newer than the
newest receipt's timestamp.

## Writing a migration

Edit `schema.ts`, run `db:generate`, and review the SQL. Then decide which kind
of migration it is. The catalogue lint
([`migration-catalogue-lint.ts`](../../../apps/server/src/runtime/persistence/sqlite/migration-catalogue-lint.ts))
runs in the server tests and enforces each rule below. The reviewed lists live
in [`migration-contract-steps.ts`](../../../apps/server/src/runtime/persistence/sqlite/migration-contract-steps.ts).

### Additive migrations

An additive migration is one every older build can keep running on. Without a
reviewed entry, the lint accepts only these statements:

- `CREATE TABLE`, unless a `REFERENCES` clause lacks `ON DELETE CASCADE` or
  `ON DELETE SET NULL`
- `CREATE INDEX` that is not unique
- `ALTER TABLE ... ADD COLUMN` that is nullable or has a default, and has no
  `CHECK`, `REFERENCES`, `UNIQUE`, `COLLATE`, or `GENERATED` clause

A `NOT NULL` column without a default, a unique index, an `UPDATE`, or a table
rebuild can break an older build's inserts or queries even though nothing is
dropped. If such a statement is safe for older builds, add a
`COMPATIBLE_STEPS` entry whose reason says why. Otherwise it is a contract
migration.

### Contract migrations

A contract migration drops or renames something, or otherwise breaks older
builds. Follow expand and contract: first ship a release whose code no longer
reads or writes the old shape, which keeps that release additive, and drop the
shape in a later release. The floor lands on the expand release, so that
release keeps opening the database and only builds older than it refuse. Keep
contract steps rare and batch cleanups into one.

1. Add a `CONTRACT_STEPS` entry keyed by the migration's tag. `breaks` lists
   exactly what the lint detects, and `reason` says what older builds would
   hit. Set `expandedIn` to the newest migration that shipped in the release
   whose code no longer uses the old shape. It is required after migration
   0092, and must be an earlier migration in the journal.
2. Append `floorUpsertStatement(<when>, "<tag>")` to the end of the SQL file.
   `<when>` is the journal `when` of the `expandedIn` migration, and `<tag>` is
   the contract step's own tag, which the floor records as `raised_by`. The
   lint prints the exact call when it is missing. Using the step's own `when`
   would make the expand release refuse the database too, so the lint rejects
   it.

The upsert raises the floor in the same transaction as the break, so any build
older than the expand release refuses `database-newer` and names the step.
Only contract steps and migration 0092, which created the floor table, may
write `mcode_schema_compatibility`.

Builds released before 0092 do not read the floor. They are not protected from
a contract step, and nothing can protect them.

### Make statements safe to replay

From 0092 on, the lint requires `IF NOT EXISTS` on `CREATE TABLE` and
`CREATE [UNIQUE] INDEX`, and `IF EXISTS` on `DROP TABLE` and `DROP INDEX`.
drizzle-kit does not emit them, so add them by hand before the migration
ships. SQLite has no `IF NOT EXISTS` for `ADD COLUMN`; the guard's
`schema-ahead-of-ledger` verdict stops a column add from replaying instead.

### Never edit a shipped SQL file

Installed ledgers store each file's hash. Changing a shipped file, even to fix
it, makes every database that ran it refuse with `migration-mismatch`. Line
endings are the one exception: the catalogue accepts the LF and CRLF spellings
of the same SQL. Fix a shipped mistake with a new migration.

## Parallel branches

Two branches that run `db:generate` from the same parent both emit the next number.
The number is not the danger. Startup skips any migration whose journal `when`
is older than the newest one a database has applied, so a migration that merges
late is silently never run on installs that already took the later one. The
lint fails when numbers repeat or skip, `when` stops rising, or snapshots stop
chaining. Its legacy exceptions excuse entries that shipped before it existed
and must not grow.

When the lint fails after a merge, rebase on `main`, delete the `.sql`, snapshot and
journal entry your branch generated, and run `db:generate` again. Never renumber or
hand-merge them. The lint only sees the branch it runs on, so also require branches
to be up to date before merging (or use a merge queue). Without that, two green
branches can still merge into a broken catalogue.

## Adding a reviewed repair

A damaged ledger is refused until someone reviews its exact shape. To accept a
new shape, add an entry to `LEDGER_REPAIRS` in `ledger-guard.ts`:

- `covers` returns true only for the exact verdict and inspection the repair
  certifies, such as one named gap with its tables present. It sees only the
  read-only inspection, never a connection.
- `apply` writes the missing receipts. It runs inside the repair transaction
  after the guard has checked the shape again. Afterwards the ledger must
  classify as `behind` or `current`, or the whole start rolls back.
- Add a test that builds the real damaged shape by running the migrations and
  then removing receipts with SQL.

A repair restores receipts; it cannot prove that a migration's data backfill
ran. Only accept a shape when the missing migrations are schema-only, or when
the repair checks the data too.

## Breaking rewrites get a new database file

When a change would raise the floor past what users can reasonably be asked to
update for, do not migrate `mcode.db` in place. The new release copies it once
to a new file name and migrates the copy, so older builds keep reading the old
file. Copy through SQLite's backup API to a temporary file, then hard-link it
to the new name, so a partial copy is never published and an existing target is
never replaced. This mechanism does not exist yet; build it with the first
rewrite that needs it.

## Conversation conversion

Conversation conversion and retained execution-ID repair run through the
application database writer before display materialization and provider recovery.
See the [startup ordering](../../../apps/server/src/application/bootstrap/server-bootstrap.ts)
and [conversion owner](../../../apps/server/src/features/agents/conversation/migrations/legacy-conversation-migration-store.ts).

A completed legacy conversion does not exempt its retained execution IDs from
the wire UUID contract. Repair the original converter turn and checkpoint
together. Do not reimport classified messages to repair identifiers. Their current
display ownership may already belong to a newer turn. Startup applies this repair
in every build channel; it does not depend on an updater or a manual command.

## Conversation display materialization

After schema migration and before provider recovery, work admission, or readiness,
startup materializes canonical conversation items into the existing message and
narrative display tables. The materializer advances in small SQLite transactions.
It saves its source position only with the display rows in that transaction, so a
restart resumes the last incomplete batch.

Conversation page, message list, and turn reads use those display tables. They do
not merge canonical and legacy history while serving a request. `turn.load` returns
a bounded detail window. Clients request the next window with its validated detail
cursor only while that turn remains visible.

## Database location

The dev launchers (`bun run dev`, `bun run dev:desktop`, `bun run --shell system agent:up`) set
`MCODE_DATA_DIR` to `<repo>/.dev` and `MCODE_DB_PATH` to `<repo>/.dev/db/app.sqlite`, so every
checkout keeps its own database. `getMcodeDir()` throws when `MCODE_DATA_DIR` is unset outside a
production build; production falls back to `~/.mcode/mcode.db`.

## Known limitation: FK pragmas inside transactions

Startup runs all pending migrations inside one transaction. SQLite ignores
`PRAGMA foreign_keys` inside a transaction, so drizzle-kit's generated
`PRAGMA foreign_keys=OFF` statements are silently no-ops. This is harmless for
tables with no inbound FK references (the current state). A migration that
rebuilds a table other tables reference through a foreign key cannot run as an
ordinary migration. It needs a step outside the migration transaction, which
does not exist yet.
