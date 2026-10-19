import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  detectSchemaBreaks,
  lintMigrationCatalogue,
  type LintPolicy,
  type SchemaSnapshot,
} from "../migration-catalogue-lint.js";
import { floorUpsertStatement } from "../migration-contract-steps.js";

type Entry = { idx: number; tag: string; when: number };
type Snapshot = { id: string; prevId: string };
type Catalogue = {
  entries: Entry[];
  snapshots: Map<number, Snapshot>;
  sqlFiles: Set<string>;
  journalText?: string;
  sql?: Record<string, string>;
};

const FIX = "Rebase on main, delete the migration files your branch generated, and run `bun run db:generate` again.";
const BREAKPOINT = "\n--> statement-breakpoint\n";
const NEUTRAL_POLICY: LintPolicy = { floorTag: null, contractSteps: {}, compatibleSteps: {} };

function cleanCatalogue(): Catalogue {
  const tags = ["0000_base", "0001_add_users", "0002_add_posts", "0003_add_tags"];
  return {
    entries: tags.map((tag, idx) => ({ idx, tag, when: 1_000 + idx * 10 })),
    snapshots: new Map(tags.map((_, number) => [number, { id: `s${number}`, prevId: number === 0 ? "root" : `s${number - 1}` }])),
    sqlFiles: new Set(tags.map((tag) => `${tag}.sql`)),
  };
}

function writeCatalogue(root: string, catalogue: Catalogue): string {
  const meta = NodePath.join(root, "meta");
  NodeFS.mkdirSync(meta, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(meta, "_journal.json"),
    catalogue.journalText ?? JSON.stringify({ version: "7", dialect: "sqlite", entries: catalogue.entries }),
  );
  for (const file of catalogue.sqlFiles) NodeFS.writeFileSync(NodePath.join(root, file), catalogue.sql?.[file] ?? "SELECT 1;");
  for (const [number, snapshot] of catalogue.snapshots) {
    NodeFS.writeFileSync(NodePath.join(meta, `${String(number).padStart(4, "0")}_snapshot.json`), JSON.stringify(snapshot));
  }
  return root;
}

describe("lintMigrationCatalogue", () => {
  let root: string;

  beforeEach(() => {
    root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-catalogue-lint-"));
  });

  afterEach(() => {
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("accepts a catalogue where each migration follows the last", () => {
    expect(lintMigrationCatalogue(writeCatalogue(root, cleanCatalogue()), NEUTRAL_POLICY)).toEqual([]);
  });

  it.each<{ name: string; damage: (catalogue: Catalogue) => void; expected: unknown[] }>([
    {
      // Two PRs both generated number 4 from the same parent and a merge kept both.
      name: "two migrations share a number",
      damage: (catalogue) => {
        catalogue.entries.push({ idx: 4, tag: "0004_from_a", when: 2_000 }, { idx: 4, tag: "0004_from_b", when: 2_010 });
        catalogue.sqlFiles.add("0004_from_a.sql").add("0004_from_b.sql");
        catalogue.snapshots.set(4, { id: "s4", prevId: "s3" });
      },
      expected: ["0004_from_b follows number 4; numbers must rise by one with no repeats or gaps"],
    },
    {
      name: "a number is skipped",
      damage: (catalogue) => {
        catalogue.entries.push({ idx: 5, tag: "0005_skips_four", when: 2_000 });
        catalogue.sqlFiles.add("0005_skips_four.sql");
        catalogue.snapshots.set(5, { id: "s5", prevId: "s3" });
      },
      expected: ["0005_skips_four follows number 3; numbers must rise by one with no repeats or gaps"],
    },
    {
      // Generated early on a branch that merged late: databases that applied 0004 skip it.
      name: "a new migration is older than one before it",
      damage: (catalogue) => {
        catalogue.entries.push({ idx: 4, tag: "0004_merged_late", when: 1_005 });
        catalogue.sqlFiles.add("0004_merged_late.sql");
        catalogue.snapshots.set(4, { id: "s4", prevId: "s3" });
      },
      expected: ["0004_merged_late has a timestamp not newer than an earlier migration, so installs that applied the later one would skip it"],
    },
    {
      name: "a snapshot was generated from an older parent",
      damage: (catalogue) => {
        catalogue.entries.push({ idx: 4, tag: "0004_stale_parent", when: 2_000 });
        catalogue.sqlFiles.add("0004_stale_parent.sql");
        catalogue.snapshots.set(4, { id: "s4", prevId: "s2" });
      },
      expected: ["0004_snapshot.json was generated from a different parent than the snapshot before it"],
    },
    {
      name: "a new migration has no snapshot",
      damage: (catalogue) => {
        catalogue.snapshots.delete(3);
      },
      expected: ["0003_add_tags has no 0003_snapshot.json; generate migrations with drizzle-kit"],
    },
    {
      name: "an SQL file has no journal entry",
      damage: (catalogue) => {
        catalogue.sqlFiles.add("0004_unlisted.sql");
      },
      expected: ["0004_unlisted.sql has no journal entry"],
    },
    {
      name: "a journal entry has no SQL file",
      damage: (catalogue) => {
        catalogue.sqlFiles.delete("0003_add_tags.sql");
      },
      expected: ["0003_add_tags is in the journal but 0003_add_tags.sql is missing"],
    },
    {
      name: "the journal still has merge conflict markers",
      damage: (catalogue) => {
        catalogue.journalText = "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> branch";
      },
      expected: [expect.stringContaining("_journal.json could not be read as JSON")],
    },
  ])("rejects a catalogue where $name", ({ damage, expected }) => {
    const catalogue = cleanCatalogue();
    damage(catalogue);
    expect(lintMigrationCatalogue(writeCatalogue(root, catalogue), NEUTRAL_POLICY), FIX).toEqual(expected);
  });

  it("accepts the committed catalogue", () => {
    expect(lintMigrationCatalogue(NodePath.join(process.cwd(), "drizzle")), FIX).toEqual([]);
  });

  describe("compatibility rules", () => {
    const FLOOR_TAG = "0001_add_users";
    const NEXT_TAG = "0002_add_posts";
    const NEXT_WHEN = 1_020;
    const EXPANDED_TAG = "0000_base";
    const EXPANDED_WHEN = 1_000;
    const FLOOR_SQL = "CREATE TABLE IF NOT EXISTS `mcode_schema_compatibility` (`id` integer PRIMARY KEY DEFAULT 1 NOT NULL);";
    const ownUpsert = floorUpsertStatement(NEXT_WHEN, NEXT_TAG);
    const expandedUpsert = floorUpsertStatement(EXPANDED_WHEN, NEXT_TAG);
    const policy = (overrides: Partial<LintPolicy> = {}): LintPolicy => ({
      floorTag: FLOOR_TAG,
      contractSteps: {},
      compatibleSteps: {},
      ...overrides,
    });
    const contractStep = (breaks: string[], expandedIn = EXPANDED_TAG) => ({ [NEXT_TAG]: { breaks, reason: "Reviewed.", expandedIn } });
    const stepWithoutExpandedIn = (breaks: string[]) => ({ [NEXT_TAG]: { breaks, reason: "Reviewed." } });

    function lintNext(nextSql: string, lintPolicy: LintPolicy, floorSql = FLOOR_SQL): string[] {
      const base = cleanCatalogue();
      const catalogue: Catalogue = {
        entries: base.entries.slice(0, 3),
        snapshots: new Map([...base.snapshots].slice(0, 3)),
        sqlFiles: new Set([...base.sqlFiles].slice(0, 3)),
        sql: { [`${FLOOR_TAG}.sql`]: floorSql, [`${NEXT_TAG}.sql`]: nextSql },
      };
      return lintMigrationCatalogue(writeCatalogue(root, catalogue), lintPolicy);
    }

    it("passes statements that older builds always tolerate", () => {
      const additive = [
        "CREATE TABLE IF NOT EXISTS `posts` (`id` integer PRIMARY KEY NOT NULL);",
        "CREATE INDEX IF NOT EXISTS `posts_id_idx` ON `posts` (`id`);",
        "ALTER TABLE `users` ADD `nickname` text;",
        "ALTER TABLE `users` ADD `role` text DEFAULT 'member' NOT NULL;",
      ].join(BREAKPOINT);

      expect(lintNext(additive, policy())).toEqual([]);
    });

    it.each([
      { name: "an UPDATE", sql: "UPDATE `users` SET `role` = 'member';", mention: "UPDATE" },
      {
        name: "a unique index",
        sql: "CREATE UNIQUE INDEX IF NOT EXISTS `users_name_unique` ON `users` (`name`);",
        mention: "UNIQUE INDEX",
      },
      {
        name: "a NOT NULL column without a default",
        sql: "ALTER TABLE `users` ADD `role` text NOT NULL;",
        mention: "NOT NULL",
      },
      { name: "a CHECK column", sql: "ALTER TABLE `users` ADD `age` integer CHECK (`age` > 0);", mention: "CHECK" },
      { name: "a UNIQUE column", sql: "ALTER TABLE `users` ADD `handle` text UNIQUE;", mention: "UNIQUE" },
      { name: "a COLLATE column", sql: "ALTER TABLE `users` ADD `handle` text COLLATE NOCASE;", mention: "COLLATE" },
      {
        name: "a GENERATED column",
        sql: "ALTER TABLE `users` ADD `initial` text GENERATED ALWAYS AS (substr(`name`, 1, 1));",
        mention: "GENERATED",
      },
      { name: "a column with a foreign key", sql: "ALTER TABLE `posts` ADD `author_id` text REFERENCES `users`(`id`);", mention: "REFERENCES" },
      {
        name: "a table whose foreign key keeps the default delete action",
        sql: "CREATE TABLE IF NOT EXISTS `comments` (`id` integer PRIMARY KEY NOT NULL, `post_id` integer, FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE no action);",
        mention: "CREATE TABLE",
      },
      {
        name: "a table with a foreign key that names no delete action",
        sql: "CREATE TABLE IF NOT EXISTS `comments` (`id` integer PRIMARY KEY NOT NULL, `post_id` integer REFERENCES `posts`(`id`));",
        mention: "CREATE TABLE",
      },
      {
        name: "a table where only one of two foreign keys releases on delete",
        sql: "CREATE TABLE IF NOT EXISTS `comments` (`id` integer PRIMARY KEY NOT NULL, `post_id` integer, `user_id` integer, FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON DELETE cascade, FOREIGN KEY (`user_id`) REFERENCES `users`(`id`));",
        mention: "CREATE TABLE",
      },
    ])("rejects $name that has no reviewed entry", ({ sql, mention }) => {
      expect(lintNext(sql, policy())).toEqual([
        expect.stringContaining(`${NEXT_TAG} has statements older builds may not tolerate`),
      ]);
      expect(lintNext(sql, policy())[0]).toContain(mention);
    });

    it("passes a new table whose foreign keys cascade or clear on delete", () => {
      const table = "CREATE TABLE IF NOT EXISTS `comments` (`id` integer PRIMARY KEY NOT NULL, `post_id` integer, `user_id` integer, FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade, FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE set null);";

      expect(lintNext(table, policy())).toEqual([]);
    });

    it("accepts the same statement once a COMPATIBLE_STEPS entry explains it", () => {
      const compatible = { [NEXT_TAG]: { reason: "Backfill that older builds ignore." } };

      expect(lintNext("UPDATE `users` SET `role` = 'member';", policy({ compatibleSteps: compatible }))).toEqual([]);
    });

    it("does not hold migrations before the floor migration to the allowlist", () => {
      const base = cleanCatalogue();
      const catalogue: Catalogue = {
        entries: base.entries.slice(0, 3),
        snapshots: new Map([...base.snapshots].slice(0, 3)),
        sqlFiles: new Set([...base.sqlFiles].slice(0, 3)),
        sql: { "0000_base.sql": "UPDATE `users` SET `role` = 'member';", [`${FLOOR_TAG}.sql`]: FLOOR_SQL, [`${NEXT_TAG}.sql`]: "SELECT 1;" },
      };
      const problems = lintMigrationCatalogue(writeCatalogue(root, catalogue), policy({ compatibleSteps: { [NEXT_TAG]: { reason: "Not additive." } } }));

      expect(problems).toEqual([]);
    });

    it("accepts a contract step that raises the floor to its expandedIn migration", () => {
      const sql = ["ALTER TABLE `users` DROP COLUMN `nickname`;", expandedUpsert].join(BREAKPOINT);

      expect(lintNext(sql, policy({ contractSteps: contractStep(["drop-column users.nickname"]) }))).toEqual([]);
    });

    it("rejects a contract step after the floor migration that does not name expandedIn", () => {
      const sql = ["ALTER TABLE `users` DROP COLUMN `nickname`;", ownUpsert].join(BREAKPOINT);

      expect(lintNext(sql, policy({ contractSteps: stepWithoutExpandedIn(["drop-column users.nickname"]) }))).toEqual([
        expect.stringContaining(`${NEXT_TAG} is a contract step after the floor migration and must set expandedIn`),
      ]);
    });

    it("rejects a contract step whose upsert uses its own when, which would lock out the expand release", () => {
      const sql = ["ALTER TABLE `users` DROP COLUMN `nickname`;", ownUpsert].join(BREAKPOINT);

      expect(lintNext(sql, policy({ contractSteps: contractStep(["drop-column users.nickname"]) }))).toEqual([
        expect.stringContaining(`must raise the floor with floorUpsertStatement(${EXPANDED_WHEN}, "${NEXT_TAG}")`),
        expect.stringContaining("a contract step may only write it with the floor upsert for its expandedIn migration"),
      ]);
    });

    it("rejects a contract step whose upsert carries another timestamp or tag", () => {
      const wrongWhen = ["ALTER TABLE `users` DROP COLUMN `nickname`;", floorUpsertStatement(EXPANDED_WHEN + 1, NEXT_TAG)].join(BREAKPOINT);
      const wrongTag = ["ALTER TABLE `users` DROP COLUMN `nickname`;", floorUpsertStatement(EXPANDED_WHEN, "0099_other")].join(BREAKPOINT);
      const contractSteps = contractStep(["drop-column users.nickname"]);

      for (const sql of [wrongWhen, wrongTag]) {
        expect(lintNext(sql, policy({ contractSteps }))).toEqual([
          expect.stringContaining("must raise the floor"),
          expect.stringContaining("a contract step may only write it with the floor upsert for its expandedIn migration"),
        ]);
      }
    });

    it("rejects a contract step that does not raise the floor", () => {
      const sql = "ALTER TABLE `users` DROP COLUMN `nickname`;";

      expect(lintNext(sql, policy({ contractSteps: contractStep(["drop-column users.nickname"]) }))).toEqual([
        expect.stringContaining(`${NEXT_TAG} is a contract step and must raise the floor`),
      ]);
    });

    it("rejects an expandedIn that is not an earlier migration", () => {
      const sql = ["ALTER TABLE `users` DROP COLUMN `nickname`;", ownUpsert].join(BREAKPOINT);

      expect(lintNext(sql, policy({ contractSteps: contractStep(["drop-column users.nickname"], NEXT_TAG) }))).toContainEqual(
        expect.stringContaining(`says it was expanded in ${NEXT_TAG}, which is not an earlier migration`),
      );
    });

    it("rejects a migration that is not a contract step but writes the floor table", () => {
      const compatible = { [NEXT_TAG]: { reason: "Reviewed." } };
      const updates = lintNext("UPDATE `mcode_schema_compatibility` SET `floor_when` = 0;", policy({ compatibleSteps: compatible }));
      const upserts = lintNext(ownUpsert, policy({ compatibleSteps: compatible }));

      for (const problems of [updates, upserts]) {
        expect(problems).toEqual([expect.stringContaining("only the floor migration and contract steps may write it")]);
      }
    });

    it("rejects a drop or rename that has no CONTRACT_STEPS entry", () => {
      const problems = lintNext("ALTER TABLE `users` DROP COLUMN `nickname`;", policy());

      expect(problems).toContainEqual(expect.stringContaining(
        `${NEXT_TAG} breaks older builds (drop-column users.nickname) but has no CONTRACT_STEPS entry`,
      ));
    });

    it("rejects a CONTRACT_STEPS entry that does not match what the migration breaks", () => {
      const sql = ["ALTER TABLE `users` DROP COLUMN `nickname`;", expandedUpsert].join(BREAKPOINT);

      expect(lintNext(sql, policy({ contractSteps: contractStep(["drop-column users.other"]) }))).toEqual([
        expect.stringContaining("CONTRACT_STEPS lists [drop-column users.other] but the migration breaks [drop-column users.nickname]"),
      ]);
    });

    it("requires IF NOT EXISTS and IF EXISTS after the floor migration so a replay is harmless", () => {
      const sql = ["CREATE TABLE `posts` (`id` integer);", "CREATE INDEX `posts_idx` ON `posts` (`id`);"].join(BREAKPOINT);

      expect(lintNext(sql, policy())).toEqual([
        expect.stringContaining(`${NEXT_TAG} needs IF NOT EXISTS`),
        expect.stringContaining(`${NEXT_TAG} needs IF NOT EXISTS`),
      ]);
      expect(lintNext("DROP TABLE `posts`;", policy({ contractSteps: contractStep(["drop-table posts"]) })))
        .toContainEqual(expect.stringContaining(`${NEXT_TAG} needs IF EXISTS`));
    });

    it("holds the floor migration itself to re-runnable statements and to creating and seeding the floor table only", () => {
      const withoutGuard = "CREATE TABLE `mcode_schema_compatibility` (`id` integer PRIMARY KEY DEFAULT 1 NOT NULL);";
      const withExtra = [FLOOR_SQL, "CREATE TABLE IF NOT EXISTS `extra` (`id` integer);"].join(BREAKPOINT);

      expect(lintNext("SELECT 1;", policy(), withoutGuard)).toContainEqual(expect.stringContaining(`${FLOOR_TAG} needs IF NOT EXISTS`));
      expect(lintNext("SELECT 1;", policy(), withExtra)).toContainEqual(expect.stringContaining(`${FLOOR_TAG} may only create`));
    });
  });
});

describe("detectSchemaBreaks", () => {
  const snapshot = (tables: Record<string, string[]>): SchemaSnapshot => ({
    id: "s",
    prevId: "p",
    tables: Object.fromEntries(Object.entries(tables).map(([table, columns]) => [table, { columns: Object.fromEntries(columns.map((column) => [column, {}])) }])),
  });
  const detect = (statements: string[], previous?: SchemaSnapshot, current?: SchemaSnapshot): string[] =>
    detectSchemaBreaks({ statements }, previous, current);

  it("reports dropped columns and tables from the SQL", () => {
    expect(detect(["ALTER TABLE `users` DROP COLUMN `nickname`;", "DROP TABLE `old_posts`;"]))
      .toEqual(["drop-column users.nickname", "drop-table old_posts"]);
  });

  it("reports a column a table rebuild leaves out, which the SQL does not show", () => {
    const statements = [
      "CREATE TABLE `__new_users` (`id` integer);",
      "INSERT INTO `__new_users`(`id`) SELECT `id` FROM `users`;",
      "DROP TABLE `users`;",
      "ALTER TABLE `__new_users` RENAME TO `users`;",
    ];

    expect(detect(statements, snapshot({ users: ["id", "nickname"] }), snapshot({ users: ["id"] })))
      .toEqual(["drop-column users.nickname"]);
    expect(detect(statements)).toEqual([]);
  });

  it("reports a rename once, not also as the drop of the name it left", () => {
    expect(detect(
      ["ALTER TABLE `users` RENAME COLUMN `nick` TO `nickname`;"],
      snapshot({ users: ["id", "nick"] }),
      snapshot({ users: ["id", "nickname"] }),
    )).toEqual(["rename-column users.nick->nickname"]);
    expect(detect(["ALTER TABLE `old_posts` RENAME TO `posts`;"], snapshot({ old_posts: ["id"] }), snapshot({ posts: ["id"] })))
      .toEqual(["rename-table old_posts->posts"]);
  });

  it("does not count scratch tables or a table dropped and created again as a break", () => {
    expect(detect([
      "CREATE TEMP TABLE `scratch` (`id` integer);",
      "DROP TABLE `scratch`;",
      "DROP TABLE `posts`;",
      "CREATE TABLE `posts` (`id` integer);",
    ])).toEqual([]);
  });
});
