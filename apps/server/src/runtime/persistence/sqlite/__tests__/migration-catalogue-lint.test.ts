import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lintMigrationCatalogue } from "../migration-catalogue-lint.js";

type Entry = { idx: number; tag: string; when: number };
type Snapshot = { id: string; prevId: string };
type Catalogue = {
  entries: Entry[];
  snapshots: Map<number, Snapshot>;
  sqlFiles: Set<string>;
  journalText?: string;
};

const FIX = "Rebase on main, delete the migration files your branch generated, and run `bun run db:generate` again.";

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
  for (const file of catalogue.sqlFiles) NodeFS.writeFileSync(NodePath.join(root, file), "SELECT 1;");
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
    expect(lintMigrationCatalogue(writeCatalogue(root, cleanCatalogue()))).toEqual([]);
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
    expect(lintMigrationCatalogue(writeCatalogue(root, catalogue)), FIX).toEqual(expected);
  });

  it("accepts the committed catalogue", () => {
    // Vitest runs with apps/server as the working directory.
    expect(lintMigrationCatalogue(NodePath.join(process.cwd(), "drizzle")), FIX).toEqual([]);
  });
});
