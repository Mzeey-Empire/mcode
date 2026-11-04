import type { DiagRecord } from "@mcode/shared/diagnostics";
import {
  CanonicalDatabase,
  findThreadIdsWithCheckpointIn,
  findDelegatedDescendants,
  findWorkspaceThreadIds,
  readCanonicalEvents,
  readLatestCheckpoints,
  readThreadSummaries,
} from "./canonical-db.js";
import { compareByTime, type DiagQuery, type Evidence, type ThreadView } from "./model.js";
import { readRecordings, type RecordingSelection } from "./recordings.js";

function requestedThreadIds(q: DiagQuery, database: CanonicalDatabase): string[] | undefined {
  const workspace = q.workspace;
  if (workspace) {
    const inWorkspace = database.read([], (db) => findWorkspaceThreadIds(db, workspace));
    if (q.thread) return inWorkspace.filter((id) => id === q.thread);
    return inWorkspace;
  }
  if (q.thread) return [q.thread];
  return undefined;
}

/** A delegated child can hang its parent, and may run in another worktree's workspace, so scoped reads follow delegation. */
function scopedThreadIds(q: DiagQuery, database: CanonicalDatabase): string[] | undefined {
  const requested = requestedThreadIds(q, database);
  if (!requested) return undefined;
  const delegated = database.read([], (db) => findDelegatedDescendants(db, requested));
  return [...new Set([...requested, ...delegated])];
}

function discoverThreadIds(q: DiagQuery, database: CanonicalDatabase, records: readonly DiagRecord[]): string[] {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.th) ids.add(record.th);
  }
  const checkpointed = database.read([], (db) => findThreadIdsWithCheckpointIn(db, q.since, q.until));
  for (const id of checkpointed) ids.add(id);
  return [...ids];
}

function viewFor(views: Map<string, ThreadView>, id: string): ThreadView {
  const existing = views.get(id);
  if (existing) return existing;
  const created: ThreadView = { id, rows: [] };
  views.set(id, created);
  return created;
}

function addRecordings(views: Map<string, ThreadView>, records: readonly DiagRecord[]): void {
  for (const record of records) {
    if (record.th) viewFor(views, record.th).rows.push(record);
  }
}

function addCanonicalEvidence(
  views: Map<string, ThreadView>,
  threadIds: readonly string[],
  q: DiagQuery,
  database: CanonicalDatabase,
): void {
  const summaries = database.read([], (db) => readThreadSummaries(db, threadIds));
  for (const summary of summaries) {
    const view = viewFor(views, summary.id);
    view.title = summary.title;
    view.workspace = summary.workspaceId;
    view.coordinator = summary.coordinatorId ?? undefined;
  }

  const checkpoints = database.read([], (db) => readLatestCheckpoints(db, threadIds, q.until));
  for (const checkpoint of checkpoints) {
    const view = viewFor(views, checkpoint.threadId);
    view.checkpoint = { phase: checkpoint.phase, terminal: checkpoint.terminal, updated: checkpoint.updated };
  }

  const events = database.read([], (db) => readCanonicalEvents(db, threadIds, q.since, q.until));
  for (const event of events) {
    viewFor(views, event.threadId).rows.push({
      t: event.t,
      n: event.sequence,
      ch: "db.canonical",
      k: "ev",
      th: event.threadId,
      d: event.itemKind
        ? { type: event.type, item: event.itemKind, sequence: event.sequence }
        : { type: event.type, sequence: event.sequence },
    });
  }
}

function collectEvidence(q: DiagQuery, database: CanonicalDatabase): Evidence {
  const scoped = scopedThreadIds(q, database);
  const selection: RecordingSelection = scoped
    ? { kind: "threads", threadIds: scoped }
    : { kind: "modified-since", since: q.since };
  const records = readRecordings(q.dataDir, selection);
  const threadIds = scoped ?? discoverThreadIds(q, database, records);

  const views = new Map<string, ThreadView>();
  // Lanes are lettered in view order, so seeding the scope keeps a parent ahead of its delegated children.
  for (const id of scoped ?? []) viewFor(views, id);
  addRecordings(views, records);
  addCanonicalEvidence(views, threadIds, q, database);

  const threads = [...views.values()];
  for (const view of threads) {
    view.rows.sort(compareByTime);
  }
  return { records, threads, database: database.status, dbError: database.error };
}

/**
 * Read the recordings and canonical rows a query needs. Reads stay inside the query's scope:
 * a thread query opens that thread's files, a workspace query opens its threads' files, and an
 * unscoped query opens only the files and rows touched in the window.
 */
export function loadEvidence(q: DiagQuery): Evidence {
  const database = CanonicalDatabase.open(q);
  try {
    return collectEvidence(q, database);
  } finally {
    database.close();
  }
}
