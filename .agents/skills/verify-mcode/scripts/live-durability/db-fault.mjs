/** Bun-only, owned-fixture SQLite failure injection; never opens a user database. */
import { Database } from 'bun:sqlite';
import * as NodeFS from 'node:fs';
import * as NodePath from 'node:path';
import * as NodeCrypto from 'node:crypto';
import { semanticDescriptor } from './proof-model.mjs';

const [op, repoRoot, databasePath, threadId, triggerName, releaseFile, executionId] = process.argv.slice(2);
const devRoot = NodePath.resolve(repoRoot, '.dev');
const dbPath = NodePath.resolve(databasePath);
if (!dbPath.startsWith(devRoot + NodePath.sep) || !dbPath.endsWith(NodePath.join('db', 'app.sqlite')) || !NodeFS.existsSync(dbPath)) throw new Error('Database must be an existing owned .dev runtime database');
if (!/^[a-f0-9-]{36}$/.test(threadId) || !/^live_durability_[a-f0-9]{32}$/.test(triggerName)) throw new Error('Invalid owned-fault identity');
const db = new Database(dbPath, op === 'inspect' ? { readonly: true } : { readwrite: true, create: false });
db.exec('PRAGMA busy_timeout=2000');
const owner = db.query('SELECT t.title, w.path FROM threads t JOIN workspaces w ON w.id=t.workspace_id WHERE t.id=?').get(threadId);
const q = (value) => "'" + value.replaceAll("'", "''") + "'";
const runHex = triggerName.slice('live_durability_'.length);
const runId = `${runHex.slice(0, 8)}-${runHex.slice(8, 12)}-${runHex.slice(12, 16)}-${runHex.slice(16, 20)}-${runHex.slice(20)}`;
if (owner?.title !== 'Live durability proof ' + runId || NodePath.resolve(owner.path).toLowerCase() !== NodePath.resolve(repoRoot, '.dev', 'fixture-repo').toLowerCase()) throw new Error('Thread is not owned by this exact fixture proof');
try {
  if (op === 'fail') {
    // Exact thread, exact recovery projection, exact provider tool: other work stays writable.
    db.exec(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON canonical_agent_events
      WHEN NEW.thread_id=${q(threadId)}
        AND json_extract(NEW.envelope_json, '$.payload.type')='item.recorded'
        AND json_extract(NEW.envelope_json, '$.payload.item.kind')='tool-call'
        AND json_extract(NEW.envelope_json, '$.payload.item.payload.projection')='narrativeRecovery'
        AND json_extract(NEW.envelope_json, '$.payload.item.payload.narrative.record.id')=${q(runId + '-tool')}
      BEGIN SELECT RAISE(ABORT, 'LIVE_DURABILITY_FIXTURE_SAVE_REJECTED'); END`);
    console.log(JSON.stringify({ op, armed: true, threadId, triggerName }));
  } else if (op === 'fail-terminal') {
    if (!/^[a-f0-9-]{36}$/.test(executionId ?? '')) throw new Error('Terminal rejection requires the measured execution ID');
    db.exec(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON canonical_agent_events
      WHEN NEW.thread_id=${q(threadId)} AND NEW.execution_id=${q(executionId)}
        AND json_extract(NEW.envelope_json, '$.payload.type')='turn.completed'
      BEGIN SELECT RAISE(ABORT, 'LIVE_DURABILITY_FIXTURE_TERMINAL_SAVE_REJECTED'); END`);
    console.log(JSON.stringify({ op, armed: true, threadId, executionId, triggerName }));
  } else if (op === 'release') {
    db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
    console.log(JSON.stringify({ op, removed: true, threadId }));
  } else if (op === 'hold') {
    if (!NodePath.resolve(releaseFile).startsWith(NodePath.resolve(repoRoot, '.dev', 'verification', 'live-durability') + NodePath.sep)) throw new Error('Invalid lock release file');
    db.exec('BEGIN IMMEDIATE');
    const deadline = Date.now() + 120_000;
    console.log(JSON.stringify({ op, held: true, threadId, pid: process.pid, expiresAt: new Date(deadline).toISOString() }));
    while (!NodeFS.existsSync(releaseFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    db.exec('ROLLBACK');
  } else if (op !== 'inspect') throw new Error('Unknown fault operation');
  if (op === 'inspect') {
    const events = db.query('SELECT event_id, accepted_sequence, durable_revision, envelope_json FROM canonical_agent_events WHERE thread_id=? ORDER BY durable_revision').all(threadId);
    const serialized = events.map((event) => event.envelope_json).join('\n');
    const ownMarkers = Object.fromEntries(['INITIAL_THOUGHT', 'PREFIX', 'AFTER_TOOL', 'COMPLETE'].map((part) => [part, serialized.includes(`LIVE_DURABILITY ${runId} ${part}`)]));
    const history = new Map();
    for (const event of events) {
      const item = JSON.parse(event.envelope_json).payload?.item;
      const record = item?.payload?.projection === 'narrativeRecovery' ? item.payload.narrative?.record : null;
      if (typeof record?.id === 'string' && record.id.startsWith(`${runId}-history-`)) history.set(record.id, record.status);
    }
    const historyIds = [...history.keys()].sort();
    const longHistory = { uniqueTools: history.size, completedTools: [...history.values()].filter((status) => status === 'completed').length,
      identityHash: NodeCrypto.createHash('sha256').update(JSON.stringify(historyIds)).digest('hex'),
      firstIdentity: historyIds[0] ?? null, lastIdentity: historyIds.at(-1) ?? null };
    console.log(JSON.stringify({ threadId, eventCount: events.length, acceptedSequences: events.map((event) => event.accepted_sequence), revisions: events.map((e) => e.durable_revision), eventIds: events.map((e) => e.event_id), descriptors: events.map((event) => semanticDescriptor(JSON.parse(event.envelope_json))), payloadTypes: events.map((e) => JSON.parse(e.envelope_json).payload?.type), ownMarkers, longHistory, prefixToolRecoverySaved: events.some((event) => event.event_id.includes(`toolCall:${runId}-prefix-tool:`)), measuredToolRecoverySaved: events.some((event) => event.event_id.includes(`toolCall:${runId}-tool:`)), triggerPresent: !!db.query('SELECT name FROM sqlite_master WHERE type=\'trigger\' AND name=?').get(triggerName) }));
  }
} finally { db.close(); }
