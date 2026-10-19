import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { lazySchema } from "@mcode/contracts";
import { z } from "zod";

/**
 * Irregularities that shipped before the catalogue lint existed. Each is keyed to the entry it
 * excuses so a new migration cannot hide behind it.
 */
export const LEGACY_EXCEPTIONS = {
  repeatedNumbers: new Set(["0009"]),
  outOfOrderWhen: new Set(["0009_fancy_ben_urich"]),
  brokenSnapshotChain: new Set(["0009"]),
  missingSnapshots: new Set([
    "0012_bound_tool_output",
    "0013_thread_perf_indexes",
    "0014_message_mentions",
    "0015_branchless_checkout_state",
    "0016_branchless_base_branch",
    "0017_message_preview_annotations",
    "0032_external_thread_control",
    "0033_external_thread_control_active_integration",
    "0059_lively_auto_review",
  ]),
};

/** A schema object a migration creates, as named by its SQL text. */
export type SchemaObjectRef =
  | { kind: "table"; name: string }
  | { kind: "index"; name: string }
  | { kind: "column"; table: string; column: string };

/** One journal entry with its SQL, its accepted receipt hashes, and the objects it creates. */
export type CatalogueMigration = Readonly<{
  tag: string;
  index: number;
  when: number;
  /** Drizzle's own hash (sha256 of the file text) first, then the LF and CRLF spellings of the same SQL. */
  hash: string;
  hashes: ReadonlySet<string>;
  statements: readonly string[];
  /** Objects this migration alone creates. Objects created, dropped, or renamed elsewhere are left out. */
  creates: readonly SchemaObjectRef[];
}>;

/** Every migration the build ships, in journal order. */
export type MigrationCatalogue = Readonly<{
  directory: string;
  entries: readonly CatalogueMigration[];
  byWhen: ReadonlyMap<number, CatalogueMigration>;
  newestWhen: number;
}>;

export const journalSchema = lazySchema(() => z.object({
  entries: z.array(z.object({
    idx: z.number().int().nonnegative(),
    tag: z.string().regex(/^\d{4}_[a-z0-9_]+$/),
    when: z.number().int().positive(),
  })),
}));

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
export const IDENTIFIER = String.raw`(\`[^\`]+\`|"[^"]+"|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
export const CREATE_TABLE = new RegExp(String.raw`^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENTIFIER}`, "i");
export const CREATE_INDEX = new RegExp(String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENTIFIER}`, "i");
export const ADD_COLUMN = new RegExp(String.raw`^ALTER\s+TABLE\s+${IDENTIFIER}\s+ADD\s+(?:COLUMN\s+)?${IDENTIFIER}`, "i");
export const DROP_OBJECT = new RegExp(String.raw`^DROP\s+(TABLE|INDEX)\s+(?:IF\s+EXISTS\s+)?${IDENTIFIER}`, "i");
export const DROP_COLUMN = new RegExp(String.raw`^ALTER\s+TABLE\s+${IDENTIFIER}\s+DROP\s+(?:COLUMN\s+)?${IDENTIFIER}`, "i");
export const RENAME_TABLE = new RegExp(String.raw`^ALTER\s+TABLE\s+${IDENTIFIER}\s+RENAME\s+TO\s+${IDENTIFIER}`, "i");
export const RENAME_COLUMN = new RegExp(String.raw`^ALTER\s+TABLE\s+${IDENTIFIER}\s+RENAME\s+COLUMN\s+${IDENTIFIER}\s+TO\s+${IDENTIFIER}`, "i");
/** Drizzle rebuilds a table through `__new_<table>`; the rebuilt table is not a new object. */
export const RECREATE_PREFIX = "__new_";

function sha256(text: string): string {
  return NodeCrypto.createHash("sha256").update(text).digest("hex");
}

function hashesOf(sql: string): ReadonlySet<string> {
  const lf = sql.replace(/\r\n/g, "\n");
  return new Set([sha256(sql), sha256(lf), sha256(lf.replace(/\n/g, "\r\n"))]);
}

export function unquote(identifier: string): string {
  const first = identifier[0];
  const wrapped = first === "`" || first === '"' || first === "[";
  return (wrapped ? identifier.slice(1, -1) : identifier).toLowerCase();
}

function columnKey(table: string, column: string): string {
  return `column:${table}.${column}`;
}

function refKey(ref: SchemaObjectRef): string {
  return ref.kind === "column" ? columnKey(ref.table, ref.column) : `${ref.kind}:${ref.name}`;
}

function stripLeadingComments(statement: string): string {
  return statement.replace(/^(?:\s*--[^\r\n]*)+/, "").trim();
}

function splitStatements(sql: string): string[] {
  return sql.split(STATEMENT_BREAKPOINT).map(stripLeadingComments).filter((statement) => statement.length > 0);
}

type Occurrence = { position: number; entry: number };

type SchemaEffects = {
  created: Map<string, Occurrence[]>;
  removed: Map<string, Occurrence[]>;
  refs: Map<string, SchemaObjectRef>;
};

function record(map: Map<string, Occurrence[]>, key: string, occurrence: Occurrence): void {
  map.set(key, [...(map.get(key) ?? []), occurrence]);
}

function noteStatement(statement: string, occurrence: Occurrence, effects: SchemaEffects): void {
  const createTable = CREATE_TABLE.exec(statement);
  if (createTable?.[1]) {
    const name = unquote(createTable[1]);
    if (!name.startsWith(RECREATE_PREFIX)) noteCreate(effects, { kind: "table", name }, occurrence);
    return;
  }
  const createIndex = CREATE_INDEX.exec(statement);
  if (createIndex?.[1]) return noteCreate(effects, { kind: "index", name: unquote(createIndex[1]) }, occurrence);
  const addColumn = ADD_COLUMN.exec(statement);
  if (addColumn?.[1] && addColumn[2]) {
    return noteCreate(effects, { kind: "column", table: unquote(addColumn[1]), column: unquote(addColumn[2]) }, occurrence);
  }
  noteRemoval(statement, occurrence, effects);
}

function noteCreate(effects: SchemaEffects, ref: SchemaObjectRef, occurrence: Occurrence): void {
  effects.refs.set(refKey(ref), ref);
  record(effects.created, refKey(ref), occurrence);
}

const REMOVALS: ReadonlyArray<{ pattern: RegExp; key: (match: RegExpExecArray) => string | null }> = [
  { pattern: DROP_OBJECT, key: (m) => (m[1] && m[2] ? `${m[1].toLowerCase()}:${unquote(m[2])}` : null) },
  { pattern: DROP_COLUMN, key: (m) => (m[1] && m[2] ? columnKey(unquote(m[1]), unquote(m[2])) : null) },
  { pattern: RENAME_COLUMN, key: (m) => (m[1] && m[2] ? columnKey(unquote(m[1]), unquote(m[2])) : null) },
  { pattern: RENAME_TABLE, key: (m) => (m[1] ? `table:${unquote(m[1])}` : null) },
];

function noteRemoval(statement: string, occurrence: Occurrence, effects: SchemaEffects): void {
  for (const { pattern, key } of REMOVALS) {
    const match = pattern.exec(statement);
    const removedKey = match ? key(match) : null;
    if (removedKey) return record(effects.removed, removedKey, occurrence);
  }
}

/** An object certifies "this migration ran" only if nothing else in the catalogue could have created it. */
function isUnambiguous(key: string, effects: SchemaEffects): boolean {
  const created = effects.created.get(key) ?? [];
  const [only] = created;
  if (created.length !== 1 || !only) return false;
  return (effects.removed.get(key) ?? []).every((removal) => removal.position > only.position);
}

function readJournalEntries(directory: string, journalText: string) {
  const journal = journalSchema().parse(JSON.parse(journalText));
  return journal.entries.map((entry) => {
    const sql = NodeFS.readFileSync(NodePath.join(directory, `${entry.tag}.sql`), "utf8");
    return { entry, sql, statements: splitStatements(sql) };
  });
}

function buildCatalogue(directory: string, journalText: string): MigrationCatalogue {
  const loaded = readJournalEntries(directory, journalText);
  const effects: SchemaEffects = { created: new Map(), removed: new Map(), refs: new Map() };
  let position = 0;
  loaded.forEach(({ statements }, entry) => {
    for (const statement of statements) {
      position += 1;
      noteStatement(statement, { position, entry }, effects);
    }
  });
  const entries = loaded.map(({ entry, sql, statements }, ordinal): CatalogueMigration => ({
    tag: entry.tag,
    index: entry.idx,
    when: entry.when,
    hash: sha256(sql),
    hashes: hashesOf(sql),
    statements,
    creates: [...effects.refs]
      .filter(([key]) => effects.created.get(key)?.[0]?.entry === ordinal && isUnambiguous(key, effects))
      .map(([, ref]) => ref),
  }));
  return {
    directory,
    entries,
    byWhen: new Map(entries.map((entry) => [entry.when, entry])),
    newestWhen: entries.reduce((newest, entry) => Math.max(newest, entry.when), 0),
  };
}

/**
 * Parse every migration in a Drizzle directory.
 *
 * @param directory Path to a directory holding `meta/_journal.json` and the `.sql` files it lists.
 */
export function loadMigrationCatalogue(directory: string): MigrationCatalogue {
  const journalText = NodeFS.readFileSync(NodePath.join(directory, "meta", "_journal.json"), "utf8");
  return buildCatalogue(directory, journalText);
}

let catalogueMemo: { directory: string; journalText: string; catalogue: MigrationCatalogue } | null = null;

/**
 * The catalogue of the migrations folder this build uses. Re-parsed when the folder or its journal
 * changes, so tests and tools that grow a journal in place see the new entries.
 */
export function getMigrationCatalogue(): MigrationCatalogue {
  const directory = getDrizzleMigrationsDir();
  const journalText = NodeFS.readFileSync(NodePath.join(directory, "meta", "_journal.json"), "utf8");
  if (catalogueMemo?.directory !== directory || catalogueMemo.journalText !== journalText) {
    catalogueMemo = { directory, journalText, catalogue: buildCatalogue(directory, journalText) };
  }
  return catalogueMemo.catalogue;
}

/**
 * Drizzle's migrator joins paths with `/` inside readMigrationFiles; normalize so
 * Windows `migrationsFolder` strings remain valid for fs.*
 */
export function migrationsFolderForDrizzle(absDir: string): string {
  return NodePath.resolve(absDir).replace(/\\/g, "/");
}

function resolveDrizzleMigrationsDir(): string {
  const fromEnv = process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;
  if (fromEnv) {
    const dir = NodePath.resolve(fromEnv.trim());
    if (!NodeFS.existsSync(NodePath.join(dir, "meta", "_journal.json"))) {
      throw new Error(
        `MCODE_DRIZZLE_MIGRATIONS_DIR is set but meta/_journal.json is missing: ${dir}`,
      );
    }
    return dir;
  }

  let dir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  for (let i = 0; i < 20; i++) {
    const candidate = NodePath.join(dir, "drizzle");
    if (NodeFS.existsSync(NodePath.join(candidate, "meta", "_journal.json"))) {
      return NodePath.resolve(candidate);
    }
    const parent = NodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    "Drizzle migrations not found: no directory named drizzle/meta/_journal.json when walking up from this module",
  );
}

let drizzleDirMemo: { override: string | undefined; directory: string } | null = null;

function getDrizzleMigrationsDir(): string {
  const override = process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;
  if (!drizzleDirMemo || drizzleDirMemo.override !== override) {
    drizzleDirMemo = { override, directory: resolveDrizzleMigrationsDir() };
  }
  return drizzleDirMemo.directory;
}
