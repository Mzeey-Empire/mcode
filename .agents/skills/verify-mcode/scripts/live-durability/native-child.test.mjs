/** Process-only raw Codex fixture checks. These do not connect to Mcode or prove UI behavior. */
import * as NodeTest from 'node:test';
import * as NodeAssertStrict from 'node:assert/strict';
import * as NodeFS from 'node:fs';
import * as NodeOS from 'node:os';
import * as NodePath from 'node:path';
import * as NodeURL from 'node:url';
import * as NodeCrypto from 'node:crypto';
import * as NodeChildProcess from 'node:child_process';

async function fixture(t, provider = 'codex') {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'mcode-native-child-'));
  const script = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), 'provider-fixture.mjs');
  const child = NodeChildProcess.spawn(process.execPath, [script, provider, scratch, provider === 'codex' ? 'app-server' : 'acp'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const received = [];
  let buffered = '';
  child.stdout.on('data', chunk => {
    buffered += chunk.toString();
    for (;;) {
      const index = buffered.indexOf('\n'); if (index < 0) break;
      received.push(JSON.parse(buffered.slice(0, index))); buffered = buffered.slice(index + 1);
    }
  });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    NodeAssertStrict.equal(NodePath.dirname(scratch), NodePath.resolve(NodeOS.tmpdir()));
    NodeAssertStrict.ok(NodePath.basename(scratch).startsWith('mcode-native-child-'));
    NodeFS.rmSync(scratch, { recursive: true });
  });
  const send = (request) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...request }) + '\n');
  const wait = async (predicate) => {
    const end = Date.now() + 5000;
    while (!predicate()) { if (Date.now() >= end) throw new Error('Raw native fixture stage timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  return { scratch, received, send, wait };
}

async function start(f, childMode) {
  const runId = NodeCrypto.randomUUID();
  const invokedAt = Date.now();
  f.send({ id: 1, method: 'turn/start', params: { threadId: 'owned-parent', input: [{ type: 'text',
    text: `LIVE_DURABILITY_RUN=${runId}\nLIVE_DURABILITY_CHILD=${childMode}\nLIVE_DURABILITY_TERMINAL=pause\nLIVE_DURABILITY_CANCEL=honor` }] } });
  await f.wait(() => NodeFS.existsSync(NodePath.join(f.scratch, runId + '.prefix.json')));
  NodeFS.writeFileSync(NodePath.join(f.scratch, runId + '.release'), 'release');
  await f.wait(() => NodeFS.existsSync(NodePath.join(f.scratch, runId + '.child-prefix.json')));
  const native = JSON.parse(NodeFS.readFileSync(NodePath.join(f.scratch, runId + '.child-prefix.json'), 'utf8'));
  NodeAssertStrict.ok(Date.parse(native.at) >= invokedAt);
  const parentTurnId = f.received.find(message => message.id === 1).result.turn.id;
  return { runId, native, parentTurnId };
}

NodeTest.test('binds a raw child before its lifecycle and completes it independently of the parent', async (t) => {
  const f = await fixture(t);
  const { runId, native, parentTurnId } = await start(f, 'completed');
  await f.wait(() => NodeFS.existsSync(NodePath.join(f.scratch, runId + '.child-completed.json')));
  const spawnIndex = f.received.findIndex(message => message.method === 'item/completed' && message.params.item.id === native.collabId);
  const childStartIndex = f.received.findIndex(message => message.method === 'turn/started' && message.params.threadId === native.threadId);
  NodeAssertStrict.ok(spawnIndex >= 0 && childStartIndex > spawnIndex);
  NodeAssertStrict.deepEqual(f.received[spawnIndex].params.item.receiverThreadIds, [native.threadId]);
  NodeAssertStrict.ok(f.received.some(message => message.method === 'turn/completed' && message.params.turn.id === native.turnId && message.params.turn.status === 'completed'));
  NodeAssertStrict.ok(f.received.some(message => message.method === 'item/agentMessage/delta' && message.params.threadId === native.threadId && message.params.delta.includes('CHILD_COMPLETE')));
  NodeAssertStrict.equal(f.received.some(message => message.method === 'turn/completed' && message.params.turn.id === parentTurnId), false);
  for (const [index, method] of ['thread/resume', 'thread/read', 'thread/items/list'].entries()) {
    f.send({ id: index + 2, method, params: { threadId: native.threadId } });
    await f.wait(() => f.received.some(message => message.id === index + 2));
  }
  NodeAssertStrict.equal(f.received.find(message => message.id === 2).result.thread.name, 'durability_child');
  NodeAssertStrict.equal(f.received.find(message => message.id === 4).result.data[0].item.type, 'userMessage');
  NodeFS.writeFileSync(NodePath.join(f.scratch, runId + '.finish'), 'finish');
  await f.wait(() => f.received.some(message => message.method === 'turn/completed' && message.params.turn.id === parentTurnId));
  NodeAssertStrict.equal(NodeFS.readFileSync(NodePath.join(f.scratch, runId + '.audit.ndjson'), 'utf8').trim().split('\n').length, 1);
});

NodeTest.test('honors exact child interruption without interrupting or reinvoking the parent', async (t) => {
  const f = await fixture(t);
  const { runId, native, parentTurnId } = await start(f, 'paused');
  NodeAssertStrict.equal(NodeFS.existsSync(NodePath.join(f.scratch, runId + '.child-completed.json')), false);
  const requestedAt = Date.now();
  f.send({ id: 2, method: 'turn/interrupt', params: { threadId: native.threadId, turnId: native.turnId } });
  await f.wait(() => NodeFS.existsSync(NodePath.join(f.scratch, runId + '.child-cancelled.json')));
  const cancellation = JSON.parse(NodeFS.readFileSync(NodePath.join(f.scratch, runId + '.child-cancelled.json'), 'utf8'));
  NodeAssertStrict.ok(Date.parse(cancellation.at) >= requestedAt);
  NodeAssertStrict.ok(f.received.some(message => message.method === 'turn/completed' && message.params.turn.id === native.turnId && message.params.turn.status === 'interrupted'));
  await f.wait(() => NodeFS.existsSync(NodePath.join(f.scratch, runId + '.after-tool.json')));
  NodeAssertStrict.equal(f.received.some(message => message.method === 'turn/completed' && message.params.turn.id === parentTurnId), false);
  NodeFS.writeFileSync(NodePath.join(f.scratch, runId + '.finish'), 'finish');
  await f.wait(() => f.received.some(message => message.method === 'turn/completed' && message.params.turn.id === parentTurnId && message.params.turn.status === 'completed'));
  NodeAssertStrict.equal(NodeFS.readFileSync(NodePath.join(f.scratch, runId + '.audit.ndjson'), 'utf8').trim().split('\n').length, 1);
});

for (const provider of ['devin', 'codex']) {
  NodeTest.test(provider + ' honors cancellation during the paced capacity fixture burst', async (t) => {
    const f = await fixture(t, provider);
    const runId = NodeCrypto.randomUUID();
    const text = `LIVE_DURABILITY_RUN=${runId}\nLIVE_DURABILITY_LONG_TOOLS=5000\nLIVE_DURABILITY_PAIR_DELAY_MS=1\nLIVE_DURABILITY_CANCEL=honor`;
    const params = provider === 'devin' ? { sessionId: 'owned-session', prompt: [{ type: 'text', text }] } : { threadId: 'owned-parent', input: [{ type: 'text', text }] };
    f.send({ id: 1, method: provider === 'devin' ? 'session/prompt' : 'turn/start', params });
    await f.wait(() => NodeFS.existsSync(NodePath.join(f.scratch, runId + '.prefix.json')));
    NodeFS.writeFileSync(NodePath.join(f.scratch, runId + '.release'), 'release');
    await f.wait(() => NodeFS.existsSync(NodePath.join(f.scratch, runId + '.long-history-progress.json')));
    const requestedAt = Date.now();
    f.send({ id: 2, method: provider === 'devin' ? 'session/cancel' : 'turn/interrupt',
      params: provider === 'devin' ? { sessionId: 'owned-session' } : { threadId: 'owned-parent', turnId: f.received.find(message => message.id === 1).result.turn.id } });
    await f.wait(() => NodeFS.existsSync(NodePath.join(f.scratch, runId + '.cancelled.json')));
    const cancelled = JSON.parse(NodeFS.readFileSync(NodePath.join(f.scratch, runId + '.cancelled.json'), 'utf8'));
    NodeAssertStrict.ok(Date.parse(cancelled.at) >= requestedAt);
    NodeAssertStrict.equal(NodeFS.existsSync(NodePath.join(f.scratch, runId + '.long-history.json')), false);
    NodeAssertStrict.equal(NodeFS.existsSync(NodePath.join(f.scratch, runId + '.expired.json')), false);
    NodeAssertStrict.equal(NodeFS.readFileSync(NodePath.join(f.scratch, runId + '.audit.ndjson'), 'utf8').trim().split('\n').length, 1);
  });
}
