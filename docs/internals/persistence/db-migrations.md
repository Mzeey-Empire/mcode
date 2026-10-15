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

## Parallel branches

Two branches that run `db:generate` from the same parent both emit the next number.
The number is not the danger. Drizzle's `migrate()` skips any migration whose
journal `when` is older than the newest one a database has applied, so a migration
that merges late is silently never run on installs that already took the later one.
[`migration-catalogue-lint.ts`](../../../apps/server/src/runtime/persistence/sqlite/migration-catalogue-lint.ts)
fails the server tests when numbers repeat or skip, `when` stops rising, or snapshots
stop chaining. Its legacy exceptions excuse entries that shipped before it existed
and must not grow.

When the lint fails after a merge, rebase on `main`, delete the `.sql`, snapshot and
journal entry your branch generated, and run `db:generate` again. Never renumber or
hand-merge them. The lint only sees the branch it runs on, so also require branches
to be up to date before merging (or use a merge queue). Without that, two green
branches can still merge into a broken catalogue.

App startup runs Drizzle `migrate()` programmatically against the user's SQLite file,
including legacy `_migrations` detection (`bootstrapDrizzle`) so existing installs
upgrade without manual steps.

Applied migration records are historical evidence and must survive opening with
older bundles or differently formatted SQL. Removing a record leaves its schema
in place and makes a later startup replay DDL. The bounded
[`migration-history-repair.ts`](../../../apps/server/src/runtime/persistence/sqlite/migration-history-repair.ts)
repairs the known lost 0061–0066 records only after certifying their complete
reviewed DDL. Repairing those records cannot prove that a data backfill ran.

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

## Branch-specific databases (development)

In a linked git worktree (where `.git` is a file pointing at the common git dir),
dev mode uses `<toplevel>/.mcode-local/mcode.db` inside that checkout so schemas
stay with the worktree.

When developing in the primary repo directory (`main` checkout with `.git/` as a
directory), `NODE_ENV` is not `production` and `MCODE_GIT_BRANCH` is set (or
detected via `git rev-parse`), the DB file is `<mcodeDir>/dbs/dev-<hash>.db`
instead of `<mcodeDir>/mcode.db`. Production stays on `~/.mcode/mcode.db`.

## Known limitation: FK pragmas inside transactions

Drizzle's `migrate()` wraps each migration in a transaction. SQLite ignores
`PRAGMA foreign_keys` inside transactions, so Drizzle Kit's generated
`PRAGMA foreign_keys=OFF` statements are silently no-ops. This is harmless for
tables with no inbound FK references (the current state). If a future migration
needs to rebuild a table that other tables reference via FK, the SQL must be
split into a separate non-transactional step or applied manually outside
`migrate()`.
