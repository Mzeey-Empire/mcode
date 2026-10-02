import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { Database } from "bun:sqlite";
import { lazySchema } from "@mcode/contracts";
import { z } from "zod";

type ReviewedMigration = Readonly<{
  tag: string;
  when: number;
  lfHash: string;
  tables: readonly string[];
  columns: readonly Readonly<{ table: string; name: string }>[];
  indexes: readonly string[];
  removedIndexes: readonly string[];
}>;

// These six migrations contain only DDL. A later data migration cannot be certified from schema.
const reviewedMigrations: readonly ReviewedMigration[] = [
  {
    tag: "0061_hard_human_cannonball", when: 1790083253358,
    lfHash: "49da805ab65f0702f52e3ee170787218352ac654ed57639db783570fa6739400",
    tables: ["canonical_conversation_display_mappings", "conversation_display_materialization_state"],
    columns: [{ table: "messages", name: "parent_agent_provenance" }],
    indexes: ["idx_canonical_conversation_display_mappings_target", "idx_messages_thread_sequence_id", "idx_canonical_agent_items_created_id"],
    removedIndexes: [],
  },
  {
    tag: "0062_gifted_amazoness", when: 1790084880205,
    lfHash: "bf6f7a8231acee669d294bcafec05cc6931df4fc54f4b1d493e286d1f2be4e9d",
    tables: [], columns: [{ table: "messages", name: "legacy_provenance" }], indexes: [], removedIndexes: [],
  },
  {
    tag: "0063_sleepy_harrier", when: 1790092742883,
    lfHash: "d0d60b8d4b95c43c8fd9dbec7bcdf70b37dd6beeffa3ea50d7ec0487457371b1",
    tables: [], columns: [],
    indexes: ["idx_hook_executions_message_sort_order_id", "idx_thought_segments_message_final_sort_order_id",
      "idx_thought_segments_final_message_sort_order_id", "idx_tool_call_records_message_sort_order_id"],
    removedIndexes: ["idx_hook_executions_message_sort_order", "idx_thought_segments_message_sort_order", "idx_tool_call_records_message_sort_order"],
  },
  {
    tag: "0064_fuzzy_jimmy_woo", when: 1790262706352,
    lfHash: "07ae6ec02d387b3c83aace597b139223f96e49ca440f8706c744107332ee6dbb",
    tables: [], columns: [{ table: "thread_startups", name: "request_fingerprint" }], indexes: [], removedIndexes: [],
  },
  {
    tag: "0065_ambitious_blindfold", when: 1790275595252,
    lfHash: "4374735f24381a8aa08bb8acd9f6f32a50b04f12dd6db3c512d21938dea6c10b",
    tables: ["canonical_writer_operation_receipts"], columns: [], indexes: [], removedIndexes: [],
  },
  {
    tag: "0066_fat_amazoness", when: 1790286163932,
    lfHash: "d366d95abe90bf7e4e86980ffbbeaca8e7fb25aeee2b895d034134c731ec3c47",
    tables: ["canonical_writer_live_publication_heads"], columns: [], indexes: [], removedIndexes: [],
  },
];

const anchor = {
  tag: "0060_modern_tiger_shark", when: 1789133181264,
  hash: "8bfd22072f8ab59b8faa2e8812fba89d9b3a999054f84bb1ae425b7453e94277",
};

const journalSchema = lazySchema(() => z.object({
  entries: z.array(z.object({ tag: z.string(), when: z.number().int().positive() })),
}));
const ledgerSchema = lazySchema(() => z.array(z.object({
  hash: z.string(), created_at: z.number().nullable(),
})));
const columnSchema = lazySchema(() => z.object({
  name: z.string(), type: z.string(), notnull: z.number(),
  dflt_value: z.string().nullable(), pk: z.number(), hidden: z.number(),
}));
const columnsSchema = lazySchema(() => z.array(columnSchema()));
const foreignKeysSchema = lazySchema(() => z.array(z.object({
  seq: z.number(), table: z.string(), from: z.string(), to: z.string(),
  on_update: z.string(), on_delete: z.string(), match: z.string(),
})));
const indexesSchema = lazySchema(() => z.array(z.object({
  name: z.string(), unique: z.number(), origin: z.string(), partial: z.number(),
})));
const indexKeysSchema = lazySchema(() => z.array(z.object({
  seqno: z.number(), name: z.string().nullable(), desc: z.number(),
  coll: z.string().nullable(), key: z.number(),
})));
const sqlSchema = lazySchema(() => z.object({ sql: z.string().nullable() }).nullable());
const indexDefinitionSchema = lazySchema(() => z.object({
  tbl_name: z.string(), sql: z.string(),
}).nullable());

type Ledger = z.infer<ReturnType<typeof ledgerSchema>>;
type LoadedMigration = Readonly<{ reviewed: ReviewedMigration; sql: string; hash: string; hashes: ReadonlySet<string> }>;

function refused(reason: string): never {
  throw new Error(`Migration history repair refused: ${reason}`);
}

function sha256(content: string): string {
  return NodeCrypto.createHash("sha256").update(content).digest("hex");
}

function objectExists(db: Database, type: "table" | "index", name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) !== null;
}

function readColumns(db: Database, table: string) {
  return columnsSchema().parse(db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(table)})`).all());
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function readLedger(db: Database): Ledger {
  return ledgerSchema().parse(db.prepare("SELECT hash, created_at FROM __drizzle_migrations").all());
}

function ownsPresentArtifact(db: Database, migration: ReviewedMigration): boolean {
  return migration.tables.some((table) => objectExists(db, "table", table))
    || migration.indexes.some((index) => objectExists(db, "index", index))
    || migration.columns.some((column) => readColumns(db, column.table).some((actual) => actual.name === column.name));
}

function loadReviewedMigrations(directory: string): LoadedMigration[] {
  const journal = journalSchema().parse(JSON.parse(NodeFS.readFileSync(NodePath.join(directory, "meta", "_journal.json"), "utf8")));
  return reviewedMigrations.map((reviewed) => {
    const entry = journal.entries.find((candidate) => candidate.tag === reviewed.tag);
    if (entry?.when !== reviewed.when) refused(`${reviewed.tag} does not match its reviewed journal timestamp`);
    const sql = NodeFS.readFileSync(NodePath.join(directory, `${reviewed.tag}.sql`), "utf8");
    const lf = sql.replace(/\r\n/g, "\n");
    if (sha256(lf) !== reviewed.lfHash) refused(`${reviewed.tag} SQL differs from the reviewed DDL`);
    const hash = sha256(sql);
    return { reviewed, sql, hash, hashes: new Set([hash, sha256(lf), sha256(lf.replace(/\n/g, "\r\n"))]) };
  });
}

function assertHistoryCompatible(ledger: Ledger, migrations: readonly LoadedMigration[]): void {
  if (!ledger.some((receipt) => receipt.created_at === anchor.when && receipt.hash === anchor.hash)) {
    refused(`missing trusted ${anchor.tag} receipt`);
  }
  for (const migration of migrations) {
    const receipts = ledger.filter((receipt) => receipt.created_at === migration.reviewed.when);
    if (receipts.length > 1 || receipts.some((receipt) => !migration.hashes.has(receipt.hash))) {
      refused(`${migration.reviewed.tag} has conflicting recorded history`);
    }
  }
}

function referenceDatabase(migrations: readonly LoadedMigration[]): Database {
  const reference = new Database(":memory:", { strict: true });
  try {
    reference.exec(`
      CREATE TABLE messages (id TEXT, thread_id TEXT, sequence INTEGER);
      CREATE TABLE canonical_agent_items (id TEXT PRIMARY KEY, created_at TEXT);
      CREATE TABLE hook_executions (id TEXT, message_id TEXT, sort_order INTEGER);
      CREATE TABLE thought_segments (id TEXT, message_id TEXT, sort_order INTEGER, is_final_response INTEGER);
      CREATE TABLE tool_call_records (id TEXT, message_id TEXT, sort_order INTEGER);
      CREATE TABLE thread_startups (id TEXT);
      CREATE TABLE canonical_agent_turns (execution_id TEXT UNIQUE);
      CREATE TABLE threads (id TEXT PRIMARY KEY);
      CREATE INDEX idx_hook_executions_message_sort_order ON hook_executions (message_id, sort_order);
      CREATE INDEX idx_thought_segments_message_sort_order ON thought_segments (message_id, sort_order);
      CREATE INDEX idx_tool_call_records_message_sort_order ON tool_call_records (message_id, sort_order);
    `);
    for (const migration of migrations) reference.exec(migration.sql);
    return reference;
  } catch (error) {
    reference.close(true);
    throw error;
  }
}

function readSql(db: Database, type: "table" | "index", name: string): string {
  const row = sqlSchema().parse(db.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) ?? null);
  if (!row?.sql) refused(`missing ${type} ${name}`);
  return row.sql;
}

// Token comparison preserves literal bytes. Identifier quote conversion is limited to reviewed names.
function sqlTokens(sql: string, identifiers: ReadonlySet<string>): string[] {
  const tokens = sql.match(/--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[a-zA-Z_][a-zA-Z_0-9]*|[0-9]+|[^\s]/g) ?? [];
  return tokens.filter((token) => !token.startsWith("--") && !token.startsWith("/*")).map((token) => {
    if (token.startsWith("'")) return token;
    const unquoted = token.replace(/^["`[]|["`\]]$/g, "");
    if (identifiers.has(unquoted.toLowerCase())) return unquoted.toLowerCase();
    return /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(token) ? token.toLowerCase() : token;
  });
}

function assertSame(actual: unknown, expected: unknown, name: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) refused(`incompatible ${name}`);
}

function readIndexKeys(db: Database, name: string) {
  return indexKeysSchema().parse(db.prepare(`PRAGMA index_xinfo(${quoteIdentifier(name)})`).all());
}

function readIndexes(db: Database, table: string) {
  return indexesSchema().parse(db.prepare(`PRAGMA index_list(${quoteIdentifier(table)})`).all());
}

function uniqueIndexes(db: Database, table: string) {
  return readIndexes(db, table).filter((index) => index.unique !== 0).map((index) => ({
    origin: index.origin, partial: index.partial, keys: readIndexKeys(db, index.name),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function readForeignKeys(db: Database, table: string) {
  return foreignKeysSchema().parse(db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all())
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function assertNewTable(db: Database, reference: Database, table: string): void {
  const columns = readColumns(reference, table);
  const foreignKeys = readForeignKeys(reference, table);
  const identifiers = new Set([table, ...columns.map((column) => column.name),
    ...foreignKeys.flatMap((key) => [key.table, key.from, key.to])]);
  assertSame(sqlTokens(readSql(db, "table", table), identifiers), sqlTokens(readSql(reference, "table", table), identifiers), `${table} CREATE definition`);
  assertSame(readColumns(db, table), columns, `${table} columns`);
  assertSame(readForeignKeys(db, table), foreignKeys, `${table} foreign keys`);
  assertSame(uniqueIndexes(db, table), uniqueIndexes(reference, table), `${table} unique indexes`);
}

function assertAddedColumn(db: Database, reference: Database, column: Readonly<{ table: string; name: string }>): void {
  const expected = readColumns(reference, column.table).find((candidate) => candidate.name === column.name);
  const actual = readColumns(db, column.table).find((candidate) => candidate.name === column.name);
  const label = `${column.table}.${column.name} column`;
  assertSame(actual, expected, label);
  const actualDeclarations = columnDeclarations(db, column);
  const expectedDeclarations = columnDeclarations(reference, column);
  const declaration = actualDeclarations.find((tokens) => tokens[0] === column.name);
  assertSame(declaration, expectedDeclarations.find((tokens) => tokens[0] === column.name), `${label} declaration`);
  if (actualDeclarations.some((tokens) => tokens !== declaration && checkConstrainsColumn(tokens, column.name))) {
    refused(`${label} participates in an additional table constraint`);
  }
  if (readForeignKeys(db, column.table).some((key) => key.from === column.name)) {
    refused(`${label} participates in an additional foreign key`);
  }
  if (readIndexes(db, column.table).some((index) => index.unique !== 0 && indexConstrainsColumn(db, index.name, column.name))) {
    refused(`${label} participates in an additional unique index`);
  }
}

function tableDeclarations(tokens: readonly string[]): string[][] {
  const start = tokens.indexOf("(");
  if (start < 0) refused("table CREATE definition has no declarations");
  const declarations: string[][] = [];
  let current: string[] = [];
  let depth = 0;
  for (const token of tokens.slice(start + 1)) {
    if (token === "(") depth += 1;
    if (token === ")") {
      if (depth === 0) return [...declarations, current];
      depth -= 1;
    }
    if (token === "," && depth === 0) {
      declarations.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  return refused("table CREATE definition has unclosed declarations");
}

function columnDeclarations(db: Database, column: Readonly<{ table: string; name: string }>): string[][] {
  const identifiers = new Set([column.table, column.name]);
  return tableDeclarations(sqlTokens(readSql(db, "table", column.table), identifiers)).map((tokens) => {
    // SQLite also permits a single-quoted identifier specifically in a declaration's name position.
    if (tokens[0] === `'${column.name}'`) return [column.name, ...tokens.slice(1)];
    return tokens;
  });
}

function checkConstrainsColumn(tokens: readonly string[], column: string): boolean {
  return tokens.some((token, index) => token === "check"
    && tableDeclarations(tokens.slice(index)).flat().includes(column));
}

function indexConstrainsColumn(db: Database, index: string, column: string): boolean {
  if (readIndexKeys(db, index).some((key) => key.key !== 0 && key.name === column)) return true;
  const row = sqlSchema().parse(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(index) ?? null);
  // Expression keys have no column name in index_xinfo; their SQL and partial predicate retain dependencies.
  if (!row?.sql) return false;
  const tokens = sqlTokens(row.sql, new Set([column]));
  return tokens.slice(tokens.indexOf("(") + 1).includes(column);
}

function indexDescriptor(db: Database, name: string) {
  const definition = indexDefinitionSchema().parse(db.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) ?? null);
  if (!definition) refused(`missing index ${name}`);
  const index = readIndexes(db, definition.tbl_name).find((candidate) => candidate.name === name);
  if (!index) refused(`missing index descriptor ${name}`);
  const keys = readIndexKeys(db, name);
  const identifiers = new Set([name, definition.tbl_name, ...keys.flatMap((key) => key.name === null ? [] : [key.name])]);
  return { unique: index.unique, origin: index.origin, partial: index.partial, keys, sql: sqlTokens(definition.sql, identifiers) };
}

function assertSchemaCompatible(db: Database, reference: Database): void {
  for (const migration of reviewedMigrations) {
    for (const table of migration.tables) assertNewTable(db, reference, table);
    for (const column of migration.columns) assertAddedColumn(db, reference, column);
    for (const index of migration.indexes) assertSame(indexDescriptor(db, index), indexDescriptor(reference, index), `index ${index}`);
    for (const index of migration.removedIndexes) {
      if (objectExists(db, "index", index)) refused(`obsolete index ${index} still exists`);
    }
  }
}

function repairKnownWindow(db: Database, directory: string): void {
  const ledger = readLedger(db);
  const recorded = new Set(ledger.map((receipt) => receipt.created_at));
  const missing = reviewedMigrations.filter((migration) => !recorded.has(migration.when));
  const watermark = ledger.reduce((latest, receipt) => Math.max(latest, receipt.created_at ?? 0), 0);
  if (!missing.some((migration) => migration.when <= watermark || ownsPresentArtifact(db, migration))) return;

  const migrations = loadReviewedMigrations(directory);
  assertHistoryCompatible(ledger, migrations);
  const reference = referenceDatabase(migrations);
  try {
    assertSchemaCompatible(db, reference);
    const insert = db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)");
    for (const migration of migrations) {
      if (!recorded.has(migration.reviewed.when)) insert.run(migration.hash, migration.reviewed.when);
    }
  } finally {
    reference.close(true);
  }
}

/** Restore only the confirmed 0061–0066 DDL receipts; all other historical records stay untouched. */
export function repairLostConversationWriterReceipts(db: Database, directory: string): void {
  if (!objectExists(db, "table", "__drizzle_migrations")) return;
  const journal = journalSchema().parse(JSON.parse(NodeFS.readFileSync(NodePath.join(directory, "meta", "_journal.json"), "utf8")));
  if (!reviewedMigrations.every((migration) => journal.entries.some((entry) => entry.tag === migration.tag))) return;
  // Certification and append share the write transaction so concurrent startup cannot invalidate the proof.
  db.transaction(() => repairKnownWindow(db, directory)).immediate();
}
