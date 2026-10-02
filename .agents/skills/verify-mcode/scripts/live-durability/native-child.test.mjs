/** Process-only raw Codex fixture checks. These do not connect to Mcode or prove UI behavior. */
import * as NodeTest from 'node:test';
import * as NodeAssertStrict from 'node:assert/strict';
import * as NodeFS from 'node:fs';
import * as NodeOS from 'node:os';
import * as NodePath from 'node:path';
import * as NodeURL from 'node:url';
import * as NodeCrypto from 'node:crypto';
import * as NodeChildProcess from 'node:child_process';
import { continueFinalProvider, finishFinalProvider, start as startProvider, startComposer, waitNative } from './proof.mjs';

async function fixture(t, provider = 'codex', { expireAfterFinal = false, expireDuringFinal = false } = {}) {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'mcode-native-child-'));
  const script = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), 'provider-fixture.mjs');
  const expiryStamp = expireDuringFinal ? '.partial-final.json' : '.after-final.json';
  const bootstrap = `import * as fs from 'node:fs'; const now = Date.now; Date.now = () => now() + (fs.readdirSync(${JSON.stringify(scratch)}).some(file => file.endsWith(${JSON.stringify(expiryStamp)})) ? 180001 : 0); await import(${JSON.stringify(NodeURL.pathToFileURL(script).href)});`;
  const args = expireAfterFinal || expireDuringFinal ? ['--input-type=module', '-e', bootstrap, script, provider, scratch, 'app-server'] : [script, provider, scratch, provider === 'codex' ? 'app-server' : 'acp'];
  const child = NodeChildProcess.spawn(process.execPath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
  return { scratch, received, send, wait, child };
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

function fixtureRun(f) {
  return { id: NodeCrypto.randomUUID(), provider: 'codex', label: 'offline-final', directory: f.scratch, configured: true, thread: { id: 'owned-parent' }, receipt: {}, socket: {
    sendWithoutResponse: async (method, params) => {
      NodeAssertStrict.equal(method, 'agent.send');
      f.send({ id: 1, method: 'turn/start', params: { threadId: params.threadId, input: [{ type: 'text', text: params.content }] } });
    },
    rpc: async (method) => {
      NodeAssertStrict.equal(method, 'agent.listRunning');
      return [{ threadId: 'owned-parent', turnExecutionId: 'offline-execution' }];
    },
  } };
}

async function startPausedFinal(f, { legacyIdenticalText = false } = {}) {
  const run = fixtureRun(f);
  const runId = run.id;
  await startProvider(run, { pauseAfterFinal: true, legacyIdenticalText });
  NodeFS.writeFileSync(NodePath.join(f.scratch, runId + '.release'), 'release');
  const afterFinal = await waitNative(run, 'after-final');
  await f.wait(() => f.received.some(message => message.method === 'item/completed' && message.params.item.id === afterFinal.itemId));
  NodeAssertStrict.equal(afterFinal.turnId, f.received.find(message => message.id === 1).result.turn.id);
  const messages = f.received.filter(message => message.params?.item?.id === afterFinal.itemId || message.params?.itemId === afterFinal.itemId);
  NodeAssertStrict.deepEqual(messages.map(message => message.method), ['item/started', 'item/agentMessage/delta', 'item/completed']);
  NodeAssertStrict.equal(messages[0].params.item.phase, legacyIdenticalText ? undefined : 'final_answer');
  NodeAssertStrict.equal(messages[2].params.item.phase, legacyIdenticalText ? undefined : 'final_answer');
  NodeAssertStrict.deepEqual([Object.hasOwn(messages[0].params.item, 'phase'), Object.hasOwn(messages[2].params.item, 'phase')], legacyIdenticalText ? [false, false] : [true, true]);
  NodeAssertStrict.equal(messages[2].params.item.text, `LIVE_DURABILITY ${runId} ${legacyIdenticalText ? 'IDENTICAL_LEGACY_TEXT' : 'COMPLETE'}`);
  return { run, afterFinal };
}

NodeTest.test('completes the final assistant item while keeping the Codex turn active until its own gate opens', async (t) => {
  const f = await fixture(t);
  const { run, afterFinal } = await startPausedFinal(f);
  NodeFS.writeFileSync(NodePath.join(f.scratch, run.id + '.finish'), 'finish');
  f.send({ id: 2, method: 'model/list', params: {} });
  await f.wait(() => f.received.some(message => message.id === 2));
  NodeAssertStrict.equal(f.received.some(message => message.method === 'turn/completed' && message.params.turn.id === afterFinal.turnId), false);
  NodeAssertStrict.equal(NodeFS.existsSync(NodePath.join(f.scratch, run.id + '.terminal.json')), false);
  NodeAssertStrict.deepEqual(finishFinalProvider(run), { terminalReleased: true });
  NodeAssertStrict.throws(() => finishFinalProvider(run), /already released|already ended/);
  await f.wait(() => f.received.some(message => message.method === 'turn/completed' && message.params.turn.id === afterFinal.turnId));
  const terminal = f.received.filter(message => message.method === 'turn/completed' && message.params.turn.id === afterFinal.turnId);
  NodeAssertStrict.equal(terminal.length, 1);
  NodeAssertStrict.equal(terminal[0].params.turn.status, 'completed');
  NodeAssertStrict.ok(f.received.indexOf(terminal[0]) > f.received.findIndex(message => message.method === 'item/completed' && message.params.item.id === afterFinal.itemId));
  NodeAssertStrict.equal(NodeFS.readFileSync(NodePath.join(f.scratch, run.id + '.audit.ndjson'), 'utf8').trim().split('\n').length, 1);
  f.child.stdin.end();
  await f.wait(() => f.child.exitCode !== null);
  NodeAssertStrict.equal(f.child.exitCode, 0);
});

NodeTest.test('keeps identical completed commentary and a phase-less final item separate before the sole native terminal', async (t) => {
  const f = await fixture(t);
  const { run, afterFinal } = await startPausedFinal(f, { legacyIdenticalText: true });
  const prefix = f.received.find(message => message.method === 'item/completed' && message.params.item.id === `${run.id}-prefix`);
  const final = f.received.find(message => message.method === 'item/completed' && message.params.item.id === `${run.id}-final`);
  NodeAssertStrict.equal(prefix.params.item.phase, 'commentary');
  NodeAssertStrict.notEqual(prefix.params.item.id, final.params.item.id);
  NodeAssertStrict.equal(prefix.params.item.text, `LIVE_DURABILITY ${run.id} IDENTICAL_LEGACY_TEXT`);
  NodeAssertStrict.equal(final.params.item.text, prefix.params.item.text);
  NodeAssertStrict.equal(Object.hasOwn(final.params.item, 'phase'), false);
  NodeAssertStrict.equal(afterFinal.prefixItemId, prefix.params.item.id);
  NodeAssertStrict.equal(afterFinal.itemId, final.params.item.id);
  NodeAssertStrict.equal(afterFinal.textMarker, final.params.item.text);
  const tool = f.received.find(message => message.method === 'item/completed' && message.params.item.id === `${run.id}-tool`);
  NodeAssertStrict.ok(f.received.indexOf(prefix) < f.received.indexOf(tool) && f.received.indexOf(tool) < f.received.indexOf(final));
  NodeAssertStrict.equal(f.received.some(message => message.method === 'turn/completed' && message.params.turn.id === afterFinal.turnId), false);
  NodeAssertStrict.deepEqual(finishFinalProvider(run), { terminalReleased: true });
  await f.wait(() => f.received.some(message => message.method === 'turn/completed' && message.params.turn.id === afterFinal.turnId));
  const terminals = f.received.filter(message => message.method === 'turn/completed' && message.params.turn.id === afterFinal.turnId);
  NodeAssertStrict.equal(terminals.length, 1);
  NodeAssertStrict.equal(terminals[0].params.turn.status, 'completed');
  NodeAssertStrict.ok(f.received.indexOf(final) < f.received.indexOf(terminals[0]));
  f.child.stdin.end();
  await f.wait(() => f.child.exitCode !== null);
  NodeAssertStrict.equal(f.child.exitCode, 0);
});

for (const expired of [false, true]) {
  NodeTest.test(`ends the paused final Codex turn exactly once after ${expired ? 'gate expiry' : 'cancellation'} without retaining a wait`, async (t) => {
    const f = await fixture(t, 'codex', { expireAfterFinal: expired });
    const { run, afterFinal } = await startPausedFinal(f);
    if (!expired) f.send({ id: 2, method: 'turn/interrupt', params: { threadId: 'owned-parent', turnId: afterFinal.turnId } });
    await f.wait(() => f.received.some(message => message.method === 'turn/completed' && message.params.turn.id === afterFinal.turnId) && NodeFS.existsSync(NodePath.join(f.scratch, run.id + '.terminal.json')));
    const terminal = f.received.filter(message => message.method === 'turn/completed' && message.params.turn.id === afterFinal.turnId);
    NodeAssertStrict.equal(terminal.length, 1);
    NodeAssertStrict.equal(terminal[0].params.turn.status, 'interrupted');
    NodeAssertStrict.equal(NodeFS.existsSync(NodePath.join(f.scratch, run.id + '.cancelled.json')), true);
    NodeAssertStrict.equal(NodeFS.existsSync(NodePath.join(f.scratch, run.id + '.expired.json')), expired);
    NodeAssertStrict.throws(() => finishFinalProvider(run), /already ended/);
    f.child.stdin.end();
    await f.wait(() => f.child.exitCode !== null);
    NodeAssertStrict.equal(f.child.exitCode, 0);
  });
}

for (const legacyIdenticalText of [false, true]) {
  NodeTest.test(`Composer proof requires both the exact prompt and the ${legacyIdenticalText ? 'legacy identical' : 'normal'} native prefix`, async (t) => {
    const f = await fixture(t);
    const id = NodeCrypto.randomUUID();
    let prompt;
    let bodyReads = 0;
    const page = {
      getByRole: (role, options) => {
        if (role === 'textbox') {
          NodeAssertStrict.equal(options.name, 'Message Mcode');
          return { fill: async (value) => { prompt = value; } };
        }
        NodeAssertStrict.equal(role, 'button');
        NodeAssertStrict.equal(options.name, 'Send message');
        return { click: async () => f.send({ id: 1, method: 'turn/start', params: { threadId: 'owned-parent', input: [{ type: 'text', text: prompt }] } }) };
      },
      locator: (selector) => {
        NodeAssertStrict.equal(selector, 'body');
        return { innerText: async () => {
          await f.wait(() => f.received.some(message => message.method === 'item/completed' && message.params.item.id === `${id}-prefix`));
          const prefix = f.received.find(message => message.method === 'item/completed' && message.params.item.id === `${id}-prefix`).params.item.text;
          bodyReads++;
          if (bodyReads === 1) return prompt;
          if (bodyReads === 2) return prefix;
          return `${prompt}\n${prefix}`;
        } };
      },
    };
    const run = { id, provider: 'codex', label: 'offline-composer', directory: f.scratch, configured: true, thread: { id: 'owned-parent' }, page,
      receipt: { navigation: { observedThreadId: 'owned-parent' } }, socket: { rpc: async (method) => {
        NodeAssertStrict.equal(method, 'agent.listRunning');
        return [{ threadId: 'owned-parent', turnExecutionId: 'offline-execution' }];
      } } };
    NodeAssertStrict.deepEqual(await startComposer(run, { pauseAfterFinal: true, legacyIdenticalText }), { prefixEmitted: true, threadId: 'owned-parent', runId: id });
    NodeAssertStrict.equal(bodyReads, 3);
    NodeAssertStrict.equal(run.receipt.uiPrecondition.prefixMarker, `LIVE_DURABILITY ${id} ${legacyIdenticalText ? 'IDENTICAL_LEGACY_TEXT' : 'PREFIX'}`);
    NodeAssertStrict.equal(run.receipt.invocation.path, 'composer');
    NodeFS.writeFileSync(NodePath.join(f.scratch, id + '.release'), 'release');
    await waitNative(run, 'after-final');
    finishFinalProvider(run);
    await waitNative(run, 'terminal');
    f.child.stdin.end();
    await f.wait(() => f.child.exitCode !== null);
    NodeAssertStrict.equal(f.child.exitCode, 0);
  });
}

async function startPartialFinal(f) {
  const run = fixtureRun(f);
  await startProvider(run, { pauseDuringFinal: true, pauseAfterFinal: true });
  NodeFS.writeFileSync(NodePath.join(f.scratch, run.id + '.release'), 'release');
  const partial = await waitNative(run, 'partial-final');
  await f.wait(() => f.received.some(message => message.method === 'item/agentMessage/delta' && message.params.itemId === partial.itemId));
  const itemMessages = f.received.filter(message => message.params?.item?.id === partial.itemId || message.params?.itemId === partial.itemId);
  NodeAssertStrict.deepEqual(itemMessages.map(message => message.method), ['item/started', 'item/agentMessage/delta']);
  NodeAssertStrict.equal(itemMessages[0].params.item.phase, 'final_answer');
  NodeAssertStrict.equal(itemMessages[1].params.delta, `LIVE_DURABILITY ${run.id} PARTIAL_FINAL`);
  NodeAssertStrict.equal(partial.textMarker, itemMessages[1].params.delta);
  NodeAssertStrict.equal(partial.fullTextMarker, `LIVE_DURABILITY ${run.id} PARTIAL_FINAL COMPLETE`);
  NodeAssertStrict.equal(partial.itemId, `${run.id}-final`);
  NodeAssertStrict.equal(partial.turnId, f.received.find(message => message.id === 1).result.turn.id);
  return { run, partial };
}

NodeTest.test('continues a partial final item on its own identity before closing the independently held Codex turn', async (t) => {
  const f = await fixture(t);
  const { run, partial } = await startPartialFinal(f);
  NodeAssertStrict.equal(f.received.some(message => message.method === 'turn/completed' && message.params.turn.id === partial.turnId), false);
  NodeAssertStrict.throws(() => finishFinalProvider(run), /No paused native Codex final item/);
  NodeAssertStrict.deepEqual(continueFinalProvider(run), { finalItemReleased: true });
  NodeAssertStrict.throws(() => continueFinalProvider(run), /already released|already ended/);
  const closed = await waitNative(run, 'after-final');
  await f.wait(() => f.received.some(message => message.method === 'item/completed' && message.params.item.id === partial.itemId));
  const itemMessages = f.received.filter(message => message.params?.item?.id === partial.itemId || message.params?.itemId === partial.itemId);
  NodeAssertStrict.deepEqual(itemMessages.map(message => message.method), ['item/started', 'item/agentMessage/delta', 'item/agentMessage/delta', 'item/completed']);
  NodeAssertStrict.deepEqual(itemMessages.slice(1, 3).map(message => message.params.delta), [`LIVE_DURABILITY ${run.id} PARTIAL_FINAL`, ' COMPLETE']);
  NodeAssertStrict.equal(itemMessages[3].params.item.text, partial.fullTextMarker);
  NodeAssertStrict.equal(itemMessages[3].params.item.phase, 'final_answer');
  NodeAssertStrict.equal(closed.itemId, partial.itemId);
  NodeAssertStrict.equal(closed.textMarker, partial.fullTextMarker);
  NodeAssertStrict.equal(f.received.some(message => message.method === 'turn/completed' && message.params.turn.id === partial.turnId), false);
  finishFinalProvider(run);
  await f.wait(() => f.received.some(message => message.method === 'turn/completed' && message.params.turn.id === partial.turnId));
  const terminals = f.received.filter(message => message.method === 'turn/completed' && message.params.turn.id === partial.turnId);
  NodeAssertStrict.equal(terminals.length, 1);
  NodeAssertStrict.equal(terminals[0].params.turn.status, 'completed');
  NodeAssertStrict.ok(f.received.indexOf(terminals[0]) > f.received.indexOf(itemMessages[3]));
  NodeAssertStrict.equal(NodeFS.readFileSync(NodePath.join(f.scratch, run.id + '.audit.ndjson'), 'utf8').trim().split('\n').length, 1);
  f.child.stdin.end();
  await f.wait(() => f.child.exitCode !== null);
  NodeAssertStrict.equal(f.child.exitCode, 0);
});

for (const expired of [false, true]) {
  NodeTest.test(`ends an unfinished final item after ${expired ? 'partial gate expiry' : 'partial cancellation'} without fabricating item completion`, async (t) => {
    const f = await fixture(t, 'codex', { expireDuringFinal: expired });
    const { run, partial } = await startPartialFinal(f);
    if (!expired) f.send({ id: 2, method: 'turn/interrupt', params: { threadId: 'owned-parent', turnId: partial.turnId } });
    await f.wait(() => f.received.some(message => message.method === 'turn/completed' && message.params.turn.id === partial.turnId) && NodeFS.existsSync(NodePath.join(f.scratch, run.id + '.terminal.json')));
    const terminals = f.received.filter(message => message.method === 'turn/completed' && message.params.turn.id === partial.turnId);
    NodeAssertStrict.equal(terminals.length, 1);
    NodeAssertStrict.equal(terminals[0].params.turn.status, 'interrupted');
    NodeAssertStrict.equal(f.received.some(message => message.method === 'item/completed' && message.params.item.id === partial.itemId), false);
    NodeAssertStrict.equal(NodeFS.existsSync(NodePath.join(f.scratch, run.id + '.expired.json')), expired);
    NodeAssertStrict.throws(() => continueFinalProvider(run), /already ended/);
    f.child.stdin.end();
    await f.wait(() => f.child.exitCode !== null);
    NodeAssertStrict.equal(f.child.exitCode, 0);
  });
}

NodeTest.test('rejects legacy partial-final conflicts and stale continuation controls before invoking the provider', async (t) => {
  const f = await fixture(t);
  const conflicting = fixtureRun(f);
  await NodeAssertStrict.rejects(startProvider(conflicting, { pauseDuringFinal: true, legacyIdenticalText: true }), /Partial final fixture cannot use legacy identical text/);
  const stale = fixtureRun(f);
  NodeFS.writeFileSync(NodePath.join(f.scratch, stale.id + '.continue-final'), 'continue');
  await NodeAssertStrict.rejects(startProvider(stale, { pauseDuringFinal: true }), /Stale fixture controls/);
  const invalidId = NodeCrypto.randomUUID();
  f.send({ id: 2, method: 'turn/start', params: { threadId: 'owned-parent', input: [{ type: 'text', text: `LIVE_DURABILITY_RUN=${invalidId}\nLIVE_DURABILITY_DURING_FINAL=pause\nLIVE_DURABILITY_LEGACY_IDENTICAL_TEXT=true` }] } });
  await f.wait(() => f.received.some(message => message.id === 2));
  NodeAssertStrict.equal(f.received.find(message => message.id === 2).error.code, -32602);
  NodeAssertStrict.equal(NodeFS.existsSync(NodePath.join(f.scratch, invalidId + '.prefix.json')), false);
});
