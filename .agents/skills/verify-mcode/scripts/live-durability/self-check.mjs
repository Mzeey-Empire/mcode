/** Offline checks of fixture protocol and scoped failure injection, using a fresh scratch DB. */
import * as NodeFS from 'node:fs';
import * as NodePath from 'node:path';
import * as NodeCrypto from 'node:crypto';
import * as NodeChildProcess from 'node:child_process';
import { Database } from 'bun:sqlite';
import { compareEventIdentities, semanticDescriptor } from './proof-model.mjs';
import * as NodeURL from 'node:url';

const repoRoot = process.cwd();
const directory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const scratch = NodePath.join(repoRoot, '.dev/verification/live-durability', 'self-check-' + NodeCrypto.randomUUID());
NodeFS.mkdirSync(NodePath.join(scratch, 'db'), { recursive: true });
const children = [];
let db;
try {
const id = NodeCrypto.randomUUID();
const dbPath = NodePath.join(scratch, 'db', 'app.sqlite');
db = new Database(dbPath);
db.exec('PRAGMA journal_mode=WAL');
db.exec('CREATE TABLE workspaces(id TEXT PRIMARY KEY,path TEXT); CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,workspace_id TEXT); CREATE TABLE canonical_agent_events(thread_id TEXT,envelope_json TEXT,execution_id TEXT)');
db.query('INSERT INTO workspaces VALUES(?,?)').run('fixture', NodePath.join(repoRoot, '.dev/fixture-repo'));
db.query('INSERT INTO threads VALUES(?,?,?)').run(id, 'Live durability proof ' + id, 'fixture');
const trigger = 'live_durability_' + id.replaceAll('-', '');
const operation = (op) => {
  const result = NodeChildProcess.spawnSync(process.execPath, [NodePath.join(directory, 'db-fault.mjs'), op, repoRoot, dbPath, id, trigger, '', id], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
};
operation('fail');
const envelope = JSON.stringify({ payload: { type: 'item.recorded', item: { kind: 'tool-call', payload: { projection: 'narrativeRecovery', narrative: { record: { id: id + '-tool' } } } } } });
let rejected = false;
try { db.query('INSERT INTO canonical_agent_events(thread_id,envelope_json) VALUES(?,?)').run(id, envelope); }
catch (error) { rejected = String(error).includes('LIVE_DURABILITY_FIXTURE_SAVE_REJECTED'); }
if (!rejected) throw new Error('Owned tool recovery did not reject');
db.query('INSERT INTO canonical_agent_events(thread_id,envelope_json) VALUES(?,?)').run('peer', envelope);
db.query('INSERT INTO canonical_agent_events(thread_id,envelope_json) VALUES(?,?)').run(id, JSON.stringify({ payload: { type: 'item.recorded', item: { kind: 'tool-call', payload: { projection: 'narrativeRecovery', narrative: { record: { id: id + '-prefix-tool' } } } } } }));
db.query('INSERT INTO canonical_agent_events(thread_id,envelope_json) VALUES(?,?)').run(id, JSON.stringify({ payload: { type: 'publication.recorded' } }));
operation('release');
db.query('INSERT INTO canonical_agent_events(thread_id,envelope_json) VALUES(?,?)').run(id, envelope);
const releaseFile = NodePath.join(scratch, id + '.self-check-unlock');
const lock = NodeChildProcess.spawn(process.execPath, [NodePath.join(directory, 'db-fault.mjs'), 'hold', repoRoot, dbPath, id, trigger, releaseFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
children.push(lock);
await new Promise((resolve, reject) => { lock.stdout.once('data', resolve); lock.once('error', reject); });
const readWhileHeld = new Database(dbPath, { readonly: true });
if (readWhileHeld.query('SELECT COUNT(*) AS count FROM canonical_agent_events').get().count !== 4) throw new Error('Held WAL writer blocked or changed readonly prefix');
readWhileHeld.close();
NodeFS.writeFileSync(releaseFile, 'release');
await new Promise((resolve) => lock.once('exit', resolve));
operation('fail-terminal');
const terminal = JSON.stringify({ payload: { type: 'turn.completed' } });
let terminalRejected = false;
try { db.query('INSERT INTO canonical_agent_events VALUES(?,?,?)').run(id, terminal, id); }
catch (error) { terminalRejected = String(error).includes('LIVE_DURABILITY_FIXTURE_TERMINAL_SAVE_REJECTED'); }
if (!terminalRejected) throw new Error('Exact measured terminal was not rejected');
db.query('INSERT INTO canonical_agent_events VALUES(?,?,?)').run('peer', terminal, id);
db.query('INSERT INTO canonical_agent_events VALUES(?,?,?)').run(id, terminal, NodeCrypto.randomUUID());
db.query('INSERT INTO canonical_agent_events VALUES(?,?,?)').run(id, JSON.stringify({ payload: { type: 'turn.interrupted' } }), id);
db.query('INSERT INTO canonical_agent_events VALUES(?,?,?)').run(id, envelope, id);
operation('release');
db.query('INSERT INTO canonical_agent_events VALUES(?,?,?)').run(id, terminal, id);
db.close();
db = null;

const accepted = { eventId: 'event', routing: { threadId: id, executionId: id }, acceptedSequence: 1,
  progressPosition: { epoch: 'epoch', sequence: 1 }, sourceProviderId: 'devin', sourceIdentities: [],
  serverTimestamps: { acceptedAt: '2026-09-30T00:00:00Z' }, payload: { type: 'publication.recorded', value: 'owned' } };
const saved = { ...accepted, durableRevision: 1, serverTimestamps: { ...accepted.serverTimestamps, persistedAt: '2026-09-30T00:00:01Z' } };
if (!compareEventIdentities([semanticDescriptor(accepted)], [semanticDescriptor(saved)]).exact) throw new Error('Save metadata changed the semantic identity comparison');
if (compareEventIdentities([semanticDescriptor(accepted)], [semanticDescriptor({ ...saved, payload: { value: 'changed' } })]).changed.length !== 1) throw new Error('Changed content was not detected');
if (compareEventIdentities([semanticDescriptor(accepted)], [semanticDescriptor(saved), semanticDescriptor(saved)]).duplicateStoredIds !== 1) throw new Error('Duplicate disk identities were not detected');

for (const provider of ['devin', 'codex']) {
  const runId = NodeCrypto.randomUUID();
  const child = NodeChildProcess.spawn(process.execPath, [NodePath.join(directory, 'provider-fixture.mjs'), provider, scratch, provider === 'devin' ? 'acp' : 'app-server'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const received = [];
  let pending = '';
  child.stdout.on('data', (chunk) => {
    pending += chunk.toString();
    for (;;) {
      const index = pending.indexOf('\n'); if (index < 0) break;
      received.push(JSON.parse(pending.slice(0, index))); pending = pending.slice(index + 1);
    }
  });
  const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
  const until = async (condition) => { const deadline = Date.now() + 5000; while (!condition()) { if (Date.now() > deadline) throw new Error('Fixture check timed out'); await new Promise((resolve) => setTimeout(resolve, 20)); } };
  send({ id: 1, method: 'initialize', params: {} });
  await until(() => received.some((item) => item.id === 1));
  send({ id: 2, method: provider === 'devin' ? 'session/prompt' : 'turn/start', params: provider === 'devin' ? { sessionId: 'test-session', prompt: [{ type: 'text', text: 'Owned fixture seed' }] } : { threadId: 'test-thread', input: [{ type: 'text', text: 'Owned fixture seed' }] } });
  await until(() => provider === 'devin' ? received.some((item) => item.id === 2 && item.result?.stopReason === 'end_turn') : received.some((item) => item.method === 'turn/completed' && item.params.turn.id === received.find((reply) => reply.id === 2)?.result?.turn?.id));
  const invokedAt = Date.now();
  send({ id: 3, method: provider === 'devin' ? 'session/prompt' : 'turn/start', params: provider === 'devin' ? { sessionId: 'test-session', prompt: [{ type: 'text', text: `LIVE_DURABILITY_RUN=${runId}` }] } : { threadId: 'test-thread', input: [{ type: 'text', text: `LIVE_DURABILITY_RUN=${runId}` }] } });
  await until(() => NodeFS.existsSync(NodePath.join(scratch, runId + '.prefix.json')));
  if (NodeFS.existsSync(NodePath.join(scratch, runId + '.tool.json'))) throw new Error('Fixture crossed gate before release');
  NodeFS.writeFileSync(NodePath.join(scratch, runId + '.release'), 'release');
  await until(() => NodeFS.existsSync(NodePath.join(scratch, runId + '.terminal.json')));
  const stamp = JSON.parse(NodeFS.readFileSync(NodePath.join(scratch, runId + '.terminal.json'), 'utf8'));
  if (stamp.runId !== runId || stamp.provider !== provider || Date.parse(stamp.at) < invokedAt) throw new Error('Native terminal stamp was stale or mismatched');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const terminal = provider === 'devin' ? received.some((item) => item.id === 3 && item.result?.stopReason === 'end_turn') : received.some((item) => item.method === 'turn/completed' && item.params.turn.id === received.find((reply) => reply.id === 3)?.result?.turn?.id);
  if (!terminal) throw new Error('Native terminal missing');
  const audit = NodeFS.readFileSync(NodePath.join(scratch, runId + '.audit.ndjson'), 'utf8').trim().split('\n');
  if (audit.length !== 1) throw new Error('Measured provider invocation was duplicated');
  const stoppedId = NodeCrypto.randomUUID();
  const stopPrompt = `LIVE_DURABILITY_RUN=${stoppedId}\nLIVE_DURABILITY_TERMINAL=pause\nLIVE_DURABILITY_CANCEL=honor`;
  send({ id: 4, method: provider === 'devin' ? 'session/prompt' : 'turn/start', params: provider === 'devin' ? { sessionId: 'test-session', prompt: [{ type: 'text', text: stopPrompt }] } : { threadId: 'test-thread', input: [{ type: 'text', text: stopPrompt }] } });
  await until(() => NodeFS.existsSync(NodePath.join(scratch, stoppedId + '.prefix.json')));
  NodeFS.writeFileSync(NodePath.join(scratch, stoppedId + '.release'), 'release');
  await until(() => NodeFS.existsSync(NodePath.join(scratch, stoppedId + '.after-tool.json')));
  if (NodeFS.existsSync(NodePath.join(scratch, stoppedId + '.terminal.json'))) throw new Error('Paused fixture terminal crossed its gate');
  send({ id: 5, method: provider === 'devin' ? 'session/cancel' : 'turn/interrupt', params: provider === 'devin' ? { sessionId: 'test-session' } : { threadId: 'test-thread' } });
  await until(() => NodeFS.existsSync(NodePath.join(scratch, stoppedId + '.cancelled.json')) && NodeFS.existsSync(NodePath.join(scratch, stoppedId + '.terminal.json')));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const stoppedTerminal = provider === 'devin' ? received.some((item) => item.id === 4 && item.result?.stopReason === 'cancelled') : received.some((item) => item.method === 'turn/completed' && item.params.turn.id === received.find((reply) => reply.id === 4)?.result?.turn?.id && item.params.turn.status === 'interrupted');
  if (!stoppedTerminal) throw new Error('Honored Stop did not emit the native cancelled terminal');
  const longId = NodeCrypto.randomUUID();
  const longPrompt = `LIVE_DURABILITY_RUN=${longId}\nLIVE_DURABILITY_LONG_TOOLS=1000\nLIVE_DURABILITY_PAIR_DELAY_MS=0`;
  send({ id: 6, method: provider === 'devin' ? 'session/prompt' : 'turn/start', params: provider === 'devin' ? { sessionId: 'test-session', prompt: [{ type: 'text', text: longPrompt }] } : { threadId: 'test-thread', input: [{ type: 'text', text: longPrompt }] } });
  await until(() => NodeFS.existsSync(NodePath.join(scratch, longId + '.prefix.json')));
  NodeFS.writeFileSync(NodePath.join(scratch, longId + '.release'), 'release');
  await until(() => NodeFS.existsSync(NodePath.join(scratch, longId + '.long-history.json')) && NodeFS.existsSync(NodePath.join(scratch, longId + '.terminal.json')));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const historyId = (message) => provider === 'devin' ? message.params?.update?.toolCallId : message.params?.item?.id;
  const history = received.filter((message) => historyId(message)?.startsWith(longId + '-history-'));
  const starts = history.filter((message) => provider === 'devin' ? message.params.update.sessionUpdate === 'tool_call' : message.method === 'item/started');
  const completions = history.filter((message) => provider === 'devin' ? message.params.update.sessionUpdate === 'tool_call_update' && message.params.update.status === 'completed' : message.method === 'item/completed' && message.params.item.status === 'completed');
  if (starts.length !== 1000 || completions.length !== 1000 || starts.some((message, index) => historyId(message) !== `${longId}-history-${index}` || historyId(completions[index]) !== historyId(message))) throw new Error('Native long-turn pairs lost exact count/order/identities');
  if (NodeFS.readFileSync(NodePath.join(scratch, longId + '.audit.ndjson'), 'utf8').trim().split('\n').length !== 1) throw new Error('Long-turn provider invocation was duplicated');
  if (provider === 'codex') {
    const finalId = NodeCrypto.randomUUID();
    send({ id: 7, method: 'turn/start', params: { threadId: 'test-thread', input: [{ type: 'text', text: `LIVE_DURABILITY_RUN=${finalId}\nLIVE_DURABILITY_AFTER_FINAL=pause\nLIVE_DURABILITY_LEGACY_IDENTICAL_TEXT=true` }] } });
    await until(() => NodeFS.existsSync(NodePath.join(scratch, finalId + '.prefix.json')));
    NodeFS.writeFileSync(NodePath.join(scratch, finalId + '.release'), 'release');
    await until(() => received.some((message) => message.method === 'item/completed' && message.params.item.id === finalId + '-final') && NodeFS.existsSync(NodePath.join(scratch, finalId + '.after-final.json')));
    const finalTurnId = received.find((message) => message.id === 7).result.turn.id;
    const finalMessages = received.filter((message) => message.params?.item?.id === finalId + '-final' || message.params?.itemId === finalId + '-final');
    if (JSON.stringify(finalMessages.map((message) => message.method)) !== JSON.stringify(['item/started', 'item/agentMessage/delta', 'item/completed']) || Object.hasOwn(finalMessages[0].params.item, 'phase') || Object.hasOwn(finalMessages[2].params.item, 'phase')) throw new Error('Native phase-less final assistant item lifecycle was incomplete');
    const prefixMessage = received.find((message) => message.method === 'item/completed' && message.params.item.id === finalId + '-prefix');
    if (prefixMessage.params.item.phase !== 'commentary' || prefixMessage.params.item.id === finalMessages[2].params.item.id || prefixMessage.params.item.text !== `LIVE_DURABILITY ${finalId} IDENTICAL_LEGACY_TEXT` || finalMessages[2].params.item.text !== prefixMessage.params.item.text) throw new Error('Legacy identical text lost its separate native item identities');
    NodeFS.writeFileSync(NodePath.join(scratch, finalId + '.finish'), 'finish');
    send({ id: 8, method: 'model/list', params: {} });
    await until(() => received.some((message) => message.id === 8));
    if (received.some((message) => message.method === 'turn/completed' && message.params.turn.id === finalTurnId) || NodeFS.existsSync(NodePath.join(scratch, finalId + '.terminal.json'))) throw new Error('Final item completion or the earlier gate ended the native turn');
    NodeFS.writeFileSync(NodePath.join(scratch, finalId + '.finish-final'), 'finish');
    await until(() => received.some((message) => message.method === 'turn/completed' && message.params.turn.id === finalTurnId && message.params.turn.status === 'completed') && NodeFS.existsSync(NodePath.join(scratch, finalId + '.terminal.json')));
    if (NodeFS.readFileSync(NodePath.join(scratch, finalId + '.audit.ndjson'), 'utf8').trim().split('\n').length !== 1) throw new Error('Final gate reinvoked the provider');
    const partialId = NodeCrypto.randomUUID();
    send({ id: 9, method: 'turn/start', params: { threadId: 'test-thread', input: [{ type: 'text', text: `LIVE_DURABILITY_RUN=${partialId}\nLIVE_DURABILITY_DURING_FINAL=pause\nLIVE_DURABILITY_AFTER_FINAL=pause` }] } });
    await until(() => NodeFS.existsSync(NodePath.join(scratch, partialId + '.prefix.json')));
    NodeFS.writeFileSync(NodePath.join(scratch, partialId + '.release'), 'release');
    await until(() => NodeFS.existsSync(NodePath.join(scratch, partialId + '.partial-final.json')) && received.some((message) => message.method === 'item/agentMessage/delta' && message.params.itemId === partialId + '-final'));
    const partial = JSON.parse(NodeFS.readFileSync(NodePath.join(scratch, partialId + '.partial-final.json'), 'utf8'));
    const partialTurnId = received.find((message) => message.id === 9).result.turn.id;
    const partialItemMessages = () => received.filter((message) => message.params?.item?.id === partial.itemId || message.params?.itemId === partial.itemId);
    if (partial.turnId !== partialTurnId || partial.textMarker !== `LIVE_DURABILITY ${partialId} PARTIAL_FINAL` || partial.fullTextMarker !== partial.textMarker + ' COMPLETE' || JSON.stringify(partialItemMessages().map((message) => message.method)) !== JSON.stringify(['item/started', 'item/agentMessage/delta'])) throw new Error('Partial native final gate did not retain one open item');
    NodeFS.writeFileSync(NodePath.join(scratch, partialId + '.continue-final'), 'continue');
    await until(() => NodeFS.existsSync(NodePath.join(scratch, partialId + '.after-final.json')) && partialItemMessages().some((message) => message.method === 'item/completed'));
    const continued = partialItemMessages();
    if (JSON.stringify(continued.map((message) => message.method)) !== JSON.stringify(['item/started', 'item/agentMessage/delta', 'item/agentMessage/delta', 'item/completed']) || continued[1].params.delta + continued[2].params.delta !== partial.fullTextMarker || continued[3].params.item.text !== partial.fullTextMarker || continued[3].params.item.phase !== 'final_answer') throw new Error('Partial native final item lost its text or closing order');
    send({ id: 10, method: 'model/list', params: {} });
    await until(() => received.some((message) => message.id === 10));
    if (received.some((message) => message.method === 'turn/completed' && message.params.turn.id === partialTurnId)) throw new Error('Partial final item closure ended the held native turn');
    NodeFS.writeFileSync(NodePath.join(scratch, partialId + '.finish-final'), 'finish');
    await until(() => received.some((message) => message.method === 'turn/completed' && message.params.turn.id === partialTurnId && message.params.turn.status === 'completed') && NodeFS.existsSync(NodePath.join(scratch, partialId + '.terminal.json')));
    if (received.filter((message) => message.method === 'turn/completed' && message.params.turn.id === partialTurnId).length !== 1 || NodeFS.readFileSync(NodePath.join(scratch, partialId + '.audit.ndjson'), 'utf8').trim().split('\n').length !== 1) throw new Error('Partial final gate duplicated the native terminal or invocation');
  }
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
}
console.log(JSON.stringify({ ok: true, scopedTriggerRejectedOwnedTool: true, scopedTerminalRejectedExactExecution: true, otherTerminalWritesAccepted: true, peerWriteAccepted: true, nonRecoveryWriteAccepted: true, releaseAccepted: true, readonlyPrefixWhileWriterHeld: true, immutableSemanticIdentityChecks: true, acpGateAndTerminal: true, codexGateAndTerminal: true, acpAndCodexHonoredStop: true, acpAndCodex1000NativePairs: true, codexCompletedFinalBeforeNativeTerminal: true, codexLegacyIdenticalText: true, codexPartialFinalBeforeItemAndTurnClosure: true, scratch }));
} finally {
  db?.close();
  for (const child of children) if (child.exitCode === null) child.kill();
}
