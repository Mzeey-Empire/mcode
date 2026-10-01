/** Offline safety/result contracts; these tests do not connect to an application. */
import * as NodeAssertStrict from 'node:assert/strict';
import * as NodeFS from 'node:fs';
import * as NodeOS from 'node:os';
import * as NodePath from 'node:path';
import * as NodeTest from 'node:test';
import * as NodeChildProcess from 'node:child_process';
import * as NodeURL from 'node:url';
import { canonicalFrames, compareEventIdentities, semanticDescriptor } from './proof-model.mjs';
import { requireSaveOutcome, requireHealthyPrefix } from './outcomes.mjs';
import { validateElectronRuntime } from './runtime-identity.mjs';
import { classifyCapacityEvidence } from './capacity-evidence.mjs';

NodeTest.test('distinguishes retained-save capacity from provider saturation, stale attempts, and BUSY exhaustion', () => {
  const base = { threadId: 'owned', executionId: 'execution', timestamp: '2026-09-30T17:01:00Z', message: 'Worker dispatch failed' };
  const entries = [
    { ...base, error: 'Accepted progress admission rejected: retention-exhausted' },
    { ...base, error: 'Devin canonical event queue overflowed for execution execution' },
    { ...base, error: { message: 'Canonical writer write-failed: database is locked' }, exhausted: true },
    { ...base, threadId: 'peer', error: 'Accepted progress admission rejected: retention-exhausted' },
    { ...base, executionId: 'old', error: 'Accepted progress admission rejected: retention-exhausted' },
    { ...base, timestamp: '2026-09-30T16:00:00Z', error: 'Accepted progress admission rejected: retention-exhausted' },
  ];
  const result = classifyCapacityEvidence(['malformed', ...entries.map(entry => JSON.stringify(entry))], { threadId: 'owned', executionId: 'execution', invokedAt: '2026-09-30T17:00:00Z' });
  NodeAssertStrict.deepEqual(result.map(entry => entry.kind), ['retained-save-capacity', 'provider-publisher-capacity', 'sqlite-busy']);
  NodeAssertStrict.equal(result[2].exhausted, true);
});

NodeTest.test('imports the public helper when the persistent REPL has no process global', () => {
  const entry = NodeURL.pathToFileURL(NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), '../live-durability.mjs')).href;
  const script = `const ownedProcess = process; globalThis.process = undefined; const proof = await import(${JSON.stringify(entry)}); if (typeof proof.connect !== 'function' || typeof proof.readElectronRuntimeIdentity !== 'function') throw new Error('Missing public proof imports'); ownedProcess.exitCode = 0;`;
  const result = NodeChildProcess.spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true });
  NodeAssertStrict.equal(result.status, 0, result.stderr);
});

NodeTest.test('pairs the captured Electron/server instance with its exact database and renderer', () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'mcode-durability-contract-'));
  try {
    const userDataDir = NodePath.join(root, '.dev', 'electron-live-testing');
    NodeFS.mkdirSync(NodePath.join(userDataDir, 'runtime'), { recursive: true });
    const session = { repoRoot: root, userDataDir, status: 'running', pid: process.pid, appUrlPrefix: 'http://127.0.0.1:41768/' };
    const lock = { pid: process.pid, startedAt: '2026-09-30T17:00:00Z', port: 41767, authToken: 'offline-fixture-token' };
    NodeFS.writeFileSync(NodePath.join(root, '.dev', 'electron-live-testing.json'), JSON.stringify(session));
    NodeFS.writeFileSync(NodePath.join(userDataDir, 'runtime', 'server.lock'), JSON.stringify(lock));
    const identity = { client: 'electron', sessionFileName: 'electron-live-testing.json', electronPid: process.pid,
      serverPid: process.pid, serverStartedAt: lock.startedAt, dbPath: NodePath.join(userDataDir, 'runtime', 'db', 'app.sqlite') };
    const input = { repoRoot: root, dbPath: identity.dbPath, runtimeIdentity: identity,
      pageUrl: session.appUrlPrefix, serverUrl: 'ws://localhost:41767/?token=offline-fixture-token' };
    NodeAssertStrict.equal(validateElectronRuntime(input).serverStartedAt, lock.startedAt);
    NodeAssertStrict.throws(() => validateElectronRuntime({ ...input, runtimeIdentity: undefined }), /explicit owned/);
    NodeAssertStrict.throws(() => validateElectronRuntime({ ...input, dbPath: NodePath.join(root, '.dev', 'db', 'app.sqlite') }), /identity\/database changed/);
    NodeAssertStrict.throws(() => validateElectronRuntime({ ...input, serverUrl: 'ws://localhost:41769/?token=offline-fixture-token' }), /endpoint/);
    NodeAssertStrict.throws(() => validateElectronRuntime({ ...input, pageUrl: 'http://127.0.0.1:41769/' }), /endpoint/);
    NodeAssertStrict.throws(() => validateElectronRuntime({ ...input, runtimeIdentity: { ...identity, serverStartedAt: '2026-09-30T17:00:01Z' } }), /identity\/database changed/);
  } finally {
    NodeAssertStrict.equal(NodePath.dirname(root), NodePath.resolve(NodeOS.tmpdir()));
    NodeAssertStrict.ok(NodePath.basename(root).startsWith('mcode-durability-contract-'));
    NodeFS.rmSync(root, { recursive: true });
  }
});

NodeTest.test('requires the chosen outcome and native cancellation for an Interrupted proof', () => {
  const terminal = { runId: 'owned', phase: 'terminal', at: '2026-09-30T17:00:00Z' };
  requireSaveOutcome({ expectedOutcome: 'completed', snapshot: { phase: 'completed' }, terminal });
  NodeAssertStrict.throws(() => requireSaveOutcome({ expectedOutcome: 'completed', snapshot: { phase: 'interrupted' }, terminal }), /differs/);
  NodeAssertStrict.throws(() => requireSaveOutcome({ expectedOutcome: 'completed', snapshot: { phase: 'completed' }, terminal, cancelled: {} }), /Cancelled/);
  NodeAssertStrict.throws(() => requireSaveOutcome({ expectedOutcome: 'interrupted', snapshot: { phase: 'interrupted' }, terminal }), /cancellation/);
  requireSaveOutcome({ expectedOutcome: 'interrupted', snapshot: { phase: 'interrupted' }, terminal, cancelled: { phase: 'cancelled' } });
});

NodeTest.test('does not treat cleared renderer activity or a replaced public execution as healthy', () => {
  const active = { snapshot: { phase: 'running', turnExecutionId: 'owned' }, executionId: 'owned', prefixRendered: true, stopButtonCount: 1, terminal: null };
  requireHealthyPrefix(active);
  NodeAssertStrict.throws(() => requireHealthyPrefix({ ...active, stopButtonCount: 0 }), /Renderer\/native/);
  NodeAssertStrict.throws(() => requireHealthyPrefix({ ...active, snapshot: { phase: 'errored', turnExecutionId: 'owned' } }), /Public execution/);
  NodeAssertStrict.throws(() => requireHealthyPrefix({ ...active, terminal: { phase: 'terminal' } }), /Renderer\/native/);
});

NodeTest.test('rejects retired protocol and detects changed, missing, and duplicated durable identities', () => {
  NodeAssertStrict.throws(() => canonicalFrames([{ channel: 'agent.canonical', data: { threadId: 'owned' } }], 'owned'), /rebuild/);
  const event = { eventId: 'owned:event', routing: { threadId: 'owned', executionId: 'execution' }, acceptedSequence: 1,
    sourceProviderId: 'codex', sourceIdentities: [], serverTimestamps: { acceptedAt: '2026-09-30T17:00:00Z' }, payload: { type: 'turn.completed' } };
  const accepted = semanticDescriptor(event);
  const saved = semanticDescriptor({ ...event, durableRevision: 2, serverTimestamps: { ...event.serverTimestamps, persistedAt: 'later' } });
  NodeAssertStrict.equal(compareEventIdentities([accepted, accepted], [saved]).exact, true);
  NodeAssertStrict.deepEqual(compareEventIdentities([accepted], []).missing, [event.eventId]);
  NodeAssertStrict.equal(compareEventIdentities([accepted], [saved, saved]).duplicateStoredIds, 1);
  NodeAssertStrict.equal(compareEventIdentities([accepted], [semanticDescriptor({ ...event, payload: { type: 'turn.interrupted' } })]).changed.length, 1);
  NodeAssertStrict.throws(() => compareEventIdentities([accepted, { ...accepted, semanticHash: 'changed' }], []), /immutable identity/);
});
